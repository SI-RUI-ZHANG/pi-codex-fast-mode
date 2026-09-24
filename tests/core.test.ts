import { describe, expect, it } from "vitest";
import {
	applyFastServiceTier,
	FAST_SERVICE_TIER,
	getFastCreditMultiplier,
	getFastSpeedMultiplier,
	isFastEligible,
	type ModelDescriptor,
	parseFastCommand,
} from "../extensions/core.ts";

const codex = (id: string): ModelDescriptor => ({ provider: "openai-codex", id });

describe("isFastEligible", () => {
	it.each([
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5.5",
		"gpt-5.6-luna",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-6-sol",
		"gpt-6-luna",
		"gpt-6-astra",
	])("accepts supported Codex model %s", (id) => {
		expect(isFastEligible(codex(id))).toBe(true);
	});

	it.each([
		{ provider: "openai", id: "gpt-5.6-sol" },
		{ provider: "openai", id: "gpt-6-sol" },
		{ provider: "openai-codex", id: "gpt-5.3-codex" },
		{ provider: "openai-codex", id: "gpt-6" },
		{ provider: "openai-codex", id: "gpt-6-future" },
		{ provider: "openai-codex", id: "gpt-6-sol-preview" },
		{ provider: "openai-codex", id: "gpt-6x" },
		{ provider: "openai-codex", id: "gpt-6.sol" },
		{ provider: "anthropic", id: "claude-opus-4-6" },
	])("rejects $provider/$id", (model) => {
		expect(isFastEligible(model)).toBe(false);
	});
});

describe("getFastCreditMultiplier", () => {
	it("uses the documented GPT-5.4 multiplier", () => {
		expect(getFastCreditMultiplier(codex("gpt-5.4"))).toBe(2);
	});

	it.each(["gpt-5.5", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra"])(
		"uses the documented multiplier for %s",
		(id) => {
			expect(getFastCreditMultiplier(codex(id))).toBe(2.5);
		},
	);
	it.each(["gpt-6", "gpt-6-future", "gpt-6-sol-preview"])(
		"does not estimate cost or speed for unsupported %s",
		(id) => {
			expect(getFastCreditMultiplier(codex(id))).toBeUndefined();
			expect(getFastSpeedMultiplier(codex(id))).toBeUndefined();
		},
	);
	it("does not claim a published speed multiplier for GPT-6", () => {
		expect(getFastSpeedMultiplier(codex("gpt-6-sol"))).toBeUndefined();
		expect(getFastSpeedMultiplier(codex("gpt-5.6-sol"))).toBe(1.5);
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
	it("returns the original payload when disabled", () => {
		const payload = { model: "gpt-6-sol" };
		const result = applyFastServiceTier(payload, false, codex("gpt-6-sol"));
		expect(result).toEqual({ applied: false, payload, reason: "disabled" });
	});

	it("returns the original payload for an unsupported provider", () => {
		const payload = { model: "gpt-6-sol" };
		const result = applyFastServiceTier(payload, true, {
			provider: "openai",
			id: "gpt-6-sol",
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

	it.each(["gpt-6-sol", "gpt-6-luna", "gpt-6-astra"])("adds priority for %s", (id) => {
		const payload = { model: id };
		const result = applyFastServiceTier(payload, true, codex(id));
		expect(result.applied).toBe(true);
		if (!result.applied) throw new Error("Expected Fast mode to apply");
		expect(result.payload).toEqual({ model: id, service_tier: "priority" });
		expect(payload).not.toHaveProperty("service_tier");
	});

	it.each(["gpt-6", "gpt-6-future", "gpt-6-sol-preview"])(
		"does not modify unsupported %s requests",
		(id) => {
			const payload = { model: id };
			expect(applyFastServiceTier(payload, true, codex(id))).toEqual({
				applied: false,
				payload,
				reason: "unsupported-model",
			});
		},
	);

	it("rejects invalid GPT-6 provider payloads", () => {
		const result = applyFastServiceTier(null, true, codex("gpt-6-luna"));
		expect(result).toEqual({ applied: false, payload: null, reason: "invalid-payload" });
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
