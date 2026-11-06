import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "newapi";
export const PROVIDER_NAME = "New API";
export const CONFIG_FILE = "pi-new-api.json";
export const MODELS_CACHE_FILE = "pi-new-api-models.json";
export const KEY_ENV = "NEWAPI_API_KEY";
export const URL_ENV = "NEWAPI_BASE_URL";

// Used when Pi's catalog has no entry for a model the gateway serves.
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
// New API's default `QuotaPerUnit`: 500,000 quota units per US dollar.
export const DEFAULT_QUOTA_PER_UNIT = 500_000;

const REQUEST_TIMEOUT_MS = 15_000;

/** One entry of New API's `GET /v1/models` response. */
export interface GatewayModel {
	id: string;
	owned_by?: string;
	supported_endpoint_types?: string[];
}

export interface ModelsCache {
	serverUrl: string;
	fetchedAt: number;
	models: GatewayModel[];
}

/** Metadata borrowed from Pi's built-in catalog. */
export interface CatalogModel {
	id: string;
	name: string;
	provider: string;
	api: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: unknown;
}

/** `GET /api/usage/token/` payload for the calling key. */
export interface TokenUsage {
	name: string;
	total_granted: number;
	total_used: number;
	total_available: number;
	unlimited_quota: boolean;
	model_limits_enabled: boolean;
	model_limits: Record<string, boolean>;
	expires_at: number;
	user_quota?: { total_available: number; total_used: number };
}

/** The display settings from `GET /api/status`. */
export interface QuotaDisplay {
	quotaPerUnit: number;
	displayType: string;
	usdExchangeRate: number;
}

/**
 * Accepts what people paste: with or without scheme, trailing slashes, or a
 * trailing `/v1`. Returns the server root, e.g. `https://ai.example.com`.
 */
export function normalizeServerUrl(input: string): string {
	let value = input.trim();
	if (!value) throw new Error("Enter the New API server URL");
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Not a valid URL: ${input.trim()}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`Use an http or https URL, not ${url.protocol}`);
	}
	url.search = "";
	url.hash = "";
	const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
	return `${url.origin}${path}`;
}

/** Plain-text config next to the extensions it configures. Bad JSON counts as empty. */
export function parseConfig(text: string | undefined): { serverUrl?: string } {
	if (!text) return {};
	try {
		const value = JSON.parse(text) as unknown;
		if (!value || typeof value !== "object") return {};
		const serverUrl = (value as { serverUrl?: unknown }).serverUrl;
		return typeof serverUrl === "string" && serverUrl.trim() ? { serverUrl: normalizeServerUrl(serverUrl) } : {};
	} catch {
		return {};
	}
}

export function parseModelsCache(text: string | undefined): ModelsCache | undefined {
	if (!text) return undefined;
	try {
		const value = JSON.parse(text) as Partial<ModelsCache>;
		if (typeof value.serverUrl !== "string" || !Array.isArray(value.models)) return undefined;
		return {
			serverUrl: value.serverUrl,
			fetchedAt: typeof value.fetchedAt === "number" ? value.fetchedAt : 0,
			models: value.models.filter(isGatewayModel),
		};
	} catch {
		return undefined;
	}
}

function isGatewayModel(value: unknown): value is GatewayModel {
	return !!value && typeof value === "object" && typeof (value as GatewayModel).id === "string";
}

export type ChatApi = "anthropic-messages" | "openai-responses" | "openai-completions";

/**
 * Picks the protocol Pi should speak for a model. Native Anthropic Messages
 * keeps prompt caching and thinking intact for Claude; Responses is preferred
 * over Chat Completions when the gateway offers it. Models without a text
 * endpoint (images, embeddings, rerank, video) are skipped.
 */
export function chooseApi(endpointTypes: readonly string[] | undefined): ChatApi | undefined {
	const types = endpointTypes && endpointTypes.length > 0 ? endpointTypes : ["openai"];
	if (types.includes("anthropic")) return "anthropic-messages";
	if (types.includes("openai-response")) return "openai-responses";
	if (types.includes("openai")) return "openai-completions";
	return undefined;
}

/** Anthropic's SDK appends `/v1/messages`; the OpenAI APIs expect the `/v1` root. */
export function apiBaseUrl(serverUrl: string, api: ChatApi): string {
	return api === "anthropic-messages" ? serverUrl : `${serverUrl}/v1`;
}

// Providers whose catalog entries describe the upstream model most faithfully.
const PREFERRED_CATALOG_PROVIDERS = ["anthropic", "openai", "google", "deepseek", "xai", "mistral"];

/**
 * Finds the best catalog entry for a gateway model id. Tries the exact id,
 * then the id without a `vendor/` prefix, preferring first-party providers.
 */
export function findCatalogModel(id: string, catalog: readonly CatalogModel[]): CatalogModel | undefined {
	const candidates = [id];
	const slash = id.lastIndexOf("/");
	if (slash >= 0) candidates.push(id.slice(slash + 1));
	for (const candidate of candidates) {
		const matches = catalog.filter((model) => model.id === candidate);
		if (matches.length === 0) continue;
		for (const provider of PREFERRED_CATALOG_PROVIDERS) {
			const match = matches.find((model) => model.provider === provider);
			if (match) return match;
		}
		return matches[0];
	}
	return undefined;
}

/** Turns the gateway's model list into Pi model definitions. */
export function toModelConfigs(
	serverUrl: string,
	models: readonly GatewayModel[],
	catalog: readonly CatalogModel[],
): ProviderModelConfig[] {
	const seen = new Set<string>();
	const configs: ProviderModelConfig[] = [];
	for (const model of models) {
		if (seen.has(model.id)) continue;
		const api = chooseApi(model.supported_endpoint_types);
		if (!api) continue;
		seen.add(model.id);
		const known = findCatalogModel(model.id, catalog);
		configs.push({
			id: model.id,
			name: known?.name ?? model.id,
			api,
			baseUrl: apiBaseUrl(serverUrl, api),
			reasoning: known?.reasoning ?? false,
			// Thinking-level values are protocol specific; only reuse them for the same API.
			...(known?.thinkingLevelMap && known.api === api
				? { thinkingLevelMap: known.thinkingLevelMap as never }
				: {}),
			input: known?.input ?? ["text"],
			// New API bills through its own quota, so Pi does not estimate a cost.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: known?.maxTokens ?? DEFAULT_MAX_TOKENS,
		});
	}
	return configs.sort((a, b) => a.id.localeCompare(b.id));
}

type Fetch = typeof fetch;

async function getJson(
	url: string,
	key: string | undefined,
	signal: AbortSignal | undefined,
	fetchImpl: Fetch,
): Promise<unknown> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetchImpl(url, {
		headers: key ? { Authorization: `Bearer ${key}`, Accept: "application/json" } : { Accept: "application/json" },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	const text = await response.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(`${new URL(url).pathname} returned HTTP ${response.status} with a non-JSON body`);
	}
	if (!response.ok) throw new Error(`${new URL(url).pathname}: ${errorMessage(body) ?? `HTTP ${response.status}`}`);
	return body;
}

function errorMessage(body: unknown): string | undefined {
	if (!body || typeof body !== "object") return undefined;
	const record = body as { message?: unknown; error?: unknown };
	if (typeof record.message === "string" && record.message) return record.message;
	if (record.error && typeof record.error === "object") {
		const message = (record.error as { message?: unknown }).message;
		if (typeof message === "string" && message) return message;
	}
	if (typeof record.error === "string" && record.error) return record.error;
	return undefined;
}

export async function fetchGatewayModels(
	serverUrl: string,
	key: string,
	signal?: AbortSignal,
	fetchImpl: Fetch = fetch,
): Promise<GatewayModel[]> {
	const body = await getJson(`${serverUrl}/v1/models`, key, signal, fetchImpl);
	const data = (body as { data?: unknown }).data;
	if (!Array.isArray(data)) throw new Error("/v1/models did not return a model list");
	return data.filter(isGatewayModel);
}

export async function fetchTokenUsage(
	serverUrl: string,
	key: string,
	signal?: AbortSignal,
	fetchImpl: Fetch = fetch,
): Promise<TokenUsage> {
	const body = (await getJson(`${serverUrl}/api/usage/token/`, key, signal, fetchImpl)) as {
		code?: unknown;
		success?: unknown;
		data?: TokenUsage;
	};
	if (!body.data || (body.code !== true && body.success !== true)) {
		throw new Error(`/api/usage/token/: ${errorMessage(body) ?? "unexpected response"}`);
	}
	return body.data;
}

/** Public server settings. Falls back to New API defaults when unavailable. */
export async function fetchQuotaDisplay(
	serverUrl: string,
	signal?: AbortSignal,
	fetchImpl: Fetch = fetch,
): Promise<QuotaDisplay> {
	const fallback: QuotaDisplay = { quotaPerUnit: DEFAULT_QUOTA_PER_UNIT, displayType: "USD", usdExchangeRate: 1 };
	try {
		const body = (await getJson(`${serverUrl}/api/status`, undefined, signal, fetchImpl)) as {
			data?: { quota_per_unit?: unknown; quota_display_type?: unknown; usd_exchange_rate?: unknown };
		};
		const data = body.data ?? {};
		return {
			quotaPerUnit: positiveNumber(data.quota_per_unit) ?? fallback.quotaPerUnit,
			displayType: typeof data.quota_display_type === "string" ? data.quota_display_type : fallback.displayType,
			usdExchangeRate: positiveNumber(data.usd_exchange_rate) ?? fallback.usdExchangeRate,
		};
	} catch {
		return fallback;
	}
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Formats quota units the way the server's console shows them. */
export function formatQuota(units: number, display: QuotaDisplay): string {
	if (display.displayType === "TOKENS") return `${Math.round(units).toLocaleString("en-US")} units`;
	const usd = units / display.quotaPerUnit;
	if (display.displayType === "CNY") return `¥${(usd * display.usdExchangeRate).toFixed(2)}`;
	return `$${usd.toFixed(2)}`;
}

export function describeUsage(
	usage: TokenUsage,
	display: QuotaDisplay,
	maskedKey: string,
	now = Date.now(),
): string[] {
	const lines = [usage.name ? `Key: ${usage.name} (${maskedKey})` : `Key: ${maskedKey}`];
	if (usage.unlimited_quota) {
		lines.push(`Quota: unlimited (used ${formatQuota(usage.total_used, display)})`);
	} else {
		lines.push(
			`Quota: ${formatQuota(usage.total_available, display)} left of ${formatQuota(usage.total_granted, display)}` +
				` (used ${formatQuota(usage.total_used, display)})`,
		);
	}
	if (usage.user_quota) {
		lines.push(`Account balance: ${formatQuota(usage.user_quota.total_available, display)}`);
	}
	if (usage.expires_at > 0) {
		const expires = usage.expires_at * 1000;
		const date = new Date(expires).toISOString().slice(0, 10);
		lines.push(expires < now ? `Expired: ${date}` : `Expires: ${date}`);
	} else {
		lines.push("Expires: never");
	}
	if (usage.model_limits_enabled) {
		const allowed = Object.keys(usage.model_limits ?? {}).filter((id) => usage.model_limits[id]);
		lines.push(`Allowed models: ${allowed.length > 0 ? allowed.sort().join(", ") : "none"}`);
	}
	return lines;
}

/** Hides all but the last four characters of a key for display. */
export function maskKey(key: string): string {
	const bare = key.startsWith("sk-") ? key.slice(3) : key;
	return bare.length <= 4 ? "sk-****" : `sk-…${bare.slice(-4)}`;
}
