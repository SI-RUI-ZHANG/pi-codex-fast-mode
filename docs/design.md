# Design

## Context

OpenAI Codex exposes a user-facing Fast mode that trades higher credit consumption for lower latency. In the current OpenAI Codex implementation, configuration-level `fast` maps to the request value `service_tier: "priority"`.

Pi intentionally keeps provider-specific service-tier policy outside its core abstraction. Its `before_provider_request` extension hook is the narrowest supported integration point: it can transform the final provider payload without re-registering authentication, model catalogs, streaming, or usage parsing.

## Goals

1. Request Codex Fast mode with the smallest possible provider mutation.
2. Make additional credit consumption explicit and opt-in.
3. Keep reasoning effort and response verbosity independent.
4. Scope activation conservatively by provider and model family.
5. Persist only package-owned state, never Pi's shared settings.
6. Fail safely and transparently.
7. Remain auditable and dependency-free at runtime.

## Non-goals

- Providing a generic OpenAI API Priority Processing switch.
- Replacing or wrapping Pi's `openai-codex` provider.
- Optimizing response length by forcing low verbosity.
- Adjusting reasoning effort.
- Measuring or promising a particular latency improvement.
- Claiming that the backend honored a requested tier.
- Supporting arbitrary models before OpenAI documents their Fast-mode eligibility.

## Architecture

The published Pi entry point is `extensions/codex-fast.ts`. It composes two small modules:

- `extensions/core.ts` contains pure eligibility, command parsing, cost metadata, and payload transformation.
- `extensions/state.ts` owns versioned persistence and atomic replacement.

At startup:

1. Load `<agent-dir>/state/pi-codex-fast-mode.json`.
2. Default to off when the file is absent or invalid.
3. Apply the process-local `--fast` override, if present.
4. Render an active or inactive footer indicator.

Before each provider request:

1. Exit without returning a payload when the preference is off.
2. Require provider `openai-codex`.
3. Require a GPT-5.4, GPT-5.5, or GPT-5.6 model ID, or exactly `gpt-6-sol`, `gpt-6-luna`, or `gpt-6-astra`.
4. Require a record-shaped payload.
5. return a shallow copy with `service_tier: "priority"`.

Nested payload values are preserved by reference, and the incoming payload is never mutated. If the payload already requests Priority, it is returned unchanged.

## Why the wire value is `priority`

The official Codex CLI presents `fast` as a user configuration value. Its `ServiceTier::request_value` implementation maps both `fast` and explicit `priority` configuration to `priority` in the provider request. Sending `service_tier: "fast"` would copy the configuration vocabulary rather than the current wire contract.

References:

- [OpenAI Codex speed documentation](https://developers.openai.com/codex/speed)
- [OpenAI Codex `ServiceTier`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs)
- [Pi service-tier discussion](https://github.com/earendil-works/pi/issues/4074)

## Eligibility

The matcher is intentionally provider-scoped and family-based:

```text
provider == openai-codex
model    == /^gpt-5\.(4|5|6)(?:$|-)/ or one of gpt-6-sol, gpt-6-luna, gpt-6-astra
```

The GPT-5 family matcher accepts named variants such as `gpt-5.6-sol`. The GPT-6 allowlist accepts only Sol, Luna, and Astra; bare `gpt-6`, `gpt-6-future`, and unlisted suffixes are not eligible. Adding another variant requires an eligibility and pricing review and a code change.

The `openai` API-key provider is excluded. API Priority Processing has separate billing and operational semantics and should not be enabled implicitly by a ChatGPT Codex extension.

## State and precedence

Persistent state schema:

```json
{
  "version": 1,
  "enabled": false
}
```

Precedence is:

1. `--fast` enables Fast mode for the current process.
2. Otherwise, the saved preference applies.
3. Missing, unreadable, malformed, or unknown-version state defaults to off.

`/fast` toggles, while `/fast on`, `/fast off`, and `/fast status` provide explicit controls. All state-changing forms execute through an in-process command queue so overlapping commands have deterministic state and notifications. Persistence creates an unpredictable temporary file exclusively in the same directory, syncs it, then renames it over the preference on POSIX. Windows receives a fail-safe delete-and-rename fallback because its rename behavior differs when the destination exists; interruption in that non-atomic fallback leaves state absent, which defaults to off.

The file contains no secrets. It is created with mode `0600` where the platform honors POSIX modes.

## Command safety

The primary command is a toggle, with explicit alternatives:

```text
/fast
/fast on | off | status
```

Bare `/fast` toggles and persists the preference. `/fast on` and `/fast off` remain available for idempotent control, while `/fast status` is read-only. Because Fast mode materially increases credit consumption, eligible activation reports the expected credit multiplier (and a speed estimate only where documented); the footer remains visible while the preference is active.

Messages consistently say the extension *requests* Fast mode because the backend can downgrade or reject service-tier requests.

## Conflict behavior

When enabled, this package returns Priority as the tier from its own hook. If the payload already contains another `service_tier`, it is replaced and the user receives one warning per session.

This does not make multiple service-tier extensions safe. The documented rule is to install only one because Pi executes hooks in load order and multiple packages may also register `/fast`.

## Failure behavior

- Missing state: default off silently.
- Invalid or unreadable state: default off and warn in interactive UI.
- Persistence failure: retain the user's choice for the current process and warn that it was not saved.
- Unsupported provider/model: retain the preference but leave requests unchanged and show an inactive status.
- Non-object payload: leave the request unchanged and warn once.
- Existing tier conflict: replace it and warn once.

No failure in this extension should prevent a standard provider request from proceeding.

## Privacy and security

Runtime code:

- accesses only its versioned state file;
- observes the provider/model identity supplied by Pi;
- receives the final payload through Pi's request hook;
- returns a shallow copy containing one service-tier field; and
- performs no network calls of its own.

It never logs or persists payloads, prompts, responses, headers, tokens, OAuth credentials, account identifiers, or session transcripts.

The npm `files` whitelist enumerates the three runtime files plus the public design, changelog, contribution guide, security policy, README, package manifest, and license. A release script compares the dry-run tarball against that exact allowlist. Tests, private planning material, CI configuration, and local tooling are not included.

## Alternatives rejected

### Provider replacement

Re-registering `openai-codex` expands the compatibility and security surface to authentication, streaming, model metadata, and usage accounting. A final-payload hook is sufficient.

### Forcing low verbosity

Shorter output can reduce latency but changes model behavior and is not the Fast-mode service contract. Users control verbosity separately.

### Changing reasoning effort

Reasoning effort changes capability/latency tradeoffs independently of service tier. `/effort` remains untouched.

### Writing Pi's shared `settings.json`

Read-modify-write on a shared file risks clobbering unrelated settings and makes ownership unclear. Package state belongs in a namespaced state file.

### Requiring an explicit `on` argument

Requiring `/fast on` makes paid activation unambiguous, but adds friction to the primary interactive workflow. Bare `/fast` instead toggles the preference, with immediate cost messaging and a persistent footer indicator; the explicit `on`, `off`, and `status` forms remain available.

### Generic model allowlist

An unbounded `openai-codex/*` matcher could send unsupported service tiers. GPT-5 uses a documented family matcher, while GPT-6 uses an exact allowlist so new variants are not opted into higher credit usage implicitly.

## Verification

Automated checks cover:

- provider/model eligibility;
- documented credit multipliers;
- command parsing;
- immutable payload transformation;
- existing-tier behavior;
- missing, valid, malformed, and future-version state;
- secure state-file mode on POSIX;
- persisted command activation and deactivation;
- ordered concurrent commands and persistence failures;
- session-only flag activation;
- model switching and unsupported-model inactivity;
- invalid payload and one-time conflict warnings; and
- exclusive temporary-file creation, replacement, and collision safety.

CI runs Biome, strict TypeScript, Vitest, exact npm tarball allowlist inspection, and a production-dependency audit on supported Node versions, including a Windows job for replacement behavior.

Before publishing a release, manually verify package loading in Pi, `/fast` behavior on supported and unsupported models, a redacted outgoing payload showing `service_tier: "priority"`, and final tarball contents. Never use private prompts or credentials as release evidence.
