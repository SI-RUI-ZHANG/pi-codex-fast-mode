export const CODEX_PROVIDER = "openai-codex";
export const OPENAI_PROVIDER = "openai";
export const FAST_SERVICE_TIER = "priority";
export const EXPECTED_SPEED_MULTIPLIER = 1.5;

const SUPPORTED_MODEL_PATTERN = /^gpt-5\.(4|5|6)(?:$|-)/;
// https://developers.openai.com/codex/speed and https://developers.openai.com/codex/models
// Exact IDs only: Fast support is not guaranteed for future GPT-6 variants.
const SUPPORTED_GPT6_MODELS = new Set(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]);

export interface ModelDescriptor {
	readonly provider: string;
	readonly id: string;
	// Optional descriptor checks, not proof of the effective request route or auth.
	readonly api?: string;
	readonly baseUrl?: string;
}

export type FastCommand = "toggle" | "on" | "off" | "status";

export type FastPayloadResult =
	| {
			applied: false;
			payload: unknown;
			reason: "disabled" | "unsupported-model" | "invalid-payload";
	  }
	| {
			applied: true;
			payload: Record<string, unknown>;
			changed: boolean;
			hadServiceTier: boolean;
			previousServiceTier: unknown;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fastModelVersion(model: ModelDescriptor | undefined): "5.4" | "5.5" | "5.6" | undefined {
	if (!model || model.provider !== CODEX_PROVIDER) return undefined;
	const match = SUPPORTED_MODEL_PATTERN.exec(model.id);
	const version = match?.[1];
	if (version === "4") return "5.4";
	if (version === "5") return "5.5";
	if (version === "6") return "5.6";
	return undefined;
}

export function isFastEligible(model: ModelDescriptor | undefined): boolean {
	if (!model) return false;
	if (model.provider === CODEX_PROVIDER) {
		return fastModelVersion(model) !== undefined || SUPPORTED_GPT6_MODELS.has(model.id);
	}
	if (model.provider !== OPENAI_PROVIDER || !SUPPORTED_GPT6_MODELS.has(model.id)) return false;
	if (model.api !== undefined && model.api !== "openai-responses") return false;
	return (
		model.baseUrl === undefined ||
		model.baseUrl === "https://api.openai.com/v1" ||
		model.baseUrl === "https://api.openai.com/v1/"
	);
}

export function getFastCreditMultiplier(model: ModelDescriptor | undefined): number | undefined {
	const version = fastModelVersion(model);
	if (version === "5.4") return 2;
	if (version === "5.5" || version === "5.6") return 2.5;
	return undefined;
}

export function modelReference(model: ModelDescriptor | undefined): string {
	return model ? `${model.provider}/${model.id}` : "no model selected";
}

export function parseFastCommand(args: string): FastCommand | undefined {
	const command = args.trim().toLowerCase();
	if (command === "") return "toggle";
	if (command === "on" || command === "off" || command === "status") return command;
	return undefined;
}

export function applyFastServiceTier(
	payload: unknown,
	enabled: boolean,
	model: ModelDescriptor | undefined,
): FastPayloadResult {
	if (!enabled) return { applied: false, payload, reason: "disabled" };
	if (!isFastEligible(model)) {
		return { applied: false, payload, reason: "unsupported-model" };
	}
	if (!isRecord(payload)) return { applied: false, payload, reason: "invalid-payload" };
	// On the new route, reject a visible selection/payload mismatch. Older hooks
	// and minimal descriptors need no new fields; neither check resolves auth.
	if (
		model?.provider === OPENAI_PROVIDER &&
		payload.model !== undefined &&
		payload.model !== model.id
	) {
		return { applied: false, payload, reason: "unsupported-model" };
	}

	const hadServiceTier = Object.hasOwn(payload, "service_tier");
	const previousServiceTier = payload.service_tier;
	if (previousServiceTier === FAST_SERVICE_TIER) {
		return {
			applied: true,
			payload,
			changed: false,
			hadServiceTier,
			previousServiceTier,
		};
	}

	return {
		applied: true,
		payload: { ...payload, service_tier: FAST_SERVICE_TIER },
		changed: true,
		hadServiceTier,
		previousServiceTier,
	};
}
