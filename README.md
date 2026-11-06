# pi-new-api

Use a self-hosted [New API](https://github.com/QuantumNous/new-api) gateway from [Pi](https://github.com/earendil-works/pi). One person runs the gateway and connects the upstream providers. Everyone else gets their own key from the New API console and logs in to Pi with it. Usage, quotas, and model access are then managed per person in New API.

```text
/login      → New API: enter the server URL and your key
/model      → pick any model the gateway gives your key
/newapi     → server, key, remaining quota, expiry, allowed models
/newapi refresh → reload the model list
```

## Install

```bash
pi install npm:@sanif/pi-new-api
```

or

```bash
pi install git:github.com/sanif/pi-new-api
```

Restart Pi or run `/reload`.

## Set up the gateway (admin)

1. Deploy New API by following its [deployment guide](https://github.com/QuantumNous/new-api#deployment).
2. In the console, add a **channel** for each upstream provider (OpenAI, Anthropic, Gemini, and others) with that provider's API key.
3. Create one **user** per team member, or one group per team, and set their quota.
4. Each person creates a **token** (API key) on the Tokens page, or you create them and share them privately. Tokens can have their own quota, expiry, model allowlist, and IP allowlist.
5. To let `/newapi` show a person's account balance as well as the key's quota, enable **Allow user quota query** on the token.

> [!IMPORTANT]
> Only connect upstream accounts you are allowed to share. Provider API keys and team or enterprise plans can usually be used this way. Personal subscriptions such as ChatGPT Plus/Pro or Claude Pro/Max are licensed to one person, and routing them to a team breaks their terms and risks the account being suspended. New API's own README asks operators to comply with upstream terms.

## Log in (each team member)

Run `/login`, choose **New API**, and enter:

1. The server URL, for example `https://ai.example.com`. A trailing `/v1` is fine.
2. Your key from the New API console, `sk-...`.

The extension checks the key against the server before saving. The server URL goes to `~/.pi/agent/extensions/pi-new-api.json` and the key to Pi's `~/.pi/agent/auth.json`, like other `/login` providers. Both files are readable only by you. Run `/logout` to remove the key.

Run `/login` again to switch keys. Leave the URL empty to keep the saved server.

### Environment variables

In CI or containers, skip `/login` and set:

```bash
export NEWAPI_BASE_URL=https://ai.example.com
export NEWAPI_API_KEY=sk-...
```

`NEWAPI_BASE_URL` takes precedence over the URL saved by `/login`. A key saved with `/login` takes precedence over `NEWAPI_API_KEY`.

## Models

Models appear in `/model` under the `newapi` provider, for example `newapi/claude-sonnet-4-5`. The list is whatever the server returns for your key, so admins control access from the New API console.

Each model uses the protocol the gateway reports for it:

| Gateway endpoint | Pi protocol | Why |
| --- | --- | --- |
| `anthropic` | Anthropic Messages (`/v1/messages`) | Keeps Claude's prompt caching and thinking |
| `openai-response` | OpenAI Responses (`/v1/responses`) | Reasoning models such as GPT-5 and Codex |
| `openai` | Chat Completions (`/v1/chat/completions`) | Everything else |

Image generation, embeddings, rerank, video, and Gemini-only models are skipped because Pi cannot chat with them through these protocols.

When a model ID matches one in Pi's catalog, its context window, output limit, thinking support, and image input are copied from there. Other models default to a 128K context window, 16K output tokens, text only, and no thinking. To correct a custom model, add a `modelOverrides` entry in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "newapi": {
      "modelOverrides": {
        "team-llm": { "contextWindow": 256000, "reasoning": true, "input": ["text", "image"] }
      }
    }
  }
}
```

Pi shows a cost of `$0.000` for these models because New API bills from its own quota and prices. Use `/newapi` to see what is left.

The model list is saved to `~/.pi/agent/extensions/pi-new-api-models.json` so Pi can start offline. It is reloaded in the background when it is more than six hours old, and whenever you open `/model`. Run `/newapi refresh` to reload it immediately after an admin changes your access.

## Quota

`/newapi` shows:

```text
Server: https://ai.example.com
Key: alice (sk-…1a2b)
Quota: $7.50 left of $10.00 (used $2.50)
Expires: never
Models: 12 available (/newapi refresh reloads the list)
```

Amounts use the server's display setting (USD, CNY, or raw quota units). The account balance appears only when the token allows user quota queries. If the token has a model allowlist, the allowed models are listed too.

## Troubleshooting

- **`/v1/models: invalid token`**: the key is wrong, disabled, or expired. Check it on the Tokens page and run `/login` again.
- **`returned HTTP 200 with a non-JSON body`**: the URL points at a web page, such as a reverse proxy login screen, rather than the New API server.
- **A model is missing**: the key's group or model allowlist excludes it, or it is a non-chat model. Run `/newapi refresh` after changing access.
- **`No models matching "newapi"`** on a fresh machine: Pi could not reach the server at startup. Check the URL and run `/newapi refresh`.

## Development

```bash
bun install
bun run verify   # typecheck, tests, and package dry run
```

The tests include an end-to-end run of the real Pi CLI against a local stand-in for New API (`mock-server.ts`), covering all three protocols. Start it on its own with `bun mock-server.ts` (port 38123, key `sk-teamkey1234`) to try the extension by hand.

## License

MIT
