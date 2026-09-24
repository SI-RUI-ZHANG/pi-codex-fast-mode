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
	fastFlag?: boolean;
	modelId?: string;
	loadState?: CodexFastModeDependencies["loadState"];
	saveState?: CodexFastModeDependencies["saveState"];
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-codex-fast-extension-"));
	temporaryDirectories.push(agentDir);

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
			provider: "openai-codex",
			id: options.modelId ?? "gpt-5.6-sol",
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
		expect(harness.notifications.at(-1)?.message).toContain("~2.5× credits");
		expect(harness.notifications.at(-1)?.message).toContain("~1.5× speed");
	});

	it.each(["gpt-6-sol", "gpt-6-luna", "gpt-6-astra"])(
		"enables Fast mode for %s without an unsupported speed claim",
		async (id) => {
			const harness = await createHarness({ modelId: id });
			await harness.emit("session_start", { type: "session_start" });
			await harness.command.handler("on", harness.context);

			const message = harness.notifications.at(-1)?.message;
			expect(message).toContain("~2.5× credits");
			expect(message).not.toContain("× speed");
			expect(message).toContain("the backend may downgrade them");
			expect(harness.statuses.get("codex-fast-mode")).toBe("⚡ fast");
			const payload = { model: id };
			expect(
				await harness.emit("before_provider_request", {
					type: "before_provider_request",
					payload,
				}),
			).toEqual({ model: id, service_tier: "priority" });
			expect(payload).not.toHaveProperty("service_tier");
			await harness.command.handler("status", harness.context);
			expect(harness.notifications.at(-1)?.message).toContain(
				`Fast mode is on for openai-codex/${id}`,
			);
		},
	);

	it.each(["gpt-6", "gpt-6-future", "gpt-6-sol-preview"])(
		"keeps Fast mode inactive on unsupported %s",
		async (id) => {
			const harness = await createHarness({ modelId: id });
			await harness.emit("session_start", { type: "session_start" });
			await harness.command.handler("on", harness.context);

			expect(harness.notifications.at(-1)?.message).toContain("is not eligible");
			expect(harness.statuses.get("codex-fast-mode")).toBe("⚡ fast (inactive)");
			expect(
				await harness.emit("before_provider_request", {
					type: "before_provider_request",
					payload: { model: id },
				}),
			).toBeUndefined();
		},
	);

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
