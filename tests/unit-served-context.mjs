/**
 * Tests for learned context windows.
 *
 * Offline and filesystem-free: the cache path is injected via
 * CODEBUDDY_SDK_SERVED_PATH and the in-process cache is cleared per test, so
 * nothing here touches ~/.pi.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyServedWindows, readServedWindows, recordServedWindow } from "../src/served-context.js";
import { buildModels, rawModelsFromSdk } from "../src/models.js";

const CACHE_KEY = Symbol.for("codebuddy-sdk:servedWindows");
let dir;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cb-served-"));
	process.env.CODEBUDDY_SDK_SERVED_PATH = join(dir, "served.json");
	globalThis[CACHE_KEY] = undefined;
});

const m = (id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

describe("recordServedWindow", () => {
	it("stores a plausible window and reads it back", () => {
		recordServedWindow("hy3", { contextWindow: 1_000_000, maxOutputTokens: 128_000 }, 1000);
		assert.equal(readServedWindows().hy3.contextWindow, 1_000_000);
		assert.equal(readServedWindows().hy3.maxOutputTokens, 128_000);
		assert.equal(readServedWindows().hy3.observedAt, 1000);
	});

	it("survives a new process's worth of cache (writes real JSON)", () => {
		recordServedWindow("deepseek-v4.1-flash", { contextWindow: 1_000_000, maxOutputTokens: 128_000 });
		globalThis[CACHE_KEY] = undefined; // simulate a fresh pi process
		assert.equal(readServedWindows()["deepseek-v4.1-flash"].contextWindow, 1_000_000);
	});

	it("rejects windows too small or too large to be real", () => {
		for (const bad of [0, -1, 1024, 4096, 9e9, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.equal(recordServedWindow("hy3", { contextWindow: bad }), undefined, `accepted ${bad}`);
		}
		assert.deepEqual(readServedWindows(), {});
	});

	it("keeps a previously learned maxOutputTokens when a later report omits it", () => {
		recordServedWindow("hy3", { contextWindow: 1_000_000, maxOutputTokens: 128_000 });
		recordServedWindow("hy3", { contextWindow: 1_000_000 });
		assert.equal(readServedWindows().hy3.maxOutputTokens, 128_000);
	});

	it("re-reads a corrupt cache file as empty rather than throwing", () => {
		writeFileSync(join(dir, "served.json"), "{not json");
		globalThis[CACHE_KEY] = undefined;
		assert.deepEqual(readServedWindows(), {});
	});
});

describe("applyServedWindows", () => {
	it("replaces a guessed window and maxTokens with what the CLI served", () => {
		const out = applyServedWindows([m("hy3")], { hy3: { contextWindow: 1_000_000, maxOutputTokens: 128_000, observedAt: 1 } });
		assert.equal(out[0].contextWindow, 1_000_000);
		assert.equal(out[0].maxTokens, 128_000);
	});

	it("leaves maxTokens alone when only the window was learned", () => {
		const out = applyServedWindows([m("hy3")], { hy3: { contextWindow: 1_000_000, observedAt: 1 } });
		assert.equal(out[0].maxTokens, 8192);
	});

	it("leaves unlearned models untouched", () => {
		const models = [m("hy3"), m("kimi-k3")];
		const out = applyServedWindows(models, { hy3: { contextWindow: 1_000_000, observedAt: 1 } });
		assert.equal(out[1].contextWindow, 131072);
		assert.equal(out[1].maxTokens, 8192);
	});
});

describe("buildModels precedence", () => {
	const served = { hy3: { contextWindow: 1_000_000, maxOutputTokens: 128_000, observedAt: 1 } };

	it("served beats the name-based estimate", () => {
		const out = buildModels([m("hy3")], undefined, undefined, served);
		assert.equal(out[0].contextWindow, 1_000_000);
		assert.equal(out[0].maxTokens, 128_000);
	});

	it("a per-model config override beats served", () => {
		const out = buildModels([m("hy3")], undefined, { hy3: { contextWindow: 4096 } }, served);
		assert.equal(out[0].contextWindow, 4096, "an explicit user override must not be overwritten by a learned value");
	});

	it("a global config override beats served", () => {
		const out = buildModels([m("hy3")], { contextWindow: 8192 }, undefined, served);
		assert.equal(out[0].contextWindow, 8192);
	});

	it("without served, every model registers the wide default", () => {
		const out = buildModels(rawModelsFromSdk([{ id: "hy3", name: "Hy3" }, { id: "gpt-5.6-sol", name: "GPT" }]));
		// No name branch: `hy3` serves 192k and `hy4-preview` serves 1M, so a
		// family guess is not evidence. Wide until the CLI narrows it.
		assert.equal(out.find((x) => x.id === "hy3").contextWindow, 1_048_576);
		assert.equal(out.find((x) => x.id === "gpt-5.6-sol").contextWindow, 1_048_576);
	});

	it("a learned window survives a cache round-trip through the models cache path", () => {
		recordServedWindow("hy3", { contextWindow: 1_000_000, maxOutputTokens: 128_000 });
		const cached = JSON.parse(JSON.stringify([m("hy3")])); // cache stores built models
		const out = applyServedWindows(cached, readServedWindows());
		assert.equal(out[0].contextWindow, 1_000_000);
	});
});
