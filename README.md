<p align="center">
  <img src="https://raw.githubusercontent.com/SI-RUI-ZHANG/pi-codex-fast-mode/main/docs/assets/hero.svg" alt="pi-codex-fast-mode — request OpenAI Fast mode, and nothing else" width="800"/>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"/></a>
  <a href="https://www.npmjs.com/package/pi-codex-fast-mode"><img src="https://img.shields.io/npm/v/pi-codex-fast-mode.svg" alt="npm"/></a>
  <img src="https://img.shields.io/badge/pi-0.82.x%20tested-8957e5.svg" alt="pi 0.82.x tested"/>
  <img src="https://img.shields.io/badge/runtime%20deps-0-3fb950.svg" alt="zero runtime dependencies"/>
</p>

# pi-codex-fast-mode

Request OpenAI Fast mode from [pi](https://github.com/earendil-works/pi), with either API-key or ChatGPT subscription access — without changing reasoning effort, response verbosity, prompts, tools, or provider authentication.

Pi has no built-in switch for it, and its maintainers have said service tiers are [too provider-specific for core](https://github.com/earendil-works/pi/issues/4074). This extension makes one narrow payload change:

```diff
  {
    "model": "gpt-6.1-sol",
+   "service_tier": "priority"
  }
```

> **Fast is a paid preference, not a guarantee.** Fast processing increases API charges or ChatGPT subscription usage, depending on access; rates vary. The extension requests Priority on eligible `openai` and legacy `openai-codex` models, regardless of authentication method. OpenAI may reject or downgrade the tier, and this request hook cannot observe which tier actually served the response.
>
> **One global opt-in:** `/fast` and `/fast on` save one preference for newly started chats and workers sharing the Pi agent directory, on either eligible route. Existing runtimes keep their own in-memory state; saving `/fast off` elsewhere does not switch them off. A previously saved **on** preference now also applies to eligible `openai` GPT-6 models after this update. Use `/fast off` before updating if you do not want that expansion. Missing or invalid state remains **off** by default.

## Commands

| Command | What it does |
| --- | --- |
| `/fast` | Toggle Fast mode and save the preference |
| `/fast on` | Explicitly enable Fast mode and save the preference |
| `/fast off` | Explicitly disable Fast mode and save the preference |
| `/fast status` | Report the preference and selected-descriptor eligibility, not backend acceptance |
| `pi --fast` | Enable for one pi process only; never written to disk |

While on with an eligible model descriptor, pi's footer shows `⚡ fast`. If the preference is on but the descriptor is ineligible, it shows `⚡ fast (inactive)` and requests go out unchanged.

## Install

```bash
pi install npm:pi-codex-fast-mode
pi install ~/Dev/pi-codex-fast-mode    # local development
```

Restart pi after installing. Do not install the local path and the npm package at the same time — duplicate discovery registers the command and hook twice.

## What it looks like

On `openai/gpt-6.1-sol`, activation is identical for API-key and ChatGPT subscription access (wrapped here for readability):

```text
❯ /fast on
Fast mode enabled for openai/gpt-6.1-sol.
Fast mode uses higher usage; this extension has no model-specific speed or cost estimate.
Requests ask for service_tier=priority; the backend may downgrade or reject them.
Warning: Fast processing increases API charges or ChatGPT subscription usage, depending on access; rates vary.
Saved /fast preferences apply to newly started chats and workers sharing this agent directory; existing runtimes keep their own state.
```

Every activation warns about both access types and saved scope, even when the current model is ineligible. Status while on repeats those warnings and says backend acceptance is not guaranteed on eligible models. Loading a saved on preference or using `--fast` also produces a warning when UI is available; the flag warning identifies its process-local scope. A failed preference save warns about increased charges/usage while retaining the process-local choice.

Legacy `openai-codex` GPT-5 activation additionally reports a clearly labelled legacy Codex estimate, not a guaranteed current rate. No multiplier is shown on `openai` or GPT-6. Switching to an ineligible model keeps the preference but sends requests unchanged.

## When it activates, and what it costs

The preference must be on, and the selected model must match one of these routes:

- **`openai-codex`:** existing `/^gpt-5\.(4|5|6)(?:$|-)/` families, or exactly `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol`. The legacy provider/id gate is preserved.
- **`openai`:** exactly those four GPT-6 IDs. If exposed, `api` must be `openai-responses` and `baseUrl` must be `https://api.openai.com/v1` (optional trailing slash). An exposed payload `model` must equal the selected ID.

Minimal provider/id descriptors and payloads without a model field remain compatible; missing fields are not evidence of a verified route. Wrong APIs, custom proxy URLs exposed in the new route's descriptor, arbitrary custom provider names, undocumented variants, suffixes, and bare `gpt-6` remain inactive. The extension does not inspect credentials or distinguish API-key from subscription access.

The existing GPT-5 regex still accepts named variants such as `gpt-5.6-sol` on the legacy route. GPT-5 eligibility is **not** expanded to `openai`: the retained legacy rule is not route-specific evidence for that expansion. GPT-6 support uses the exact IDs documented in [Codex speed](https://developers.openai.com/codex/speed) and [Codex models](https://developers.openai.com/codex/models), where available to your account and client. Expanding eligibility requires a source-backed code change and release.

| Legacy `openai-codex` family | Historical speed estimate | Historical credit estimate |
| --- | ---: | ---: |
| GPT-5.4 | about 1.5× | about 2× |
| GPT-5.5 | about 1.5× | about 2.5× |
| GPT-5.6 | about 1.5× | about 2.5× |

These GPT-5 estimates are retained from earlier releases and the [Codex speed documentation](https://developers.openai.com/codex/speed); they are not measurements taken here or guaranteed current billing rates. Current usage depends on model, plan, included limits, and purchased credits. Check OpenAI's current [speed](https://developers.openai.com/codex/speed) and [pricing](https://developers.openai.com/codex/pricing) pages. GPT-6 on either route has no model-specific speed/cost estimate; eligibility does not depend on pricing metadata. API-provider messages never inherit legacy subscription credit multipliers. This package ships no benchmarks; see [CONTRIBUTING.md](./CONTRIBUTING.md) for the reporting bar.

The built-in `openai` route supports API-key access and, in newer Pi versions, direct ChatGPT subscription access. Both intentionally use the same opt-in gate and uniform warning. The [API Fast mode guide](https://developers.openai.com/api/docs/guides/fast-mode) documents Fast/Priority semantics; [Sign in with ChatGPT models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) documents direct Responses inference. These sources do not guarantee every subscription/account accepts Fast; this change enables requesting it, not verified entitlement.

### Why `priority`, not `fast`

The existing wire value is preserved. OpenAI's [API Fast mode guide](https://developers.openai.com/api/docs/guides/fast-mode) documents that `service_tier: "priority"` provides the same behavior as `service_tier: "fast"` for supported models. The Codex client also maps its user-facing Fast configuration to `priority` — see [`ServiceTier::request_value`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs). This requests Fast, **not Ultrafast**, and does not establish which tier the backend serves.

## What it will not do

- Change reasoning effort or `/effort`, response verbosity, prompts, or tools.
- Wrap or replace pi's providers or own their authentication, streaming, catalogs, or accounting.
- Read or modify API keys or OAuth credentials, or choose an authentication method.
- Log prompts, responses, payloads, headers, tokens, or account data.
- Make network calls of its own, spawn subprocesses, or automatically retry with different tiers/access types.
- Claim backend acceptance, guaranteed speed, or verified billing/entitlement.

## Safety model

- **Off by default, with visible paid activation.** Missing, malformed, or future-version state defaults to off. Activation warns about increased API charges/subscription usage and saved scope, including when currently inactive. Saved on preferences are preserved, not silently reset on upgrade.
- **The incoming payload is never mutated.** The hook returns a shallow copy differing by one key, returns the original object if already Priority, and returns nothing when disabled or ineligible.
- **`--fast` cannot become persistent.** The flag applies to one process and is never written to disk; a later explicit `/fast` command can still save a preference.
- **Safe skips and explicit failures.** Invalid payloads leave requests unchanged and warn once. Ineligible descriptors leave requests unchanged. A failed preference write retains the user's process-local choice and warns that it was not saved.
- **Package-owned state.** One preference lives in `<pi-agent-dir>/state/pi-codex-fast-mode.json` (default agent directory `~/.pi/agent`), written through an exclusive temporary file and renamed into place — never by read-modify-write on pi's shared `settings.json`. Windows uses an explicitly non-atomic fallback whose worst case is absent state, which reads as off.

## Routing limitations

Eligibility and the footer refer to Pi's selected model descriptor, not request-scoped dispatch metadata. Exposed API/base-URL fields and payload-model consistency catch visible mismatches only. The hook does **not** verify the effective endpoint, provider implementation, authentication, entitlement, or served tier. Virtual models, same-ID routing, request-local overrides, missing metadata, or a replacement provider with the same descriptor can escape these checks. The legacy route retains its provider/id-only gate. Do not use this extension as an endpoint or billing-policy enforcement boundary.

## Conflicts

Do not run this alongside another extension that registers `/fast` or sets `service_tier`. Pi executes hooks in load order, so whichever runs last decides the value. If this extension finds a different tier already on the payload it replaces it and warns once until the next state-changing command — that makes the collision visible, it does not make the combination safe.

## Compatibility

Developed and live-tested against pi 0.82.1. Requires `@earendil-works/pi-coding-agent >=0.82.0` as a peer, and Node.js 22.19 or newer. It uses the public `before_provider_request`, command/flag registration, and `ctx.model` APIs, not provider internals. Optional `api`/`baseUrl` descriptor checks require no new hook or registry APIs; minimal provider/id descriptors remain supported. Model availability differs by Pi version and account. New-route coverage is local mocked-hook testing, not a live inference or billing acceptance test.

## Development

```bash
npm ci --ignore-scripts
npm run release:check
```

The release check runs Biome formatting/linting, strict TypeScript, unit and integration-style suites, a shipped-dependency audit, and an exact npm tarball allowlist. Runtime code has no third-party dependencies; pi is a host peer. See [docs/design.md](./docs/design.md), [CONTRIBUTING.md](./CONTRIBUTING.md), and [CHANGELOG.md](./CHANGELOG.md).

## Security

Pi extensions run with pi's privileges. Review the source before installing — three runtime files and no dependencies. Filesystem access is limited to its own state file; the provider hook adds one documented field to eligible requests. Report vulnerabilities per [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 Sirui Zhang
