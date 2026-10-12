# Design

## Context and goals

OpenAI Fast processing trades higher API charges or ChatGPT subscription usage for lower latency. Pi intentionally keeps service-tier policy outside core. Its `before_provider_request` hook is the narrowest integration: transform one payload field without owning authentication, catalogs, streaming, or accounting.

Goals:

1. Request Fast with the smallest possible provider mutation.
2. Support both API-key and subscription access with one explicit opt-in and clear warnings.
3. Keep reasoning effort, verbosity, prompts, tools, and authentication independent.
4. Scope activation to named providers and documented model IDs.
5. Preserve package-owned state and off-by-default behavior.
6. Remain auditable, dependency-free at runtime, and honest about backend acceptance.

Non-goals include generic OpenAI-compatible proxy support, provider replacement, auth discrimination, guaranteed latency or billing rates, measuring the served tier, and automatic retries/fallbacks.

## Architecture and eligibility

`extensions/codex-fast.ts` composes pure eligibility/command/cost/payload logic in `core.ts` and versioned persistence in `state.ts`. No new extension hook or registry API is required.

At `session_start`, load `<agent-dir>/state/pi-codex-fast-mode.json`, default off for absent/invalid state, apply the process-local `--fast` override, show a cost warning when enabled and UI is available, and update the footer.

Before each provider request:

1. Exit without returning a payload if the preference is off.
2. Check the selected descriptor against the route rules below.
3. Require a record-shaped payload.
4. On `openai`, reject a payload `model` that is exposed but differs from the selected ID.
5. Return a shallow copy with `service_tier: "priority"`, or the original object if already Priority.

Nested values remain the same references; incoming payloads are never mutated. Disabled/ineligible/mismatched requests return nothing from the hook and leave other extensions' tiers alone.

Route rules:

- **Legacy `openai-codex`:** preserve the existing provider/id gate: `/^gpt-5\.(4|5|6)(?:$|-)/` or exactly `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol`.
- **Built-in `openai`:** allow only those four exact GPT-6 IDs. If `api` is exposed, require `openai-responses`; if `baseUrl` is exposed, require `https://api.openai.com/v1` with an optional trailing slash. Wrong APIs, custom proxy URLs exposed in the descriptor, and arbitrary custom provider names are excluded.

These optional fields are ordinary public model-descriptor properties, already present in the 0.82.1 development package; they do not require newer event metadata. Minimal provider/id descriptors and payloads without a model field remain compatible. Missing fields are not proof of a correct route. GPT-5 is not broadened to `openai`: existing Codex family evidence alone does not justify enabling the same family regex on another route. GPT-6 uses exact documented IDs, not a wildcard for variants or snapshots.

### What these checks do not prove

The hook observes Pi's **selected** model, not necessarily its effective request-scoped dispatch. API/base-URL checks reject visible descriptor mismatches; they do not verify the effective endpoint, provider implementation, authentication, or entitlement. Virtual selections, same-ID routing, missing metadata, request-local overrides, or a replacement provider with the same descriptor can escape the checks. The legacy route retains its original provider/id-only gate.

Both API-key and subscription access are intentionally eligible; there is no auth discriminator, registry lookup, token inspection, environment-key heuristic, or credential refresh. Adding such a discriminator would neither serve the approved scope nor establish request-scoped proof. The footer/status describes the preference and descriptor eligibility, **not** backend Fast activation or billing-policy enforcement.

## Evidence and wire value

The existing `service_tier: "priority"` spelling is retained for both routes. OpenAI's API Fast guide documents `priority` as equivalent to `fast` for supported models. The official Codex client maps Fast to Priority too. This is not Ultrafast.

References:

- [Codex speed and Fast eligibility](https://developers.openai.com/codex/speed)
- [Codex model IDs](https://developers.openai.com/codex/models)
- [API Fast mode guide and `priority`/`fast` equivalence](https://developers.openai.com/api/docs/guides/fast-mode)
- [Direct ChatGPT-plan Responses inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Sign in with ChatGPT overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Codex `ServiceTier::request_value`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs)
- [Pi service-tier discussion](https://github.com/earendil-works/pi/issues/4074)

Responses inference support plus API Fast semantics is not a guarantee of Fast acceptance for every subscription account. The extension requests the tier and lets OpenAI enforce availability/entitlement. No live new-route acceptance, billing, or served-tier test is claimed here.

Eligibility and estimates are separate. Historical GPT-5 speed/credit estimates remain strictly scoped to `openai-codex` and are labelled legacy, not guaranteed current rates. `getFastCreditMultiplier` returns `undefined` for GPT-6 and every `openai` model. GPT-6 activation/status has no invented model-specific speed/cost multiplier. API-provider messages never reuse subscription multipliers or Ultrafast figures.

## State and precedence

Persistent schema is unchanged:

```json
{
  "version": 1,
  "enabled": false
}
```

Precedence:

1. `--fast` enables the current process without saving it.
2. Otherwise, the saved preference applies.
3. Missing, unreadable, malformed, or unknown-version state defaults to off.

One saved preference governs both routes for newly started chats and workers sharing the agent directory. Existing runtimes retain their own state until their own command or next `session_start`; there is no file watcher or cross-runtime broadcast. Saving off elsewhere does not disable already-running consumers. Existing saved on preferences are preserved and now cover eligible `openai` GPT-6 descriptors; the README warns users to save off before updating if that expansion is unwanted.

`/fast` toggles, `on`/`off` are idempotent, and `status` is read-only. State-changing commands are serialized in-process so overlapping toggles have deterministic state and notifications. Writes use an unpredictable exclusive temporary file in the same directory, sync, then rename over the preference on POSIX. The Windows delete-and-rename fallback is non-atomic; interruption leaves absent state, which defaults to off. The file contains no secrets and is created with mode `0600` where supported.

## Warnings and command safety

Every successful on command, including one on an ineligible model, warns about **both** increased API charges and ChatGPT subscription usage and the shared saved scope. The current auth method is deliberately not guessed. Eligible messages also describe the requested tier and possible downgrade/rejection. Unknown-estimate messages are uniform on `openai` regardless of access type.

Status while on repeats cost/scope notices without loading/saving state. Enabled startup warns when UI is available, distinguishing saved scope from the process-local `--fast` override. A failed save retains the local choice and warns that persistence failed; enabling still warns about cost. Off clears the footer and stops this runtime's mutations. Headless use has no UI notifications, so flag help and documentation also state the cost tradeoff.

## Conflicts and failures

If enabled on an eligible request, this hook replaces another tier and warns once until the next state-changing command. Multiple service-tier extensions remain unsafe: hook load order decides the final value and commands can collide. Install only one.

- Missing state: default off silently.
- Invalid/unreadable state: default off and warn when UI is available.
- Failed save: keep the process-local choice and warn, without claiming the preference was saved.
- Unsupported descriptor or visible payload-model mismatch: keep the preference but leave the request unchanged.
- Non-object payload: leave unchanged and warn once until the next state-changing command.
- Existing tier conflict: replace immutably with Priority and warn once.

No automatic retry with a different tier, API key, subscription, or provider is performed.

## Privacy and packaging

Runtime code accesses only its own state file, observes public model descriptors, and receives/returns the hook payload. It makes no independent network calls, spawns no subprocesses, and never logs/persists payloads, prompts, responses, headers, tokens, credentials, account IDs, or transcripts.

The npm whitelist ships three runtime files and public documentation/manifest/license. `pack:check` compares the dry-run tarball with the exact allowlist; tests, private plans, CI config, and local tooling are excluded.

## Alternatives rejected

- **Provider replacement:** unnecessary authentication/streaming/catalog/accounting ownership.
- **Low verbosity or reasoning changes:** independent model-behavior controls, not service tiers.
- **Shared Pi settings writes:** risk unrelated settings; namespaced package state has clear ownership.
- **Auth-only subscription gating:** superseded by explicit approval of both access types; would add unreliable auth snapshot checks and credential access risk.
- **Unbounded provider/model matching:** custom names and future variants have no eligibility evidence.
- **Broaden GPT-5 on `openai`:** defer until route-specific model eligibility is source-backed.
- **Require new request metadata:** unavailable across the existing peer range and unnecessary for the approved auth-neutral preference; document selected-descriptor limitations instead.
- **Require `/fast on` only:** bare toggle is retained with immediate cost/scope warnings and explicit on/off alternatives.

## Verification

Automated coverage includes exact GPT-6 IDs on both routes; legacy GPT-5 eligibility/estimates; wrong providers, variants, APIs, proxy descriptors, and payload-model mismatches; minimal descriptors; intentional API-key/subscription parity without auth lookup; immutable payloads and existing-tier behavior; enabled/off commands and read-only status; shared preference versus existing runtime state; flag/persistence-failure warnings; and unchanged state schema/defaults, concurrent commands, POSIX modes, temporary-file collision safety, and replacement behavior.

`release:check` runs Biome, strict TypeScript, Vitest, a shipped-dependency audit, and the exact npm pack allowlist. Before publishing, manually verify package loading, supported/unsupported models, redacted outgoing Priority payloads, and final tarball contents. Any live new-route acceptance evidence must report terminal success and actual served tier where observable, not just an HTTP 200 or initial streaming bytes. Never use private prompts or credentials as release evidence.
