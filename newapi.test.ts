import { describe, expect, test } from "bun:test";
import {
	apiBaseUrl,
	type CatalogModel,
	chooseApi,
	DEFAULT_CONTEXT_WINDOW,
	describeUsage,
	fetchGatewayModels,
	fetchQuotaDisplay,
	fetchTokenUsage,
	findCatalogModel,
	formatQuota,
	maskKey,
	normalizeServerUrl,
	parseConfig,
	parseModelsCache,
	type QuotaDisplay,
	type TokenUsage,
	toModelConfigs,
} from "./newapi";

const USD: QuotaDisplay = { quotaPerUnit: 500_000, displayType: "USD", usdExchangeRate: 7 };

const catalogModel = (overrides: Partial<CatalogModel>): CatalogModel => ({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	provider: "anthropic",
	api: "anthropic-messages",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 200_000,
	maxTokens: 64_000,
	...overrides,
});

const usage = (overrides: Partial<TokenUsage> = {}): TokenUsage => ({
	name: "alice",
	total_granted: 5_000_000,
	total_used: 1_250_000,
	total_available: 3_750_000,
	unlimited_quota: false,
	model_limits_enabled: false,
	model_limits: {},
	expires_at: 0,
	...overrides,
});

function fakeFetch(status: number, body: unknown, seen?: { url?: string; auth?: string | null }): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		if (seen) {
			seen.url = String(input);
			seen.auth = new Headers(init?.headers).get("authorization");
		}
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	}) as typeof fetch;
}

describe("server URL", () => {
	test.each([
		["https://ai.example.com", "https://ai.example.com"],
		["https://ai.example.com/", "https://ai.example.com"],
		["https://ai.example.com/v1", "https://ai.example.com"],
		["https://ai.example.com/v1/", "https://ai.example.com"],
		["ai.example.com", "https://ai.example.com"],
		["  http://10.0.0.5:3000/v1?x=1  ", "http://10.0.0.5:3000"],
		["https://example.com/gateway/v1", "https://example.com/gateway"],
	])("normalizes %s", (input, expected) => {
		expect(normalizeServerUrl(input)).toBe(expected);
	});

	test("rejects empty and non-http URLs", () => {
		expect(() => normalizeServerUrl("  ")).toThrow("server URL");
		expect(() => normalizeServerUrl("ftp://example.com")).toThrow("http or https");
	});

	test("reads the saved URL and ignores bad config", () => {
		expect(parseConfig(JSON.stringify({ serverUrl: "ai.example.com/v1" }))).toEqual({
			serverUrl: "https://ai.example.com",
		});
		expect(parseConfig("{not json")).toEqual({});
		expect(parseConfig(JSON.stringify({ serverUrl: 3 }))).toEqual({});
		expect(parseConfig(undefined)).toEqual({});
	});
});

describe("models cache", () => {
	test("keeps well-formed entries only", () => {
		const cache = parseModelsCache(
			JSON.stringify({ serverUrl: "https://a", fetchedAt: 5, models: [{ id: "x" }, { name: "no id" }, null] }),
		);
		expect(cache).toEqual({ serverUrl: "https://a", fetchedAt: 5, models: [{ id: "x" }] });
	});

	test("treats corrupt or foreign files as missing", () => {
		expect(parseModelsCache("nope")).toBeUndefined();
		expect(parseModelsCache(JSON.stringify({ models: [] }))).toBeUndefined();
	});
});

describe("protocol choice", () => {
	test("prefers Anthropic Messages, then Responses, then Chat Completions", () => {
		expect(chooseApi(["openai", "anthropic"])).toBe("anthropic-messages");
		expect(chooseApi(["openai", "openai-response"])).toBe("openai-responses");
		expect(chooseApi(["openai", "gemini"])).toBe("openai-completions");
	});

	test("assumes Chat Completions when the server does not say", () => {
		expect(chooseApi(undefined)).toBe("openai-completions");
		expect(chooseApi([])).toBe("openai-completions");
	});

	test("skips models without a text endpoint", () => {
		expect(chooseApi(["image-generation"])).toBeUndefined();
		expect(chooseApi(["embeddings"])).toBeUndefined();
		expect(chooseApi(["gemini"])).toBeUndefined();
	});

	test("points each protocol at the right base URL", () => {
		expect(apiBaseUrl("https://a", "anthropic-messages")).toBe("https://a");
		expect(apiBaseUrl("https://a", "openai-responses")).toBe("https://a/v1");
		expect(apiBaseUrl("https://a", "openai-completions")).toBe("https://a/v1");
	});
});

describe("catalog lookup", () => {
	const catalog = [
		catalogModel({ provider: "openrouter", api: "openai-completions", contextWindow: 1 }),
		catalogModel({}),
		catalogModel({ id: "gpt-5", name: "GPT-5", provider: "openai", api: "openai-responses" }),
	];

	test("prefers the first-party provider's entry", () => {
		expect(findCatalogModel("claude-sonnet-4-5", catalog)?.provider).toBe("anthropic");
	});

	test("matches vendor-prefixed ids", () => {
		expect(findCatalogModel("openai/gpt-5", catalog)?.name).toBe("GPT-5");
	});

	test("returns nothing for unknown models", () => {
		expect(findCatalogModel("team-llm", catalog)).toBeUndefined();
	});
});

describe("model definitions", () => {
	const catalog = [catalogModel({ thinkingLevelMap: { high: "high" } })];

	test("maps gateway models to Pi models with catalog metadata and zero cost", () => {
		const models = toModelConfigs(
			"https://a",
			[
				{ id: "team-llm", supported_endpoint_types: ["openai"] },
				{ id: "claude-sonnet-4-5", supported_endpoint_types: ["anthropic", "openai"] },
				{ id: "dall-e-3", supported_endpoint_types: ["image-generation"] },
				{ id: "team-llm", supported_endpoint_types: ["openai"] },
			],
			catalog,
		);
		expect(models.map((model) => model.id)).toEqual(["claude-sonnet-4-5", "team-llm"]);
		expect(models[0]).toMatchObject({
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			baseUrl: "https://a",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200_000,
			maxTokens: 64_000,
			thinkingLevelMap: { high: "high" },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(models[1]).toMatchObject({
			name: "team-llm",
			api: "openai-completions",
			baseUrl: "https://a/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: DEFAULT_CONTEXT_WINDOW,
		});
	});

	test("drops thinking levels that belong to a different protocol", () => {
		const [model] = toModelConfigs("https://a", [{ id: "claude-sonnet-4-5", supported_endpoint_types: ["openai"] }], catalog);
		expect(model?.api).toBe("openai-completions");
		expect(model && "thinkingLevelMap" in model).toBe(false);
	});
});

describe("quota", () => {
	test("formats quota in the server's display unit", () => {
		expect(formatQuota(3_750_000, USD)).toBe("$7.50");
		expect(formatQuota(500_000, { ...USD, displayType: "CNY" })).toBe("¥7.00");
		expect(formatQuota(1234567, { ...USD, displayType: "TOKENS" })).toBe("1,234,567 units");
	});

	test("describes a limited key", () => {
		expect(describeUsage(usage(), USD, "sk-…1234")).toEqual([
			"Key: alice (sk-…1234)",
			"Quota: $7.50 left of $10.00 (used $2.50)",
			"Expires: never",
		]);
	});

	test("describes unlimited, expiring, model-limited keys with an account balance", () => {
		const lines = describeUsage(
			usage({
				name: "",
				unlimited_quota: true,
				expires_at: Date.UTC(2030, 0, 2) / 1000,
				model_limits_enabled: true,
				model_limits: { "gpt-5": true, "claude-sonnet-4-5": true, "o3": false },
				user_quota: { total_available: 1_000_000, total_used: 0 },
			}),
			USD,
			"sk-…1234",
			Date.UTC(2026, 0, 1),
		);
		expect(lines).toEqual([
			"Key: sk-…1234",
			"Quota: unlimited (used $2.50)",
			"Account balance: $2.00",
			"Expires: 2030-01-02",
			"Allowed models: claude-sonnet-4-5, gpt-5",
		]);
	});

	test("flags an expired key", () => {
		const lines = describeUsage(usage({ expires_at: 1 }), USD, "k");
		expect(lines).toContain("Expired: 1970-01-01");
	});

	test("masks keys", () => {
		expect(maskKey("sk-abcdef1234")).toBe("sk-…1234");
		expect(maskKey("abcdef9876")).toBe("sk-…9876");
		expect(maskKey("sk-12")).toBe("sk-****");
	});
});

describe("HTTP", () => {
	test("lists models with the key as a bearer token", async () => {
		const seen: { url?: string; auth?: string | null } = {};
		const models = await fetchGatewayModels("https://a", "sk-k", undefined, fakeFetch(200, { data: [{ id: "m" }, {}] }, seen));
		expect(models).toEqual([{ id: "m" }]);
		expect(seen).toEqual({ url: "https://a/v1/models", auth: "Bearer sk-k" });
	});

	test("reports the server's error message", async () => {
		const fetchImpl = fakeFetch(401, { error: { message: "invalid token" } });
		await expect(fetchGatewayModels("https://a", "bad", undefined, fetchImpl)).rejects.toThrow("/v1/models: invalid token");
	});

	test("explains a non-JSON reply such as a login page", async () => {
		await expect(fetchGatewayModels("https://a", "k", undefined, fakeFetch(200, "<html>"))).rejects.toThrow(
			"non-JSON",
		);
	});

	test("reads the key's usage", async () => {
		const seen: { url?: string } = {};
		const result = await fetchTokenUsage("https://a", "k", undefined, fakeFetch(200, { code: true, data: usage() }, seen));
		expect(result.name).toBe("alice");
		expect(seen.url).toBe("https://a/api/usage/token/");
	});

	test("rejects a usage reply without data", async () => {
		await expect(
			fetchTokenUsage("https://a", "k", undefined, fakeFetch(200, { success: false, message: "disabled" })),
		).rejects.toThrow("disabled");
	});

	test("reads display settings and falls back to New API defaults", async () => {
		const display = await fetchQuotaDisplay(
			"https://a",
			undefined,
			fakeFetch(200, { data: { quota_per_unit: 1000, quota_display_type: "CNY", usd_exchange_rate: 7.2 } }),
		);
		expect(display).toEqual({ quotaPerUnit: 1000, displayType: "CNY", usdExchangeRate: 7.2 });
		expect(await fetchQuotaDisplay("https://a", undefined, fakeFetch(500, "down"))).toEqual({
			quotaPerUnit: 500_000,
			displayType: "USD",
			usdExchangeRate: 1,
		});
	});
});
