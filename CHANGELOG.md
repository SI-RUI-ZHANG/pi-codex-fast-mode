# Changelog

All notable changes to this project will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Fast-mode eligibility for exactly `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, and `gpt-6.1-sol` on both legacy `openai-codex` and built-in `openai` Responses, intentionally supporting API-key and ChatGPT subscription access without auth inspection. Undocumented variants and custom provider names remain inactive.
- Optional exposed `openai` descriptor API/base-URL guards and visible payload-model consistency checks; these do not verify effective dispatch, endpoint, authentication, entitlement, or served tier.
- Increased API-charge/subscription-usage warnings on activation (even when inactive), enabled startup/flag use, status while on, and failed saves while enabling. Saved-scope notices explain newly started chats/workers sharing the agent directory versus existing runtime state.
- Regression coverage for both routes, intentional auth-neutral parity, optional routing guards, immutable Priority payloads/conflicts, and unchanged global preference/state semantics.

### Fixed

- Activation no longer treats missing credit estimates as ineligibility. Eligible GPT-6 models show active descriptor status and request `service_tier: "priority"`, with no invented model-specific speed/cost multipliers. Historical GPT-5 estimates remain labelled and strictly legacy-Codex-scoped; `openai` messages never reuse them.

### Documentation

- Cite Codex speed/models, API Fast mode (`priority`/`fast` equivalence), and direct ChatGPT-plan Responses inference. Remove contradictory API-key exclusions and explain selected-descriptor limitations and unverified subscription Fast acceptance. Legacy GPT-5 eligibility, commands, state schema, off defaults, and wire value are unchanged; this does not enable Ultrafast or broaden GPT-5 to `openai`.
- Warn that existing saved on preferences also cover the newly eligible `openai` models after updating; save off first if this expansion is unwanted. No live new-route inference/billing validation is claimed.

## [0.2.0] — 2026-07-30

### Changed

- Bare `/fast` now toggles and persists Fast mode; `/fast on`, `/fast off`, and `/fast status` remain available as explicit controls.

## [0.1.0] — 2026-07-29

### Added

- Correctness-first Codex Fast-mode request hook for GPT-5.4, GPT-5.5, and GPT-5.6 families.
- Explicit `/fast on | off | status` command and process-local `--fast` flag.
- Versioned, package-owned preference state with safe defaults, exclusive temporary files, atomic POSIX replacement, and a fail-safe Windows fallback.
- Eligible/inactive footer status and transparent speed, credit, conflict, and downgrade messaging.
- Strict TypeScript, Biome, Vitest coverage, Linux/Windows CI, production audit, and exact npm tarball allowlist checks.
- Public architecture, contribution, and security documentation.

### Security

- No runtime dependencies, provider replacement, independent network access, credential access, or request logging.
