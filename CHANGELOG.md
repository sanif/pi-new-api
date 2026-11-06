# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `newapi` provider for a self-hosted [New API](https://github.com/QuantumNous/new-api) gateway.
- `/login` → **New API** asks for the server URL and a key from the New API console, checks the key, and saves both.
- Models come from the server's model list: Claude models use Anthropic Messages, models that offer it use OpenAI Responses, and the rest use Chat Completions. Image, embedding, and other non-chat models are skipped.
- Context window, output limit, thinking support, and image input are taken from Pi's catalog when the model ID matches one Pi knows.
- The model list is cached for offline starts and reloaded in the background once it is six hours old.
- `/newapi` shows the server, your key, its remaining quota, expiry, and allowed models; `/newapi refresh` reloads the model list.
- `NEWAPI_BASE_URL` and `NEWAPI_API_KEY` environment variables as an alternative to `/login`.
