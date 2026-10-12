import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { type CodexFastModeDependencies, registerCodexFastMode } from "../extensions/codex-fast.ts";
import { FAST_STATE_VERSION, loadFastState, saveFastState } from "../extensions/state.ts";

type EventHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown;

interface CapturedCommand {
	handler: CommandHandler;
}

interface Harness {
	agentDir: string;
	command: CapturedCommand;
	context: ExtensionContext;
	emit: (name: string, event: Record<string, unknown>) => Promise<unknown>;
	notifications: Array<{ message: string; level: string }>;
	statuses: Map<string, string | undefined>;
}

const temporaryDirectories: string[] = [];

interface HarnessOptions {
	agentDir?: string;
	api?: string;
	baseUrl?: string;
	fastFlag?: boolean;
	modelId?: string;
	provider?: string;
	loadState?: CodexFastModeDependencies["loadState"];
	saveState?: CodexFastModeDependencies["saveState"];
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const agentDir = options.agentDir ?? (await mkdtemp(join(tmpdir(), "pi-codex-fast-extension-")));
	if (!options.agentDir) temporaryDirectories.push(agentDir);

	const handlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, CapturedCommand>();
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string | undefined>();

	const api = {
		on(name: string, handler: EventHandler) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		registerCommand(name: string, command: CapturedCommand) {
			commands.set(name, command);
		},
		registerFlag() {},
		getFlag(name: string) {
			return name === "fast" ? (options.fastFlag ?? false) : undefined;
		},
	} as unknown as ExtensionAPI;

	const context = {
		mode: "tui",
		hasUI: true,
		model: {
			provider: options.provider ?? "openai-codex",
			id: options.modelId ?? "gpt-5.6-sol",
			...(options.api !== undefined ? { api: options.api } : {}),
			...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
		},
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
		},
	} as unknown as ExtensionContext;

	registerCodexFastMode(api, {
		getAgentDir: () => agentDir,
		...(options.loadState ? { loadState: options.loadState } : {}),
		...(options.saveState ? { saveState: options.saveState } : {}),
	});

	async function emit(name: string, event: Record<string, unknown>): Promise<unknown> {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) {
			const next = await handler(event, context);
			if (next !== undefined) result = next;
		}
		return result;
	}

	const command = commands.get("fast");
	if (!command) throw new Error("Fast command was not registered");

	return { agentDir, command, context, emit, notifications, statuses };
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Codex Fast mode extension", () => {
	it.each(
		["openai-codex", "openai"].flatMap((provider) =>
			["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"].map((modelId) => ({
				provider,
				modelId,
			})),
		),
	)(
		"enables $provider/$modelId with honest unknown estimates and read-only status",
		async ({ provider, modelId }) => {
			let reads = 0;
			let writes = 0;
			const harness = await createHarness({
				modelId,
				provider,
				...(provider === "openai"
					? { api: "openai-responses", baseUrl: "https://api.openai.com/v1" }
					: {}),
				loadState: async (agentDir) => {
					reads++;
					return loadFastState(agentDir);
				},
				saveState: async (agentDir, state) => {
					writes++;
					return saveFastState(agentDir, state);
				},
			});
			await harness.emit("session_start", { type: "session_start" });
			await harness.command.handler("on", harness.context);

			expect(harness.statuses.get("codex-fast-mode")).toBe("⚡ fast");
			expect((await loadFastState(harness.agentDir)).state.enabled).toBe(true);
			const enabledMessage = harness.notifications.at(-1)?.message;
			expect(enabledMessage).toContain(`Fast mode enabled for ${provider}/${modelId}`);
			expect(enabledMessage).toContain("higher usage");
			expect(enabledMessage).toContain("no model-specific speed or cost estimate");
			expect(enabledMessage).toContain("increases API charges or ChatGPT subscription usage");
			expect(enabledMessage).toContain("newly started chats and workers");
			expect(enabledMessage).toContain("existing runtimes keep their own state");
			expect(harness.notifications.at(-1)?.level).toBe("warning");
			expect(enabledMessage).toContain("backend may downgrade");
			expect(enabledMessage).not.toMatch(/not eligible|~\d|×/);

			const payload = Object.freeze({ model: modelId, reasoning: { effort: "high" } });
			expect(await harness.emit("before_provider_request", { payload })).toEqual({
				...payload,
				service_tier: "priority",
			});
			expect(payload).not.toHaveProperty("service_tier");

			await harness.command.handler("status", harness.context);
			const statusMessage = harness.notifications.at(-1)?.message;
			expect(statusMessage).toContain(`Fast mode is on for ${provider}/${modelId}`);
			expect(statusMessage).toContain("service_tier=priority");
			expect(statusMessage).toContain("backend acceptance is not guaranteed");
			expect(statusMessage).toContain("no model-specific speed or cost estimate");
			expect(statusMessage).toContain("API charges or ChatGPT subscription usage");
			expect(statusMessage).not.toMatch(/not eligible|~\d|×/);
			expect(reads).toBe(1);
			expect(writes).toBe(1);

			await harness.command.handler("off", harness.context);
			expect((await loadFastState(harness.agentDir)).state.enabled).toBe(false);
			expect(harness.statuses.get("codex-fast-mode")).toBeUndefined();
			expect(await harness.emit("before_provider_request", { payload })).toBeUndefined();
		},
	);

	it.each([
		{ modelId: "gpt-6-terra" },
		{ modelId: "gpt-6-sol-mini" },
		{ modelId: "gpt-6.1-astra" },
		{ provider: "custom-openai", modelId: "gpt-6-astra" },
		{ provider: "azure-openai", modelId: "gpt-6-sol" },
		{ provider: "openrouter", modelId: "gpt-6-luna" },
		{ provider: "custom-codex", modelId: "gpt-6.1-sol" },
		{ provider: "openai", modelId: "gpt-5.6-sol" },
		{ provider: "openai", modelId: "gpt-6.1-astra" },
		{ provider: "openai", modelId: "gpt-6.1-sol", api: "openai-completions" },
		{ provider: "openai", modelId: "gpt-6.1-sol", baseUrl: "https://proxy.example/v1" },
	])(
		"keeps unsupported $provider/$modelId inactive even without pricing metadata",
		async (options) => {
			const harness = await createHarness(options);
			await harness.emit("session_start", { type: "session_start" });
			await harness.command.handler("on", harness.context);
			expect(harness.notifications.at(-1)?.message).toContain("not eligible");
			expect(harness.notifications.at(-1)?.message).toContain(
				"API charges or ChatGPT subscription usage",
			);
			expect(harness.notifications.at(-1)?.message).toContain("newly started chats and workers");
			expect(harness.notifications.at(-1)?.level).toBe("warning");
			expect(harness.statuses.get("codex-fast-mode")).toBe("⚡ fast (inactive)");
			expect((await loadFastState(harness.agentDir)).state.enabled).toBe(true);
			await harness.command.handler("status", harness.context);
			expect(harness.notifications.at(-1)?.message).toContain(
				"not eligible; requests are unchanged",
			);
			const payload = Object.freeze({ model: options.modelId });
			expect(await harness.emit("before_provider_request", { payload })).toBeUndefined();
			expect(payload).not.toHaveProperty("service_tier");
		},
	);

	it.each(["API-key", "ChatGPT subscription"])(
		"intentionally treats %s access identically without consulting auth APIs",
		async (access) => {
			const harness = await createHarness({
				provider: "openai",
				modelId: "gpt-6.1-sol",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
			});
			// Synthetic token-free auth metadata differs, but the extension must not
			// even ask for it. This is auth-neutral hook coverage, not a live login test.
			const authMetadata = { type: access === "API-key" ? "api_key" : "oauth" };
			Object.defineProperty(harness.context, "modelRegistry", {
				get() {
					throw new Error(`Must not inspect ${authMetadata.type} auth metadata`);
				},
			});
			await harness.emit("session_start", {});
			const payload = Object.freeze({ model: "gpt-6.1-sol" });
			expect(await harness.emit("before_provider_request", { payload })).toBeUndefined();
			await harness.command.handler("", harness.context);
			expect(await harness.emit("before_provider_request", { payload })).toEqual({
				...payload,
				service_tier: "priority",
			});
			await harness.command.handler("status", harness.context);
			expect(harness.notifications.at(-1)?.message).not.toMatch(/×|~\d/);
			await harness.command.handler("", harness.context);
			expect(await harness.emit("before_provider_request", { payload })).toBeUndefined();
		},
	);

	it("shares one saved preference with new chats/workers but not existing runtime state", async () => {
		const owner = await createHarness({ provider: "openai", modelId: "gpt-6.1-sol" });
		const existing = await createHarness({
			agentDir: owner.agentDir,
			provider: "openai",
			modelId: "gpt-6-sol",
		});
		await owner.emit("session_start", {});
		await existing.emit("session_start", {});
		await owner.command.handler("on", owner.context);
		const payload = Object.freeze({});
		expect(await existing.emit("before_provider_request", { payload })).toBeUndefined();

		const worker = await createHarness({ agentDir: owner.agentDir, modelId: "gpt-5.6-sol" });
		await worker.emit("session_start", {});
		expect(worker.notifications.at(-1)?.message).toContain(
			"API charges or ChatGPT subscription usage",
		);
		expect(await worker.emit("before_provider_request", { payload })).toEqual({
			service_tier: "priority",
		});
		const chat = await createHarness({
			agentDir: owner.agentDir,
			provider: "openai",
			modelId: "gpt-6-luna",
		});
		await chat.emit("session_start", {});
		expect(await chat.emit("before_provider_request", { payload })).toEqual({
			service_tier: "priority",
		});
		await owner.command.handler("off", owner.context);
		expect(await chat.emit("before_provider_request", { payload })).toEqual({
			service_tier: "priority",
		});
		expect(await worker.emit("before_provider_request", { payload })).toEqual({
			service_tier: "priority",
		});
		await existing.command.handler("status", existing.context);
		expect(existing.notifications.at(-1)?.message).toContain("Fast mode is off");
		const next = await createHarness({
			agentDir: owner.agentDir,
			provider: "openai",
			modelId: "gpt-6-astra",
		});
		await next.emit("session_start", {});
		expect(next.statuses.get("codex-fast-mode")).toBeUndefined();
		expect(await next.emit("before_provider_request", { payload })).toBeUndefined();
	});

	it("updates the footer for OpenAI model/API switches using the same gate as requests", async () => {
		const harness = await createHarness({
			provider: "openai",
			modelId: "gpt-6.1-sol",
			fastFlag: true,
		});
		await harness.emit("session_start", {});
		await harness.emit("model_select", {
			model: { provider: "openai", id: "gpt-6.1-sol", api: "openai-completions" },
		});
		expect(harness.statuses.get("codex-fast-mode")).toBe("⚡ fast (inactive)");
		await harness.emit("model_select", {
			model: {
				provider: "openai",
				id: "gpt-6.1-sol",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
			},
		});
		expect(harness.statuses.get("codex-fast-mode")).toBe("⚡ fast");
	});

	it("warns for a process-local OpenAI --fast without saving it", async () => {
		const harness = await createHarness({
			provider: "openai",
			modelId: "gpt-6.1-sol",
			fastFlag: true,
		});
		await harness.emit("session_start", {});
		expect(harness.notifications.at(-1)?.message).toContain(
			"API charges or ChatGPT subscription usage",
		);
		expect(harness.notifications.at(-1)?.message).toContain("this process only and is not saved");
		expect(harness.statuses.get("codex-fast-mode")).toBe("⚡ fast");
		expect((await loadFastState(harness.agentDir)).state.enabled).toBe(false);
	});

	it("warns once for OpenAI tier conflicts and skips descriptor/payload mismatches", async () => {
		const harness = await createHarness({
			provider: "openai",
			modelId: "gpt-6.1-sol",
			fastFlag: true,
		});
		await harness.emit("session_start", {});
		const mismatch = Object.freeze({ model: "gpt-6-sol", service_tier: "default" });
		expect(await harness.emit("before_provider_request", { payload: mismatch })).toBeUndefined();
		for (const service_tier of ["default", "fast", "flex"]) {
			const payload = Object.freeze({ model: "gpt-6.1-sol", service_tier });
			expect(await harness.emit("before_provider_request", { payload })).toEqual({
				...payload,
				service_tier: "priority",
			});
			expect(payload.service_tier).toBe(service_tier);
		}
		expect(
			harness.notifications.filter((n) => n.message.includes("replaced an existing service_tier")),
		).toHaveLength(1);
	});

	it("activates a saved GPT-6 preference and --fast without changing persistence semantics", async () => {
		const saved = await createHarness({ modelId: "gpt-6-astra" });
		await saveFastState(saved.agentDir, { version: FAST_STATE_VERSION, enabled: true });
		await saved.emit("session_start", { type: "session_start" });
		expect(saved.statuses.get("codex-fast-mode")).toBe("⚡ fast");
		expect(await saved.emit("before_provider_request", { payload: {} })).toEqual({
			service_tier: "priority",
		});

		const flagged = await createHarness({ modelId: "gpt-6.1-sol", fastFlag: true });
		await flagged.emit("session_start", { type: "session_start" });
		expect(flagged.statuses.get("codex-fast-mode")).toBe("⚡ fast");
		expect(await flagged.emit("before_provider_request", { payload: {} })).toEqual({
			service_tier: "priority",
		});
		expect((await loadFastState(flagged.agentDir)).state.enabled).toBe(false);
	});

	it("marks documented GPT-6 models active after a model switch", async () => {
		const harness = await createHarness({ modelId: "gpt-6-terra", fastFlag: true });
		await harness.emit("session_start", { type: "session_start" });
		expect(harness.statuses.get("codex-fast-mode")).toBe("⚡ fast (inactive)");
		await harness.emit("model_select", {
			model: { provider: "openai-codex", id: "gpt-6-sol" },
		});
		expect(harness.statuses.get("codex-fast-mode")).toBe("⚡ fast");
	});

	it("starts disabled and leaves provider requests untouched", async () => {
		const harness = await createHarness();
		await harness.emit("session_start", { type: "session_start" });
		const payload = { model: "gpt-5.6-sol" };

		expect(
			await harness.emit("before_provider_request", {
				type: "before_provider_request",
				payload,
			}),
		).toBeUndefined();
		expect(payload).not.toHaveProperty("service_tier");
		expect(harness.statuses.get("codex-fast-mode")).toBeUndefined();
	});

	it("enables, persists, and narrowly patches eligible requests", async () => {
		const harness = await createHarness();
		await harness.emit("session_start", { type: "session_start" });
		await harness.command.handler("on", harness.context);

		const payload = { model: "gpt-5.6-sol", reasoning: { effort: "high" } };
		const result = await harness.emit("before_provider_request", {
			type: "before_provider_request",
			payload,
		});

		expect(result).toEqual({ ...payload, service_tier: "priority" });
		expect(payload).not.toHaveProperty("service_tier");
		expect((await loadFastState(harness.agentDir)).state.enabled).toBe(true);
		expect(harness.statuses.get("codex-fast-mode")).toBe("⚡ fast");
		expect(harness.notifications.at(-1)?.message).toBe(
			"Fast mode enabled for openai-codex/gpt-5.6-sol: legacy Codex estimate ~1.5× speed and ~2.5× credits (not guaranteed current rates). Requests ask for service_tier=priority; the backend may downgrade or reject them. Warning: Fast processing increases API charges or ChatGPT subscription usage, depending on access; rates vary. Saved /fast preferences apply to newly started chats and workers sharing this agent directory; existing runtimes keep their own state.",
		);
		await harness.command.handler("status", harness.context);
		expect(harness.notifications.at(-1)?.message).toBe(
			"Fast mode is on for openai-codex/gpt-5.6-sol. Requests ask for service_tier=priority; backend acceptance is not guaranteed. Warning: Fast processing increases API charges or ChatGPT subscription usage, depending on access; rates vary. Saved /fast preferences apply to newly started chats and workers sharing this agent directory; existing runtimes keep their own state.",
		);
	});

	it("disables, persists, clears status, and stops modifying requests", async () => {
		const harness = await createHarness();
		await harness.emit("session_start", { type: "session_start" });
		await harness.command.handler("on", harness.context);
		await harness.command.handler("off", harness.context);

		expect(
			await harness.emit("before_provider_request", {
				type: "before_provider_request",
				payload: { model: "gpt-5.6-sol" },
			}),
		).toBeUndefined();
		expect((await loadFastState(harness.agentDir)).state.enabled).toBe(false);
		expect(harness.statuses.get("codex-fast-mode")).toBeUndefined();
		expect(harness.notifications.at(-1)?.message).toContain("Fast mode disabled");
	});

	it("loads a persisted enabled preference", async () => {
		const harness = await createHarness();
		await saveFastState(harness.agentDir, { version: FAST_STATE_VERSION, enabled: true });
		await harness.emit("session_start", { type: "session_start" });

		expect(
			await harness.emit("before_provider_request", {
				type: "before_provider_request",
				payload: { model: "gpt-5.6-sol" },
			}),
		).toEqual({ model: "gpt-5.6-sol", service_tier: "priority" });
	});

	it("serializes overlapping bare toggles", async () => {
		const harness = await createHarness();
		await harness.emit("session_start", { type: "session_start" });
		await Promise.all([
			harness.command.handler("", harness.context),
			harness.command.handler("", harness.context),
		]);

		const messages = harness.notifications.map((notification) => notification.message);
		expect(messages.some((message) => message.startsWith("Fast mode enabled"))).toBe(true);
		expect(messages.at(-1)).toContain("Fast mode disabled");
		expect((await loadFastState(harness.agentDir)).state.enabled).toBe(false);
	});

	it("keeps the process choice when persistence fails", async () => {
		const harness = await createHarness({
			saveState: async () => {
				throw new Error("read-only filesystem");
			},
		});
		await harness.emit("session_start", { type: "session_start" });
		await harness.command.handler("on", harness.context);

		expect(
			await harness.emit("before_provider_request", {
				type: "before_provider_request",
				payload: { model: "gpt-5.6-sol" },
			}),
		).toEqual({ model: "gpt-5.6-sol", service_tier: "priority" });
		expect(harness.notifications.at(-1)?.message).toContain("could not be saved");
		expect(harness.notifications.at(-1)?.message).toContain(
			"API charges or ChatGPT subscription usage",
		);
	});

	it("toggles and persists with bare /fast", async () => {
		const harness = await createHarness();
		await harness.emit("session_start", { type: "session_start" });

		await harness.command.handler("", harness.context);
		expect((await loadFastState(harness.agentDir)).state.enabled).toBe(true);
		expect(harness.statuses.get("codex-fast-mode")).toBe("⚡ fast");
		expect(harness.notifications.at(-1)?.message).toContain("Fast mode enabled");
		expect(
			await harness.emit("before_provider_request", {
				type: "before_provider_request",
				payload: { model: "gpt-5.6-sol" },
			}),
		).toEqual({ model: "gpt-5.6-sol", service_tier: "priority" });

		await harness.command.handler("", harness.context);
		expect((await loadFastState(harness.agentDir)).state.enabled).toBe(false);
		expect(harness.statuses.get("codex-fast-mode")).toBeUndefined();
		expect(harness.notifications.at(-1)?.message).toContain("Fast mode disabled");
		expect(
			await harness.emit("before_provider_request", {
				type: "before_provider_request",
				payload: { model: "gpt-5.6-sol" },
			}),
		).toBeUndefined();
	});

	it("keeps explicit status read-only and rejects invalid arguments", async () => {
		const harness = await createHarness();
		await harness.emit("session_start", { type: "session_start" });
		await harness.command.handler("status", harness.context);
		expect(harness.notifications.at(-1)?.message).toContain("Fast mode is off");
		expect((await loadFastState(harness.agentDir)).state.enabled).toBe(false);

		await harness.command.handler("toggle", harness.context);
		expect(harness.notifications.at(-1)).toEqual({
			message: "Usage: /fast [on | off | status]",
			level: "error",
		});
	});

	it("persists the preference but remains inactive on unsupported models", async () => {
		const harness = await createHarness({ modelId: "gpt-5.3-codex" });
		await harness.emit("session_start", { type: "session_start" });
		await harness.command.handler("on", harness.context);

		expect(
			await harness.emit("before_provider_request", {
				type: "before_provider_request",
				payload: { model: "gpt-5.3-codex" },
			}),
		).toBeUndefined();
		expect((await loadFastState(harness.agentDir)).state.enabled).toBe(true);
		expect(harness.statuses.get("codex-fast-mode")).toBe("⚡ fast (inactive)");
	});

	it("supports a session-only --fast flag without persisting it", async () => {
		const harness = await createHarness({ fastFlag: true });
		await harness.emit("session_start", { type: "session_start" });

		expect(
			await harness.emit("before_provider_request", {
				type: "before_provider_request",
				payload: { model: "gpt-5.6-sol" },
			}),
		).toEqual({ model: "gpt-5.6-sol", service_tier: "priority" });
		expect((await loadFastState(harness.agentDir)).state.enabled).toBe(false);
	});

	it("updates status when the selected model changes", async () => {
		const harness = await createHarness();
		await harness.emit("session_start", { type: "session_start" });
		await harness.command.handler("on", harness.context);
		await harness.emit("model_select", {
			type: "model_select",
			model: { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
			previousModel: harness.context.model,
			source: "set",
		});
		expect(harness.statuses.get("codex-fast-mode")).toBe("⚡ fast (inactive)");
	});

	it("warns once for an invalid provider payload", async () => {
		const harness = await createHarness();
		await harness.emit("session_start", { type: "session_start" });
		await harness.command.handler("on", harness.context);
		const event = { type: "before_provider_request", payload: null };
		await harness.emit("before_provider_request", event);
		await harness.emit("before_provider_request", event);

		const warnings = harness.notifications.filter((notification) =>
			notification.message.includes("non-object provider payload"),
		);
		expect(warnings).toHaveLength(1);
	});

	it("surfaces state-load warnings and defaults off", async () => {
		const harness = await createHarness({
			loadState: async (agentDir) => ({
				state: { version: FAST_STATE_VERSION, enabled: false },
				path: join(agentDir, "state", "pi-codex-fast-mode.json"),
				warning: "state warning",
			}),
		});
		await harness.emit("session_start", { type: "session_start" });
		expect(harness.notifications.at(-1)).toEqual({ message: "state warning", level: "warning" });
	});

	it("warns once when replacing another service tier", async () => {
		const harness = await createHarness();
		await harness.emit("session_start", { type: "session_start" });
		await harness.command.handler("on", harness.context);
		const event = {
			type: "before_provider_request",
			payload: { service_tier: "flex" },
		};

		await harness.emit("before_provider_request", event);
		await harness.emit("before_provider_request", event);
		const conflictWarnings = harness.notifications.filter((notification) =>
			notification.message.includes("replaced an existing service_tier"),
		);
		expect(conflictWarnings).toHaveLength(1);
	});
});
