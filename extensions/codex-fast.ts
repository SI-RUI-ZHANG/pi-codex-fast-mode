import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	applyFastServiceTier,
	EXPECTED_SPEED_MULTIPLIER,
	FAST_SERVICE_TIER,
	getFastCreditMultiplier,
	isFastEligible,
	type ModelDescriptor,
	modelReference,
	parseFastCommand,
} from "./core.ts";
import { FAST_STATE_VERSION, loadFastState, saveFastState } from "./state.ts";

const STATUS_KEY = "codex-fast-mode";
const COMMAND_VALUES = ["on", "off", "status"] as const;
const UNKNOWN_FAST_ESTIMATE =
	"Fast mode uses higher usage; this extension has no model-specific speed or cost estimate.";
const FAST_COST_WARNING =
	"Warning: Fast processing increases API charges or ChatGPT subscription usage, depending on access; rates vary.";
const SHARED_PREFERENCE_NOTICE =
	"Saved /fast preferences apply to newly started chats and workers sharing this agent directory; existing runtimes keep their own state.";

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
		return `Fast preference is on, but ${modelReference(model)} is not eligible; requests are unchanged. ${FAST_COST_WARNING} ${SHARED_PREFERENCE_NOTICE}`;
	}
	const estimate = getFastCreditMultiplier(model) === undefined ? ` ${UNKNOWN_FAST_ESTIMATE}` : "";
	return `Fast mode is on for ${modelReference(model)}. Requests ask for service_tier=${FAST_SERVICE_TIER}; backend acceptance is not guaranteed.${estimate} ${FAST_COST_WARNING} ${SHARED_PREFERENCE_NOTICE}`;
}

function enabledMessage(model: ModelDescriptor | undefined): string {
	if (!isFastEligible(model)) {
		return `Fast preference enabled, but ${modelReference(model)} is not eligible; requests remain unchanged. ${FAST_COST_WARNING} ${SHARED_PREFERENCE_NOTICE}`;
	}
	const creditMultiplier = getFastCreditMultiplier(model);
	if (creditMultiplier === undefined) {
		return `Fast mode enabled for ${modelReference(model)}. ${UNKNOWN_FAST_ESTIMATE} Requests ask for service_tier=${FAST_SERVICE_TIER}; the backend may downgrade or reject them. ${FAST_COST_WARNING} ${SHARED_PREFERENCE_NOTICE}`;
	}
	return `Fast mode enabled for ${modelReference(model)}: legacy Codex estimate ~${EXPECTED_SPEED_MULTIPLIER}× speed and ~${creditMultiplier}× credits (not guaranteed current rates). Requests ask for service_tier=${FAST_SERVICE_TIER}; the backend may downgrade or reject them. ${FAST_COST_WARNING} ${SHARED_PREFERENCE_NOTICE}`;
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
		description: "Request OpenAI Fast for this process (increased API charges/subscription usage)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Fast (increased API charges/subscription usage; on, off, status)",
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
						`Fast mode is ${nextEnabled ? "on" : "off"} for this process, but the preference could not be saved: ${detail}${nextEnabled ? ` ${FAST_COST_WARNING}` : ""}`,
						"warning",
					);
					return;
				}

				ctx.ui.notify(
					nextEnabled
						? enabledMessage(ctx.model)
						: "Fast mode disabled. This extension no longer modifies provider requests.",
					nextEnabled ? "warning" : "info",
				);
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await readState(resolveAgentDir());
		enabled = loaded.state.enabled;
		if (pi.getFlag("fast") === true) enabled = true;
		if (loaded.warning) notify(ctx, loaded.warning, "warning");
		if (enabled) {
			const scope =
				pi.getFlag("fast") === true
					? "--fast applies to this process only and is not saved."
					: SHARED_PREFERENCE_NOTICE;
			notify(ctx, `Fast preference is on. ${FAST_COST_WARNING} ${scope}`, "warning");
		}
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
