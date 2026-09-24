export const CODEX_PROVIDER = "openai-codex";
export const FAST_SERVICE_TIER = "priority";
export const EXPECTED_SPEED_MULTIPLIER = 1.5;

const SUPPORTED_MODEL_PATTERN = /^gpt-5\.(4|5|6)(?:$|-)/;
const SUPPORTED_GPT_6_MODELS = new Set(["gpt-6-sol", "gpt-6-luna", "gpt-6-astra"]);

export interface ModelDescriptor {
	readonly provider: string;
	readonly id: string;
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

function fastModelVersion(
	model: ModelDescriptor | undefined,
): "5.4" | "5.5" | "5.6" | "6" | undefined {
	if (!model || model.provider !== CODEX_PROVIDER) return undefined;
	if (SUPPORTED_GPT_6_MODELS.has(model.id)) return "6";
	const match = SUPPORTED_MODEL_PATTERN.exec(model.id);
	const version = match?.[1];
	if (version === "4") return "5.4";
	if (version === "5") return "5.5";
	if (version === "6") return "5.6";
	return undefined;
}

export function isFastEligible(model: ModelDescriptor | undefined): boolean {
	return fastModelVersion(model) !== undefined;
}

export function getFastCreditMultiplier(model: ModelDescriptor | undefined): number | undefined {
	const version = fastModelVersion(model);
	if (version === "5.4") return 2;
	if (version === "5.5" || version === "5.6" || version === "6") return 2.5;
	return undefined;
}

export function getFastSpeedMultiplier(model: ModelDescriptor | undefined): number | undefined {
	const version = fastModelVersion(model);
	return version && version !== "6" ? EXPECTED_SPEED_MULTIPLIER : undefined;
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
