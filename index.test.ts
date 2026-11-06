import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import newApi from "./index";
import { startMockServer, TEST_KEY } from "./mock-server";

type Handler = (args: string, ctx: unknown) => Promise<void>;
type LoginCallbacks = Parameters<NonNullable<ProviderConfig["oauth"]>["login"]>[0];

let mock: ReturnType<typeof startMockServer>;
let agentDir: string;
const savedEnv = { ...process.env };

beforeAll(() => {
	mock = startMockServer();
});

afterAll(() => {
	mock.server.stop(true);
});

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-new-api-unit-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.NEWAPI_BASE_URL;
	delete process.env.NEWAPI_API_KEY;
	delete process.env.PI_OFFLINE;
});

afterEach(() => {
	process.env = { ...savedEnv };
	rmSync(agentDir, { recursive: true, force: true });
});

/** Loads the extension against a fake Pi that records what it registers. */
async function load() {
	const providers: ProviderConfig[] = [];
	const commands = new Map<string, Handler>();
	const events = new Map<string, (event: unknown, ctx: unknown) => void>();
	const fake = {
		registerProvider: (_id: string, config: ProviderConfig) => providers.push(config),
		registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options.handler),
		on: (name: string, handler: (event: unknown, ctx: unknown) => void) => events.set(name, handler),
	};
	await newApi(fake as unknown as ExtensionAPI);
	return { providers, commands, events, latest: () => providers.at(-1) as ProviderConfig };
}

function callbacks(answers: string[], progress: string[] = []): LoginCallbacks {
	return {
		onAuth: () => {},
		onDeviceCode: () => {},
		onPrompt: async () => answers.shift() ?? "",
		onProgress: (message: string) => progress.push(message),
		onSelect: async () => undefined,
	};
}

function context(key: string | undefined) {
	const notes: Array<{ message: string; type?: string }> = [];
	return {
		notes,
		ctx: {
			ui: { notify: (message: string, type?: string) => notes.push({ message, type }) },
			modelRegistry: { getApiKeyForProvider: async () => key, getAll: () => [] },
			signal: undefined,
		},
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("registration", () => {
	test("offers /login even before anything is configured", async () => {
		const { latest, commands } = await load();
		expect(latest().name).toBe("New API");
		expect(latest().models).toEqual([]);
		expect(latest().baseUrl).toBeUndefined();
		expect(latest().oauth?.name).toBe("New API");
		expect(latest().oauth?.isSubscription).toBe(false);
		expect(commands.has("newapi")).toBe(true);
	});

	test("does not contact the server at startup when offline", async () => {
		process.env.NEWAPI_BASE_URL = mock.url;
		process.env.NEWAPI_API_KEY = TEST_KEY;
		process.env.PI_OFFLINE = "1";
		mock.requests.length = 0;
		const { latest } = await load();
		expect(latest().models).toEqual([]);
		expect(mock.requests).toEqual([]);
	});

	test("starts without models when the server is unreachable", async () => {
		process.env.NEWAPI_BASE_URL = "http://127.0.0.1:9";
		process.env.NEWAPI_API_KEY = TEST_KEY;
		const { latest } = await load();
		expect(latest().baseUrl).toBe("http://127.0.0.1:9/v1");
		expect(latest().models).toEqual([]);
	});
});

describe("/login", () => {
	test("checks the key, saves the server, caches models, and stores the key as the credential", async () => {
		const { latest } = await load();
		const progress: string[] = [];
		const credentials = await latest().oauth!.login(callbacks([`${mock.url}/v1/`, ` ${TEST_KEY} `], progress));

		expect(credentials.access).toBe(TEST_KEY);
		expect(credentials.expires).toBeGreaterThan(Date.now() + 365 * 24 * 60 * 60 * 1000);
		expect(latest().oauth!.getApiKey(credentials)).toBe(TEST_KEY);
		expect(progress.at(-1)).toBe("Connected. 4 models available.");

		const configFile = join(agentDir, "extensions", "pi-new-api.json");
		expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({ serverUrl: mock.url });
		expect(statSync(configFile).mode & 0o777).toBe(0o600);

		await tick();
		expect(latest().baseUrl).toBe(`${mock.url}/v1`);
		expect(latest().models?.map((model) => model.id)).toEqual(["claude-sonnet-4-5", "gpt-5", "team-llm"]);
	});

	test("keeps the saved server when the URL prompt is left empty", async () => {
		const first = await load();
		await first.latest().oauth!.login(callbacks([mock.url, TEST_KEY]));
		const second = await load();
		const credentials = await second.latest().oauth!.login(callbacks(["", TEST_KEY]));
		expect(credentials.access).toBe(TEST_KEY);
	});

	test("skips the URL prompt when NEWAPI_BASE_URL is set", async () => {
		process.env.NEWAPI_BASE_URL = mock.url;
		const { latest } = await load();
		const prompts: string[] = [];
		const cb = callbacks([TEST_KEY]);
		const original = cb.onPrompt;
		cb.onPrompt = async (prompt) => {
			prompts.push(prompt.message);
			return original(prompt);
		};
		await latest().oauth!.login(cb);
		expect(prompts).toEqual(["API key from the New API console (Tokens page)"]);
	});

	test("rejects a key the server refuses and saves nothing", async () => {
		const { latest } = await load();
		await expect(latest().oauth!.login(callbacks([mock.url, "sk-wrong"]))).rejects.toThrow("invalid token");
		expect(existsSync(join(agentDir, "extensions", "pi-new-api.json"))).toBe(false);
	});

	test("requires a URL and a key", async () => {
		const { latest } = await load();
		await expect(latest().oauth!.login(callbacks(["", ""]))).rejects.toThrow("server URL");
		await expect(latest().oauth!.login(callbacks([mock.url, "  "]))).rejects.toThrow("API key is required");
	});
});

describe("model refresh", () => {
	test("uses the stored credential and falls back to the cache offline", async () => {
		process.env.NEWAPI_BASE_URL = mock.url;
		const { latest } = await load();
		const refresh = latest().refreshModels!;
		const base = { signal: new AbortController().signal, publish: async () => true };

		const live = await refresh({ ...base, allowNetwork: true, credential: { type: "oauth", access: TEST_KEY, refresh: "", expires: 0 } });
		expect(live.map((model) => model.id)).toEqual(["claude-sonnet-4-5", "gpt-5", "team-llm"]);

		mock.requests.length = 0;
		const cached = await refresh({ ...base, allowNetwork: false, credential: { type: "api_key", key: TEST_KEY } });
		expect(cached).toHaveLength(3);
		expect(mock.requests).toEqual([]);
	});
});

describe("/newapi", () => {
	test("shows the server, key, and quota", async () => {
		process.env.NEWAPI_BASE_URL = mock.url;
		process.env.NEWAPI_API_KEY = TEST_KEY;
		const { commands } = await load();
		const { ctx, notes } = context(TEST_KEY);
		await commands.get("newapi")!("", ctx);
		expect(notes).toEqual([
			{
				message: [
					`Server: ${mock.url}`,
					"Key: alice (sk-…1234)",
					"Quota: $7.50 left of $10.00 (used $2.50)",
					"Expires: never",
					"Models: 3 available (/newapi refresh reloads the list)",
				].join("\n"),
				type: "info",
			},
		]);
	});

	test("still shows the server when the quota lookup fails", async () => {
		process.env.NEWAPI_BASE_URL = mock.url;
		const { commands } = await load();
		const { ctx, notes } = context("sk-wrong9999");
		await commands.get("newapi")!("status", ctx);
		expect(notes[0]?.message).toContain("Key: sk-…9999\nQuota unavailable: /api/usage/token/: invalid token");
	});

	test("refresh reloads and re-registers the model list", async () => {
		process.env.NEWAPI_BASE_URL = mock.url;
		const { commands, providers } = await load();
		const before = providers.length;
		const { ctx, notes } = context(TEST_KEY);
		await commands.get("newapi")!("refresh", ctx);
		expect(notes[0]).toEqual({ message: "3 New API models: claude-sonnet-4-5, gpt-5, team-llm", type: "info" });
		expect(providers.length).toBe(before + 1);
	});

	test("points to /login when nothing is configured", async () => {
		const { commands } = await load();
		const { ctx, notes } = context(undefined);
		await commands.get("newapi")!("refresh", ctx);
		expect(notes[0]).toEqual({ message: "New API is not set up. Run /login and choose New API.", type: "warning" });
	});

	test("rejects unknown subcommands", async () => {
		const { commands } = await load();
		const { ctx, notes } = context(TEST_KEY);
		await commands.get("newapi")!("bogus", ctx);
		expect(notes[0]?.type).toBe("warning");
	});
});
