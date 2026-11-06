import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockServer, TEST_KEY } from "./mock-server";

// Runs the real Pi CLI against an in-process stand-in for a New API server.
const pi = join(import.meta.dir, "node_modules", ".bin", "pi");
const extension = join(import.meta.dir, "index.ts");
let mock: ReturnType<typeof startMockServer>;
let home: string;

beforeAll(() => {
	mock = startMockServer();
	home = mkdtempSync(join(tmpdir(), "pi-new-api-e2e-"));
});

afterAll(() => {
	mock?.server.stop(true);
	rmSync(home, { recursive: true, force: true });
});

function agentDir(): string {
	return join(home, ".pi", "agent");
}

/** Pi in print mode reads stdin when it is a pipe, so stdin is closed here. */
function runPi(args: string[], env: Record<string, string> = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(pi, ["--no-extensions", "-e", extension, "--no-session", ...args], {
			cwd: home,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				HOME: home,
				PI_CODING_AGENT_DIR: agentDir(),
				NEWAPI_BASE_URL: `${mock.url}/v1/`,
				NEWAPI_API_KEY: TEST_KEY,
				...env,
			},
		});
		let output = "";
		child.stdout.on("data", (chunk) => (output += String(chunk)));
		child.stderr.on("data", (chunk) => (output += String(chunk)));
		const timer = setTimeout(() => child.kill(), 25_000);
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(output);
			else reject(new Error(`pi ${args.join(" ")} exited with ${code}: ${output}`));
		});
	});
}

describe("Pi with a New API server", () => {
	test("loads the gateway's chat models on first start and skips image-only ones", async () => {
		const output = await runPi(["--list-models", "newapi"]);
		expect(output).toContain("claude-sonnet-4-5");
		expect(output).toContain("gpt-5");
		expect(output).toContain("team-llm");
		expect(output).not.toContain("dall-e-3");
		const cache = JSON.parse(readFileSync(join(agentDir(), "extensions", "pi-new-api-models.json"), "utf8"));
		expect(cache.serverUrl).toBe(mock.url);
		expect(cache.models).toHaveLength(4);
	}, 30_000);

	test("borrows context windows and thinking support from Pi's catalog", async () => {
		const output = await runPi(["--list-models", "newapi"]);
		expect(output).toMatch(/claude-sonnet-4-5\s+200K\s+64K\s+yes\s+yes/);
		expect(output).toMatch(/team-llm\s+128K\s+16\.4K\s+no\s+no/);
	}, 30_000);

	test.each([
		["claude-sonnet-4-5", "PONG-ANTHROPIC", "POST /v1/messages"],
		["gpt-5", "PONG-RESPONSES", "POST /v1/responses"],
		["team-llm", "PONG-CHAT", "POST /v1/chat/completions"],
	])("chats with %s over its native protocol", async (model, reply, route) => {
		mock.requests.length = 0;
		const output = await runPi(["-p", "--model", `newapi/${model}`, "Reply with pong"]);
		expect(output).toContain(reply);
		expect(mock.requests).toContain(route);
	}, 30_000);

	test("uses the server saved by /login when no environment URL is set", async () => {
		const extensionsDir = join(agentDir(), "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(join(extensionsDir, "pi-new-api.json"), JSON.stringify({ serverUrl: mock.url }));
		const output = await runPi(["-p", "--model", "newapi/team-llm", "Reply with pong"], { NEWAPI_BASE_URL: "" });
		expect(output).toContain("PONG-CHAT");
	}, 30_000);
});
