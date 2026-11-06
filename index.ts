import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ProviderConfig,
	type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
	type CatalogModel,
	CONFIG_FILE,
	describeUsage,
	fetchGatewayModels,
	fetchQuotaDisplay,
	fetchTokenUsage,
	type GatewayModel,
	KEY_ENV,
	maskKey,
	MODELS_CACHE_FILE,
	normalizeServerUrl,
	parseConfig,
	parseModelsCache,
	PROVIDER_ID,
	PROVIDER_NAME,
	toModelConfigs,
	URL_ENV,
} from "./newapi";

type OAuthConfig = NonNullable<ProviderConfig["oauth"]>;
type LoginCallbacks = Parameters<OAuthConfig["login"]>[0];
type Credentials = Awaited<ReturnType<OAuthConfig["login"]>>;
type RefreshContext = Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0];

// Team keys do not expire on Pi's side; New API enforces its own expiry.
const NEVER_EXPIRES = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000;
// The model list is reloaded in the background once it is this old.
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Keeps Pi's startup snappy when the server is slow or unreachable.
const STARTUP_FETCH_TIMEOUT_MS = 5_000;
const SUBCOMMANDS = [
	{ value: "status", label: "status", description: "Show the server, your key, and its remaining quota" },
	{ value: "refresh", label: "refresh", description: "Reload the model list from the server" },
];

function readText(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** Write through a temp file so a crash never leaves half a file behind. */
function writeJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, file);
}

function errorText(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "TimeoutError") return "the server did not respond in time";
		return error.message;
	}
	return String(error);
}

function credentialKey(credential: RefreshContext["credential"]): string | undefined {
	if (credential?.type === "oauth") return typeof credential.access === "string" ? credential.access : undefined;
	if (credential?.type === "api_key") return credential.key ?? credential.env?.[KEY_ENV] ?? process.env[KEY_ENV];
	return process.env[KEY_ENV];
}

function toCatalogModel(model: Model<string>): CatalogModel {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		api: model.api,
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		thinkingLevelMap: model.thinkingLevelMap,
	};
}

/** Pi's bundled catalog, available before any session starts. */
function builtinCatalog(): CatalogModel[] {
	try {
		return getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider).map(toCatalogModel));
	} catch {
		return [];
	}
}

function isOffline(): boolean {
	const value = process.env.PI_OFFLINE;
	return value === "1" || value === "true";
}

export default async function newApi(pi: ExtensionAPI) {
	const extensionsDir = join(getAgentDir(), "extensions");
	const configFile = join(extensionsDir, CONFIG_FILE);
	const cacheFile = join(extensionsDir, MODELS_CACHE_FILE);
	let catalog = builtinCatalog();

	/** `NEWAPI_BASE_URL` wins over the URL saved by `/login`. */
	function serverUrl(): string | undefined {
		const fromEnv = process.env[URL_ENV];
		if (fromEnv?.trim()) {
			try {
				return normalizeServerUrl(fromEnv);
			} catch {
				return undefined;
			}
		}
		return parseConfig(readText(configFile)).serverUrl;
	}

	function readCache(url: string) {
		const cache = parseModelsCache(readText(cacheFile));
		return cache && cache.serverUrl === url ? cache : undefined;
	}

	function cachedGatewayModels(url: string): GatewayModel[] {
		return readCache(url)?.models ?? [];
	}

	function saveModels(url: string, models: GatewayModel[]): ProviderModelConfig[] {
		writeJson(cacheFile, { serverUrl: url, fetchedAt: Date.now(), models });
		return toModelConfigs(url, models, catalog);
	}

	async function refreshModels(context: RefreshContext): Promise<ProviderModelConfig[]> {
		const url = serverUrl();
		if (!url) return [];
		const key = credentialKey(context.credential);
		if (!context.allowNetwork || !key) return toModelConfigs(url, cachedGatewayModels(url), catalog);
		return saveModels(url, await fetchGatewayModels(url, key, context.signal));
	}

	async function login(callbacks: LoginCallbacks): Promise<Credentials> {
		let url = serverUrl();
		if (process.env[URL_ENV]?.trim() && url) {
			callbacks.onProgress?.(`Using ${URL_ENV}: ${url}`);
		} else {
			const answer = await callbacks.onPrompt({
				message: url ? `New API server URL (Enter keeps ${url})` : "New API server URL",
				placeholder: "https://ai.example.com",
				allowEmpty: !!url,
			});
			if (answer.trim()) url = normalizeServerUrl(answer);
		}
		if (!url) throw new Error("A server URL is required");

		const key = (
			await callbacks.onPrompt({
				message: "API key from the New API console (Tokens page)",
				placeholder: "sk-...",
			})
		).trim();
		if (!key) throw new Error("An API key is required");

		callbacks.onProgress?.(`Checking ${maskKey(key)} against ${url}…`);
		const models = await fetchGatewayModels(url, key, callbacks.signal);
		writeJson(configFile, { serverUrl: url });
		saveModels(url, models);
		callbacks.onProgress?.(`Connected. ${models.length} models available.`);
		// Re-register after Pi has stored the credential so the new server URL takes effect.
		setTimeout(register, 0);
		return { access: key, refresh: "", expires: NEVER_EXPIRES };
	}

	function register(): void {
		const url = serverUrl();
		pi.registerProvider(PROVIDER_ID, {
			name: PROVIDER_NAME,
			...(url ? { baseUrl: `${url}/v1` } : {}),
			api: "openai-completions",
			apiKey: `$${KEY_ENV}`,
			models: url ? toModelConfigs(url, cachedGatewayModels(url), catalog) : [],
			refreshModels,
			oauth: {
				name: PROVIDER_NAME,
				isSubscription: false,
				login,
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
			},
		});
	}

	// First run with NEWAPI_* variables and no cache yet: load the list now so
	// `pi --model newapi/...` works without opening the model picker first.
	const startupUrl = serverUrl();
	const envKey = process.env[KEY_ENV]?.trim();
	if (startupUrl && envKey && !readCache(startupUrl) && !isOffline()) {
		try {
			saveModels(startupUrl, await fetchGatewayModels(startupUrl, envKey, AbortSignal.timeout(STARTUP_FETCH_TIMEOUT_MS)));
		} catch {
			// Unreachable server: start without models; /newapi refresh reports the error.
		}
	}
	register();

	/** Reloads an old or missing model list without blocking the session. */
	async function refreshInBackground(ctx: ExtensionContext): Promise<void> {
		const url = serverUrl();
		if (!url || isOffline()) return;
		const cache = readCache(url);
		if (cache && Date.now() - cache.fetchedAt < CACHE_MAX_AGE_MS) return;
		const key = await currentKey(ctx);
		if (!key) return;
		try {
			saveModels(url, await fetchGatewayModels(url, key));
			register();
		} catch {
			// Keep the cached list; /newapi refresh shows why the server failed.
		}
	}

	pi.on("session_start", (_event, ctx) => {
		// The live registry includes catalog updates newer than the bundled one.
		const live = ctx.modelRegistry.getAll().filter((model) => model.provider !== PROVIDER_ID);
		if (live.length > 0) catalog = live.map(toCatalogModel);
		register();
		void refreshInBackground(ctx);
	});

	async function currentKey(ctx: ExtensionContext): Promise<string | undefined> {
		return (await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID)) ?? process.env[KEY_ENV];
	}

	async function status(ctx: ExtensionContext): Promise<void> {
		const url = serverUrl();
		const key = await currentKey(ctx);
		if (!url || !key) {
			ctx.ui.notify(`New API is not set up. Run /login and choose ${PROVIDER_NAME}.`, "warning");
			return;
		}
		const lines = [`Server: ${url}`];
		try {
			const [usage, display] = await Promise.all([
				fetchTokenUsage(url, key, ctx.signal),
				fetchQuotaDisplay(url, ctx.signal),
			]);
			lines.push(...describeUsage(usage, display, maskKey(key)));
		} catch (error) {
			lines.push(`Key: ${maskKey(key)}`, `Quota unavailable: ${errorText(error)}`);
		}
		const models = toModelConfigs(url, cachedGatewayModels(url), catalog).length;
		lines.push(`Models: ${models} available (/newapi refresh reloads the list)`);
		ctx.ui.notify(lines.join("\n"), "info");
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		const url = serverUrl();
		const key = await currentKey(ctx);
		if (!url || !key) {
			ctx.ui.notify(`New API is not set up. Run /login and choose ${PROVIDER_NAME}.`, "warning");
			return;
		}
		try {
			const models = saveModels(url, await fetchGatewayModels(url, key, ctx.signal));
			register();
			const ids = models.map((model) => model.id);
			ctx.ui.notify(
				ids.length > 0
					? `${ids.length} New API models: ${ids.join(", ")}`
					: "The server returned no chat models for this key.",
				ids.length > 0 ? "info" : "warning",
			);
		} catch (error) {
			ctx.ui.notify(`Could not refresh New API models: ${errorText(error)}`, "error");
		}
	}

	pi.registerCommand("newapi", {
		description: "New API gateway: status (quota) or refresh (models)",
		getArgumentCompletions: (prefix) => {
			const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(prefix.trim()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const subcommand = args.trim().toLowerCase() || "status";
			if (subcommand === "status") return status(ctx);
			if (subcommand === "refresh" || subcommand === "models") return refresh(ctx);
			ctx.ui.notify(`Unknown subcommand "${subcommand}". Use /newapi status or /newapi refresh.`, "warning");
		},
	});
}
