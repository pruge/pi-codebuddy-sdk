/**
 * Tests for CodeBuddy model helpers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyWindows, buildModels, codebuddyModelId, rawModelsFromSdk, resolveModel, FALLBACK_MODELS } from "../src/models.js";

describe("rawModelsFromSdk", () => {
	it("maps SDK ModelInfo to pi models", () => {
		const models = rawModelsFromSdk([
			{ value: "hy3-preview-agent-ioa", displayName: "Hunyuan 3", description: "" },
			{ id: "claude-sonnet-4.6", name: "Claude Sonnet", description: "" },
		]);
		assert.equal(models[0].id, "hy3-preview-agent-ioa");
		assert.equal(models[1].input.includes("image"), true);
		assert.deepEqual(models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
});

describe("buildModels", () => {
	it("preserves order from SDK", () => {
		const models = buildModels(rawModelsFromSdk([
			{ value: "model-b", displayName: "B", description: "" },
			{ value: "model-a", displayName: "A", description: "" },
		]));
		assert.deepEqual(models.map((m) => m.id), ["model-b", "model-a"]);
	});

	it("applies global contextWindow/maxTokens overrides", () => {
		const models = buildModels(
			rawModelsFromSdk([{ value: "hy3-preview-agent-ioa", displayName: "H", description: "" }]),
			{ contextWindow: 300_000, maxTokens: 32_768 },
		);
		assert.equal(models[0].contextWindow, 300_000);
		assert.equal(models[0].maxTokens, 32_768);
	});

	it("applies per-model overrides and lets them beat globals", () => {
		const models = buildModels(
			rawModelsFromSdk([
				{ value: "claude-sonnet", displayName: "Sonnet", description: "" },
				{ value: "gpt-5", displayName: "GPT-5", description: "" },
			]),
			{ contextWindow: 200_000 },
			{ "gpt-5": { contextWindow: 1_048_576, maxTokens: 64_000, reasoning: true, images: false } },
		);
		assert.equal(models[0].contextWindow, 200_000); // global applies
		assert.equal(models[1].contextWindow, 1_048_576); // per-model wins
		assert.equal(models[1].maxTokens, 64_000);
		assert.equal(models[1].reasoning, true);
		assert.deepEqual(models[1].input, ["text"]); // images=false
	});

	it("matches per-model override by substring (longest key wins)", () => {
		const models = buildModels(
			rawModelsFromSdk([{ value: "gpt-5-max", displayName: "M", description: "" }]),
			undefined,
			{ gpt: { maxTokens: 8_192 }, "gpt-5-max": { maxTokens: 128_000 } },
		);
		assert.equal(models[0].maxTokens, 128_000);
	});
});

describe("codebuddyModelId", () => {
	it("returns model id unchanged", () => {
		assert.equal(codebuddyModelId({ id: "hy3-preview-agent-ioa" }), "hy3-preview-agent-ioa");
	});
});

describe("resolveModel", () => {
	const models = buildModels(FALLBACK_MODELS);

	it("resolves by partial id", () => {
		assert.equal(resolveModel(models, "hy3")?.id, "hy3-preview-agent-ioa");
	});

	it("returns undefined when no match", () => {
		assert.equal(resolveModel(models, "gpt-9"), undefined);
	});
});

// The window store's own tests live in pi-ctx now. What stays here is the SDK
// side: how learned windows interact with config overrides.
describe("learned windows (applyWindows / buildModels precedence)", () => {
	const m = (id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 1_048_576, maxTokens: 8_192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	const windows = { hy3: { contextWindow: 192_000, maxOutputTokens: 64_000 } };

	it("replaces the fallback window and maxTokens with what pi-ctx learned", () => {
		const out = applyWindows([m("hy3")], windows);
		assert.equal(out[0].contextWindow, 192_000);
		assert.equal(out[0].maxTokens, 64_000);
	});

	it("leaves maxTokens alone when only the window was learned", () => {
		const out = applyWindows([m("hy3")], { hy3: { contextWindow: 192_000 } });
		assert.equal(out[0].maxTokens, 8_192);
	});

	it("leaves unlearned models untouched", () => {
		const out = applyWindows([m("hy3"), m("kimi-k3")], windows);
		assert.equal(out[1].contextWindow, 1_048_576);
		assert.equal(out[1].maxTokens, 8_192);
	});

	it("learned windows beat the fallback", () => {
		const out = buildModels([m("hy3")], undefined, undefined, windows);
		assert.equal(out[0].contextWindow, 192_000);
		assert.equal(out[0].maxTokens, 64_000);
	});

	it("a per-model config override beats learned windows", () => {
		const out = buildModels([m("hy3")], undefined, { hy3: { contextWindow: 4096 } }, windows);
		assert.equal(out[0].contextWindow, 4096, "an explicit user override must not be overwritten by a learned value");
	});

	it("a global config override beats learned windows", () => {
		const out = buildModels([m("hy3")], { contextWindow: 8192 }, undefined, windows);
		assert.equal(out[0].contextWindow, 8192);
	});

	it("without learned windows every model registers the wide fallback", () => {
		const out = buildModels(rawModelsFromSdk([{ id: "hy3", name: "Hy3" }, { id: "gpt-5.6-sol", name: "GPT" }]));
		// No name branch: `hy3` serves 192k and `hy4-preview` serves 1M, so a
		// family guess is not evidence. Wide until pi-ctx narrows it.
		assert.equal(out.find((x) => x.id === "hy3").contextWindow, 1_048_576);
		assert.equal(out.find((x) => x.id === "gpt-5.6-sol").contextWindow, 1_048_576);
	});
});
