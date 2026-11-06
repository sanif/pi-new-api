// Stand-in for a New API server: model list, key quota, and one canned
// streaming reply per protocol. Used by the end-to-end tests.
export const TEST_KEY = "sk-teamkey1234";

const sse = (chunks: string[]) =>
	new Response(chunks.join(""), { headers: { "content-type": "text/event-stream" } });
const event = (type: string, data: Record<string, unknown>) =>
	`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

export const MODELS = [
	{ id: "claude-sonnet-4-5", owned_by: "anthropic", supported_endpoint_types: ["anthropic", "openai"] },
	{ id: "gpt-5", owned_by: "openai", supported_endpoint_types: ["openai", "openai-response"] },
	{ id: "team-llm", owned_by: "custom", supported_endpoint_types: ["openai"] },
	{ id: "dall-e-3", owned_by: "openai", supported_endpoint_types: ["image-generation"] },
];

export const USAGE = {
	object: "token_usage",
	name: "alice",
	total_granted: 5_000_000,
	total_used: 1_250_000,
	total_available: 3_750_000,
	unlimited_quota: false,
	model_limits: {},
	model_limits_enabled: false,
	expires_at: 0,
};

function anthropicStream(model: string): Response {
	return sse([
		event("message_start", {
			message: {
				id: "m1", type: "message", role: "assistant", model, content: [], stop_reason: null,
				usage: { input_tokens: 10, output_tokens: 1 },
			},
		}),
		event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
		event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "PONG-ANTHROPIC" } }),
		event("content_block_stop", { index: 0 }),
		event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
		event("message_stop", {}),
	]);
}

function chatStream(model: string): Response {
	const chunk = (delta: object, finish: string | null, usage?: object) =>
		data({ id: "c1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });
	return sse([
		chunk({ role: "assistant", content: "PONG-CHAT" }, null),
		chunk({}, "stop", { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
		"data: [DONE]\n\n",
	]);
}

function responsesStream(model: string): Response {
	const part = { type: "output_text", text: "PONG-RESPONSES", annotations: [] };
	const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [part] };
	const response = {
		id: "r1", object: "response", status: "completed", model, output: [item],
		usage: {
			input_tokens: 5, output_tokens: 2, total_tokens: 7,
			input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
		},
	};
	const at = { output_index: 0, item_id: "msg_1", content_index: 0 };
	return sse([
		event("response.created", { response: { ...response, status: "in_progress", output: [] } }),
		event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
		event("response.content_part.added", { ...at, part: { ...part, text: "" } }),
		event("response.output_text.delta", { ...at, delta: "PONG-RESPONSES" }),
		event("response.output_text.done", { ...at, text: "PONG-RESPONSES" }),
		event("response.content_part.done", { ...at, part }),
		event("response.output_item.done", { output_index: 0, item }),
		event("response.completed", { response }),
	]);
}

export function startMockServer(port = 0) {
	const requests: string[] = [];
	const server = Bun.serve({
		port,
		async fetch(request) {
			const url = new URL(request.url);
			const apiKey = request.headers.get("x-api-key");
			const auth = request.headers.get("authorization") ?? (apiKey ? `Bearer ${apiKey}` : "");
			requests.push(`${request.method} ${url.pathname}`);
			if (url.pathname === "/api/status") {
				return Response.json({ success: true, data: { quota_per_unit: 500_000, quota_display_type: "USD" } });
			}
			if (auth !== `Bearer ${TEST_KEY}`) return Response.json({ error: { message: "invalid token" } }, { status: 401 });
			if (url.pathname === "/v1/models") return Response.json({ object: "list", data: MODELS });
			if (url.pathname === "/api/usage/token/") return Response.json({ code: true, message: "ok", data: USAGE });
			const body = (await request.json()) as { model: string };
			if (url.pathname === "/v1/messages") return anthropicStream(body.model);
			if (url.pathname === "/v1/chat/completions") return chatStream(body.model);
			if (url.pathname === "/v1/responses") return responsesStream(body.model);
			return new Response("not found", { status: 404 });
		},
	});
	return { server, requests, url: `http://127.0.0.1:${server.port}` };
}

if (import.meta.main) {
	const { url, requests } = startMockServer(Number(process.env.PORT ?? 38123));
	console.log(`mock New API on ${url}`);
	setInterval(() => {
		while (requests.length) console.log(requests.shift());
	}, 200);
}
