import { describe, expect, it } from "vitest";
import {
	applyFastServiceTier,
	FAST_SERVICE_TIER,
	getFastCreditMultiplier,
	isFastEligible,
	type ModelDescriptor,
	parseFastCommand,
} from "../extensions/core.ts";

const codex = (id: string): ModelDescriptor => ({ provider: "openai-codex", id });
const gpt6ModelIds = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"];
const unsupportedGpt6ModelIds = [
	"gpt-6",
	"gpt-6.1",
	"gpt-6-terra",
	"gpt-6-sol-mini",
	"gpt-6-sol-2026-09-01",
	"gpt-6.1-astra",
	"gpt-6.1-luna",
	"gpt-6.1-sol-2026-09-01",
	"gpt-6.10-sol",
	"gpt6-sol",
];

describe("isFastEligible", () => {
	it.each(["gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"])(
		"accepts supported Codex model %s",
		(id) => {
			expect(isFastEligible(codex(id))).toBe(true);
		},
	);

	it.each(gpt6ModelIds)("accepts the documented GPT-6 Codex ID %s", (id) => {
		expect(isFastEligible(codex(id))).toBe(true);
	});

	it.each(unsupportedGpt6ModelIds)("rejects undocumented GPT-6 variant %s", (id) => {
		expect(isFastEligible(codex(id))).toBe(false);
	});

	it.each(gpt6ModelIds)("rejects %s on other providers", (id) => {
		for (const provider of ["openrouter", "azure-openai", "custom-codex", "custom-openai"]) {
			expect(isFastEligible({ provider, id })).toBe(false);
		}
	});

	it("rejects a missing model", () => {
		expect(isFastEligible(undefined)).toBe(false);
	});

	it.each([
		{ provider: "openai", id: "gpt-5.6-sol" },
		{ provider: "openai-codex", id: "gpt-5.3-codex" },
		{ provider: "anthropic", id: "claude-opus-4-6" },
	])("rejects $provider/$id", (model) => {
		expect(isFastEligible(model)).toBe(false);
	});
});

describe("OpenAI Responses Fast mode", () => {
	const openai = (id: string): ModelDescriptor => ({
		provider: "openai",
		id,
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
	});

	it.each(gpt6ModelIds)("accepts exactly %s without borrowing Codex estimates", (id) => {
		expect(isFastEligible(openai(id))).toBe(true);
		expect(isFastEligible({ provider: "openai", id })).toBe(true);
		expect(isFastEligible({ ...openai(id), baseUrl: "https://api.openai.com/v1/" })).toBe(true);
		expect(getFastCreditMultiplier(openai(id))).toBeUndefined();
		const payload = Object.freeze({ model: id, reasoning: Object.freeze({ effort: "high" }) });
		const result = applyFastServiceTier(payload, true, openai(id));
		expect(result.applied).toBe(true);
		expect(result.payload).toEqual({ ...payload, service_tier: "priority" });
		expect(result.payload).not.toBe(payload);
		if (result.applied) expect(result.payload.reasoning).toBe(payload.reasoning);
		expect(payload).not.toHaveProperty("service_tier");
	});

	it.each([...unsupportedGpt6ModelIds, "gpt-5.4", "gpt-5.5", "gpt-5.6-sol"])(
		"rejects unsupported OpenAI ID %s",
		(id) => {
			expect(isFastEligible(openai(id))).toBe(false);
			const payload = Object.freeze({ model: id, service_tier: "default" });
			expect(applyFastServiceTier(payload, true, openai(id))).toEqual({
				applied: false,
				payload,
				reason: "unsupported-model",
			});
			expect(applyFastServiceTier(payload, true, openai(id)).payload).toBe(payload);
		},
	);

	it.each([
		{ api: "openai-completions" },
		{ api: "openai-codex-responses" },
		{ api: "custom-responses" },
		{ baseUrl: "https://proxy.example/v1" },
		{ baseUrl: "https://api.openai.com/v1/responses" },
		{ baseUrl: "http://api.openai.com/v1" },
		{ baseUrl: "https://api.openai.com.example/v1" },
		{ baseUrl: "https://api.openai.com/v1?route=proxy" },
		{ baseUrl: "https://api.openai.com/v1#proxy" },
		{ baseUrl: "" },
	])("rejects a visibly misrouted descriptor %j", (override) => {
		const model = { ...openai("gpt-6.1-sol"), ...override };
		expect(isFastEligible(model)).toBe(false);
		const payload = Object.freeze({ service_tier: "flex" });
		expect(applyFastServiceTier(payload, true, model).payload).toBe(payload);
		expect(applyFastServiceTier(payload, true, model).applied).toBe(false);
	});

	it.each(["gpt-6-sol", "gpt-5.6-sol", null, 42])(
		"rejects a visible payload-model mismatch %j",
		(model) => {
			const payload = Object.freeze({ model });
			const result = applyFastServiceTier(payload, true, openai("gpt-6.1-sol"));
			expect(result.applied).toBe(false);
			expect(result.payload).toBe(payload);
		},
	);

	it.each(gpt6ModelIds)("preserves off and immutable tier-conflict behavior for %s", (id) => {
		for (const tier of ["default", "flex", "fast", "priority", "ultrafast"]) {
			const payload = Object.freeze({ model: id, service_tier: tier });
			const off = applyFastServiceTier(payload, false, openai(id));
			expect(off.applied).toBe(false);
			expect(off.payload).toBe(payload);
			const on = applyFastServiceTier(payload, true, openai(id));
			expect(on.applied).toBe(true);
			if (!on.applied) throw new Error("Expected Fast mode to apply");
			expect(on.previousServiceTier).toBe(tier);
			expect(on.changed).toBe(tier !== "priority");
			expect(on.payload.service_tier).toBe("priority");
			if (tier === "priority") expect(on.payload).toBe(payload);
			else expect(on.payload).not.toBe(payload);
			expect(payload.service_tier).toBe(tier);
		}
	});

	it.each([null, undefined, [], "request", 42])("skips invalid payload %j", (payload) => {
		expect(applyFastServiceTier(payload, true, openai("gpt-6-sol"))).toEqual({
			applied: false,
			payload,
			reason: "invalid-payload",
		});
	});
});

describe("getFastCreditMultiplier", () => {
	it("uses the documented GPT-5.4 multiplier", () => {
		expect(getFastCreditMultiplier(codex("gpt-5.4"))).toBe(2);
	});

	it.each(["gpt-5.5", "gpt-5.6-sol"])("uses the documented multiplier for %s", (id) => {
		expect(getFastCreditMultiplier(codex(id))).toBe(2.5);
	});

	it.each(gpt6ModelIds)("does not infer a credit multiplier for eligible %s", (id) => {
		expect(isFastEligible(codex(id))).toBe(true);
		expect(getFastCreditMultiplier(codex(id))).toBeUndefined();
	});

	it("has no estimate for a missing model or a different provider", () => {
		expect(getFastCreditMultiplier(undefined)).toBeUndefined();
		expect(getFastCreditMultiplier({ provider: "openai", id: "gpt-5.6-sol" })).toBeUndefined();
	});
});

describe("parseFastCommand", () => {
	it.each([
		["", "toggle"],
		["  STATUS ", "status"],
		["on", "on"],
		["OFF", "off"],
	])("parses %j as %s", (input, expected) => {
		expect(parseFastCommand(input)).toBe(expected);
	});

	it.each(["toggle", "on now", "true"])("rejects %j", (input) => {
		expect(parseFastCommand(input)).toBeUndefined();
	});
});

describe("applyFastServiceTier", () => {
	it.each(gpt6ModelIds)(
		"adds only priority to frozen %s requests without pricing metadata",
		(id) => {
			const reasoning = Object.freeze({ effort: "high" });
			const input = Object.freeze([Object.freeze({ role: "user", content: "Hello" })]);
			const payload = Object.freeze({
				model: id,
				reasoning,
				input,
				text: Object.freeze({ verbosity: "low" }),
				tools: Object.freeze([]),
			});
			const result = applyFastServiceTier(payload, true, codex(id));

			expect(result.applied).toBe(true);
			if (!result.applied) throw new Error("Expected Fast mode to apply");
			expect(result.payload).toEqual({ ...payload, service_tier: "priority" });
			expect(result.payload).not.toBe(payload);
			for (const key of ["reasoning", "input", "text", "tools"] as const) {
				expect(result.payload[key]).toBe(payload[key]);
			}
			expect(payload).not.toHaveProperty("service_tier");
		},
	);

	it.each([...gpt6ModelIds, ...unsupportedGpt6ModelIds])(
		"leaves disabled and unsupported %s requests untouched",
		(id) => {
			const payload = Object.freeze({ model: id, service_tier: "flex" });
			const models = [{ provider: "custom-openai", id }];
			if (unsupportedGpt6ModelIds.includes(id)) models.push(codex(id));
			for (const model of models) {
				expect(applyFastServiceTier(payload, true, model)).toEqual({
					applied: false,
					payload,
					reason: "unsupported-model",
				});
				expect(applyFastServiceTier(payload, true, model).payload).toBe(payload);
			}
			expect(applyFastServiceTier(payload, false, codex(id))).toEqual({
				applied: false,
				payload,
				reason: "disabled",
			});
			expect(payload.service_tier).toBe("flex");
		},
	);

	it.each(gpt6ModelIds)("preserves or replaces existing tiers immutably for %s", (id) => {
		const priorityPayload = Object.freeze({ model: id, service_tier: "priority" });
		const unchanged = applyFastServiceTier(priorityPayload, true, codex(id));
		expect(unchanged.applied).toBe(true);
		if (!unchanged.applied) throw new Error("Expected Fast mode to apply");
		expect(unchanged.changed).toBe(false);
		expect(unchanged.payload).toBe(priorityPayload);

		const flexPayload = Object.freeze({ model: id, service_tier: "flex" });
		const replaced = applyFastServiceTier(flexPayload, true, codex(id));
		expect(replaced.applied).toBe(true);
		if (!replaced.applied) throw new Error("Expected Fast mode to apply");
		expect(replaced.changed).toBe(true);
		expect(replaced.previousServiceTier).toBe("flex");
		expect(replaced.payload).toEqual({ model: id, service_tier: "priority" });
		expect(flexPayload.service_tier).toBe("flex");
	});

	it("returns the original payload when disabled", () => {
		const payload = { model: "gpt-5.6-sol" };
		const result = applyFastServiceTier(payload, false, codex("gpt-5.6-sol"));
		expect(result).toEqual({ applied: false, payload, reason: "disabled" });
	});

	it("returns the original payload for an unsupported provider", () => {
		const payload = { model: "gpt-5.6-sol" };
		const result = applyFastServiceTier(payload, true, {
			provider: "openai",
			id: "gpt-5.6-sol",
		});
		expect(result).toEqual({ applied: false, payload, reason: "unsupported-model" });
	});

	it("adds only service_tier without mutating the request", () => {
		const nested = { effort: "high" };
		const payload = { model: "gpt-5.6-sol", reasoning: nested, text: { verbosity: "low" } };
		const result = applyFastServiceTier(payload, true, codex("gpt-5.6-sol"));

		expect(result.applied).toBe(true);
		if (!result.applied) throw new Error("Expected Fast mode to apply");
		expect(result.payload).toEqual({ ...payload, service_tier: FAST_SERVICE_TIER });
		expect(result.payload).not.toBe(payload);
		expect(result.payload.reasoning).toBe(nested);
		expect(payload).not.toHaveProperty("service_tier");
	});

	it("does not clone a request that already asks for priority", () => {
		const payload = { service_tier: FAST_SERVICE_TIER };
		const result = applyFastServiceTier(payload, true, codex("gpt-5.5"));
		expect(result.applied).toBe(true);
		if (!result.applied) throw new Error("Expected Fast mode to apply");
		expect(result.changed).toBe(false);
		expect(result.payload).toBe(payload);
	});

	it("reports a service-tier replacement", () => {
		const result = applyFastServiceTier({ service_tier: "flex" }, true, codex("gpt-5.6-sol"));
		expect(result.applied).toBe(true);
		if (!result.applied) throw new Error("Expected Fast mode to apply");
		expect(result.hadServiceTier).toBe(true);
		expect(result.previousServiceTier).toBe("flex");
		expect(result.payload.service_tier).toBe(FAST_SERVICE_TIER);
	});
});
