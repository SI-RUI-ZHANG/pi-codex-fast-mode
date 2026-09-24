<p align="center">
  <img src="https://raw.githubusercontent.com/SI-RUI-ZHANG/pi-codex-fast-mode/main/docs/assets/hero.svg" alt="pi-codex-fast-mode — request Codex Fast mode, and nothing else" width="800"/>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"/></a>
  <a href="https://www.npmjs.com/package/pi-codex-fast-mode"><img src="https://img.shields.io/npm/v/pi-codex-fast-mode.svg" alt="npm"/></a>
  <img src="https://img.shields.io/badge/pi-0.82.x%20tested-8957e5.svg" alt="pi 0.82.x tested"/>
  <img src="https://img.shields.io/badge/runtime%20deps-0-3fb950.svg" alt="zero runtime dependencies"/>
</p>

# pi-codex-fast-mode

Request OpenAI Codex Fast mode from [pi](https://github.com/earendil-works/pi) — without changing reasoning effort, response verbosity, prompts, tools, or provider authentication.

Codex sells a faster processing tier at a higher credit rate. pi has no built-in switch for it, and its maintainers have said service tiers are [too provider-specific for core](https://github.com/earendil-works/pi/issues/4074) — an extension is the intended answer. Several already exist. This one is deliberately the narrowest of them:

```diff
  {
    "model": "gpt-5.6-sol",
+   "service_tier": "priority"
  }
```

That diff is the entire product. Everything below is about handling it carefully — because the field roughly doubles your credit burn, and the backend is free to ignore it.

> **Fast is a paid preference, not a guarantee.** The extension asks the Codex backend for Priority processing. OpenAI may reject or downgrade the requested tier, and a request hook cannot observe which tier actually served the response.

## Commands

| Command | What it does |
| --- | --- |
| `/fast` | Toggle Fast mode and save the preference |
| `/fast on` | Explicitly enable Fast mode and save the preference |
| `/fast off` | Explicitly disable Fast mode and save the preference |
| `/fast status` | Report the preference and whether it is active on this model |
| `pi --fast` | Enable for one pi process only; never written to disk |

While active on an eligible model, pi's footer shows `⚡ fast`. If the preference is on but the selected model is not eligible, it shows `⚡ fast (inactive)` and requests go out unchanged.

## Install

```bash
pi install npm:pi-codex-fast-mode
pi install ~/Dev/pi-codex-fast-mode    # local development
```

Restart pi after installing or changing the package entry. Install either the local path or the npm package, not both — duplicate discovery registers the command and hook twice.

## What it looks like

The exact text the extension emits, on `openai-codex/gpt-5.6-sol`:

```text
❯ /fast status
Fast mode is off. This extension is not modifying provider requests.

❯ /fast
Fast mode enabled for openai-codex/gpt-5.6-sol: ~1.5× speed and ~2.5× credits.
Requests ask for service_tier=priority; the backend may downgrade them.

❯ /fast
Fast mode disabled. This extension no longer modifies provider requests.
```

Switch to a model outside the eligible families and the preference survives, but nothing is sent:

```text
❯ /fast status
Fast preference is on, but openai-codex/gpt-5.3-codex-spark is not eligible; requests are unchanged.
```

## When it activates, and what it costs

Both conditions must hold:

```text
provider == openai-codex
model    == /^gpt-5\.(4|5|6)(?:$|-)/ or one of gpt-6-sol, gpt-6-luna, gpt-6-astra
```

The GPT-5 matcher accepts bare IDs and named variants such as `gpt-5.6-sol`. GPT-6 eligibility is an exact allowlist for `gpt-6-sol`, `gpt-6-luna`, and `gpt-6-astra`; bare `gpt-6`, `gpt-6-future`, and other unlisted variants are excluded. This fork adds support for Sol, Luna, and Astra pending an upstream update.

| Model family | Expected speed | Credit usage |
| --- | ---: | ---: |
| GPT-5.4 | about 1.5× | about 2× |
| GPT-5.5 | about 1.5× | about 2.5× |
| GPT-5.6 | about 1.5× | about 2.5× |
| GPT-6 Sol, Luna, and Astra | not specified | about 2.5× |

These are OpenAI's published figures from the [Codex speed documentation](https://developers.openai.com/codex/speed), not measurements taken here, and they can change. New GPT-6 variants require an explicit eligibility and pricing review before support is added. The GPT-6 enable notification omits a numeric speed claim. This package ships no benchmarks of its own; if you run one, see the reporting bar in [CONTRIBUTING.md](./CONTRIBUTING.md).

pi's separate API-key `openai` provider is intentionally excluded. Its Priority Processing has different billing and operational semantics, and should not be switched on implicitly by a ChatGPT Codex extension.

<details>
<summary>Why the wire value is <code>priority</code> and not <code>fast</code></summary>

<br/>

OpenAI's user-facing Codex configuration calls this tier `fast`. The Codex client maps both `fast` and an explicit `priority` config to `priority` on the wire — see [`ServiceTier::request_value`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs). Sending `service_tier: "fast"` would copy the configuration vocabulary rather than the actual request contract.

</details>

## What it will not do

- Change reasoning effort or `/effort` — an independent control, and conflating the two would make `/fast off` misleading.
- Change `text.verbosity`. Shorter output is faster, but it is not what Fast mode means.
- Wrap or replace pi's `openai-codex` provider. Replacing it would mean owning authentication, streaming, model catalogs, and usage accounting.
- Read or modify OAuth credentials.
- Log prompts, responses, request payloads, or headers — in any mode.
- Make network calls of its own, or spawn subprocesses.
- Claim the backend honored the tier it asked for.

## Safety model

- **Off by default, with visible paid activation.** Missing, malformed, or future-version state defaults to off. Toggling on immediately reports the expected credit multiplier and adds the footer indicator.
- **The incoming payload is never mutated.** The hook returns a shallow copy differing by one key, and returns nothing at all when disabled or ineligible.
- **`--fast` cannot become persistent.** It applies to one process and is never written to disk.
- **No failure here blocks a request.** An unusable payload, a failed write, or an ineligible model degrades to leaving the request alone, plus a one-time warning.
- **Package-owned state.** The preference lives in `<pi-agent-dir>/state/pi-codex-fast-mode.json` (default `~/.pi/agent`), written through an exclusive temporary file and renamed into place — never by read-modify-write on pi's shared `settings.json`. Windows uses a documented, explicitly non-atomic fallback whose worst case is absent state, which reads as off.

## Conflicts

Do not run this alongside another extension that registers `/fast` or sets `service_tier`. pi executes provider hooks in load order, so whichever runs last decides the value. If this extension finds a different tier already on the payload it replaces it and warns once per session — that makes the collision visible, it does not make the combination safe.

## Compatibility

Developed and live-tested against pi 0.82.1. Requires `@earendil-works/pi-coding-agent >=0.82.0` as a peer, and Node.js 22.19 or newer. It depends only on the public extension API — `before_provider_request`, command and flag registration, and `ctx.model` — not on provider internals.

## Development

```bash
npm ci --ignore-scripts
npm run release:check
```

The release check runs formatting and linting, strict TypeScript, the unit and integration-style suites, a shipped-dependency audit, and an exact npm tarball allowlist. Runtime code has no third-party dependencies; pi is supplied as a peer.

The architecture and the reasoning behind each decision — including the alternatives that were rejected — are in [docs/design.md](./docs/design.md). Contribution rules are in [CONTRIBUTING.md](./CONTRIBUTING.md), and release history in [CHANGELOG.md](./CHANGELOG.md).

## Security

pi extensions run with pi's privileges. Review the source before installing — that is three runtime files and no dependencies. This package's filesystem access is limited to its own state file, and its provider hook adds one documented field to eligible requests.

Report vulnerabilities per [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 Sirui Zhang
