import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	applyFastServiceTier,
	FAST_SERVICE_TIER,
	getFastCreditMultiplier,
	getFastSpeedMultiplier,
	isFastEligible,
	type ModelDescriptor,
	modelReference,
	parseFastCommand,
} from "./core.ts";
import { FAST_STATE_VERSION, loadFastState, saveFastState } from "./state.ts";

const STATUS_KEY = "codex-fast-mode";
const COMMAND_VALUES = ["on", "off", "status"] as const;

export interface CodexFastModeDependencies {
	getAgentDir?: () => string;
	loadState?: typeof loadFastState;
	saveState?: typeof saveFastState;
}

function formatUnknownTier(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === undefined) return "undefined";
	if (value === null || typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return `<${typeof value}>`;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function updateStatus(ctx: ExtensionContext, enabled: boolean, model = ctx.model): void {
	if (ctx.mode !== "tui") return;
	if (!enabled) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, isFastEligible(model) ? "⚡ fast" : "⚡ fast (inactive)");
}

function statusMessage(enabled: boolean, model: ModelDescriptor | undefined): string {
	if (!enabled) {
		return "Fast mode is off. This extension is not modifying provider requests.";
	}
	if (!isFastEligible(model)) {
		return `Fast preference is on, but ${modelReference(model)} is not eligible; requests are unchanged.`;
	}
	return `Fast mode is on for ${modelReference(model)}. Requests ask for service_tier=${FAST_SERVICE_TIER}; backend acceptance is not guaranteed.`;
}

function enabledMessage(model: ModelDescriptor | undefined): string {
	const creditMultiplier = getFastCreditMultiplier(model);
	if (!creditMultiplier) {
		return `Fast preference enabled, but ${modelReference(model)} is not eligible; requests remain unchanged.`;
	}
	const speedMultiplier = getFastSpeedMultiplier(model);
	const estimate = speedMultiplier
		? `~${speedMultiplier}× speed and ~${creditMultiplier}× credits`
		: `~${creditMultiplier}× credits`;
	return `Fast mode enabled for ${modelReference(model)}: ${estimate}. Requests ask for service_tier=${FAST_SERVICE_TIER}; the backend may downgrade them.`;
}

export function registerCodexFastMode(
	pi: ExtensionAPI,
	dependencies: CodexFastModeDependencies = {},
): void {
	const resolveAgentDir = dependencies.getAgentDir ?? getAgentDir;
	const readState = dependencies.loadState ?? loadFastState;
	const writeState = dependencies.saveState ?? saveFastState;
	let enabled = false;
	let warnedAboutConflict = false;
	let warnedAboutInvalidPayload = false;
	let commandQueue: Promise<void> = Promise.resolve();

	function enqueueCommand(operation: () => Promise<void>): Promise<void> {
		const queued = commandQueue.then(operation);
		commandQueue = queued.catch(() => undefined);
		return queued;
	}

	pi.registerFlag("fast", {
		description: "Request OpenAI Codex Fast mode for this Pi process",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("fast", {
		description: "Toggle Codex Fast mode (or use on, off, status)",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			return COMMAND_VALUES.flatMap((value) =>
				value.startsWith(normalized) ? [{ value, label: value }] : [],
			);
		},
		handler: async (args, ctx) => {
			const command = parseFastCommand(args);
			if (!command) {
				ctx.ui.notify("Usage: /fast [on | off | status]", "error");
				return;
			}

			await enqueueCommand(async () => {
				if (command === "status") {
					ctx.ui.notify(statusMessage(enabled, ctx.model), "info");
					return;
				}

				const nextEnabled = command === "toggle" ? !enabled : command === "on";
				enabled = nextEnabled;
				warnedAboutConflict = false;
				warnedAboutInvalidPayload = false;
				updateStatus(ctx, nextEnabled);

				try {
					await writeState(resolveAgentDir(), {
						version: FAST_STATE_VERSION,
						enabled: nextEnabled,
					});
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(
						`Fast mode is ${nextEnabled ? "on" : "off"} for this process, but the preference could not be saved: ${detail}`,
						"warning",
					);
					return;
				}

				ctx.ui.notify(
					nextEnabled
						? enabledMessage(ctx.model)
						: "Fast mode disabled. This extension no longer modifies provider requests.",
					"info",
				);
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await readState(resolveAgentDir());
		enabled = loaded.state.enabled;
		if (pi.getFlag("fast") === true) enabled = true;
		if (loaded.warning) notify(ctx, loaded.warning, "warning");
		updateStatus(ctx, enabled);
	});

	pi.on("model_select", (event, ctx) => {
		updateStatus(ctx, enabled, event.model);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const result = applyFastServiceTier(event.payload, enabled, ctx.model);
		if (!result.applied) {
			if (result.reason === "invalid-payload" && !warnedAboutInvalidPayload && ctx.hasUI) {
				warnedAboutInvalidPayload = true;
				ctx.ui.notify(
					"Fast mode could not modify a non-object provider payload; the request is unchanged.",
					"warning",
				);
			}
			return;
		}

		if (
			result.hadServiceTier &&
			result.previousServiceTier !== FAST_SERVICE_TIER &&
			!warnedAboutConflict &&
			ctx.hasUI
		) {
			warnedAboutConflict = true;
			ctx.ui.notify(
				`Fast mode replaced an existing service_tier=${formatUnknownTier(result.previousServiceTier)}. Avoid combining service-tier extensions.`,
				"warning",
			);
		}

		return result.payload;
	});
}

export default function codexFastMode(pi: ExtensionAPI): void {
	registerCodexFastMode(pi);
}
