/**
 * Tests for the pi-ctx bridge (src/pi-ctx.ts).
 *
 * No process is spawned: the CLI runner is injected, and the in-process state
 * (read cache + one-time warnings) is cleared per test. Nothing here touches
 * ~/.pi or requires pi-ctx to be installed.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { observeWindow, readPiCtxWindows, resolvePiCtxBin } from "../src/pi-ctx.js";

const STATE_KEY = Symbol.for("codebuddy-sdk:piCtxState");
const BIN = "/fake/pi-ctx";

/** A deps bundle with a recording runner and a resolvable fake binary. */
function harness(result = { ok: true, stdout: "{}" }) {
	const calls = [];
	const problems = [];
	const deps = {
		env: { PI_CTX_BIN: BIN, PATH: "" },
		exists: (path) => path === BIN,
		onProblem: (message) => problems.push(message),
		run: async (bin, args) => {
			calls.push({ bin, args });
			return result;
		},
	};
	return { deps, calls, problems };
}

beforeEach(() => {
	globalThis[STATE_KEY] = undefined;
});

describe("resolvePiCtxBin", () => {
	it("prefers PI_CTX_BIN", () => {
		assert.equal(resolvePiCtxBin({ env: { PI_CTX_BIN: "/x/pi-ctx" }, exists: () => true }), "/x/pi-ctx");
	});

	it("falls back to pi-ctx on PATH", () => {
		assert.equal(resolvePiCtxBin({ env: { PATH: "/a:/b" }, exists: (path) => path === "/b/pi-ctx" }), "/b/pi-ctx");
	});

	it("returns undefined when pi-ctx is not installed", () => {
		assert.equal(resolvePiCtxBin({ env: { PATH: "/a:/b" }, exists: () => false }), undefined);
	});

	it("ignores a PI_CTX_BIN that does not exist and keeps looking", () => {
		assert.equal(resolvePiCtxBin({ env: { PI_CTX_BIN: "/nope", PATH: "/b" }, exists: (path) => path === "/b/pi-ctx" }), "/b/pi-ctx");
	});
});

describe("observeWindow", () => {
	it("execs observe with provider, model, window and max-output", async () => {
		const { deps, calls } = harness();
		await observeWindow("hy3", { contextWindow: 192_000, maxOutputTokens: 64_000 }, deps);
		assert.deepEqual(calls, [
			{ bin: BIN, args: ["observe", "--provider", "codebuddy", "--model", "hy3", "--window", "192000", "--max-output", "64000"] },
		]);
	});

	it("omits --max-output when it was not reported", async () => {
		const { deps, calls } = harness();
		await observeWindow("kimi-k3", { contextWindow: 1_000_000 }, deps);
		assert.deepEqual(calls[0].args, ["observe", "--provider", "codebuddy", "--model", "kimi-k3", "--window", "1000000"]);
	});

	it("does not exec for a non-numeric window", async () => {
		const { deps, calls } = harness();
		for (const bad of [undefined, null, "192000", Number.NaN, Number.POSITIVE_INFINITY]) {
			await observeWindow("hy3", { contextWindow: bad }, deps);
		}
		assert.deepEqual(calls, []);
	});

	it("passes an implausible number through: the range is pi-ctx's rule", async () => {
		const { deps, calls } = harness();
		await observeWindow("hy3", { contextWindow: 10 }, deps);
		assert.deepEqual(calls[0].args, ["observe", "--provider", "codebuddy", "--model", "hy3", "--window", "10"]);
	});

	it("survives a failed exec and reports the problem once", async () => {
		const { deps, problems } = harness({ ok: false, stdout: "", reason: "boom" });
		await observeWindow("hy3", { contextWindow: 192_000 }, deps);
		await observeWindow("hy3", { contextWindow: 192_000 }, deps);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /pi-ctx observe failed/);
	});

	it("survives a missing pi-ctx without executing anything", async () => {
		const { deps, calls, problems } = harness();
		deps.env = { PATH: "" };
		deps.exists = () => false;
		await observeWindow("hy3", { contextWindow: 192_000 }, deps);
		assert.deepEqual(calls, []);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /not found/);
	});
});

describe("readPiCtxWindows", () => {
	it("parses the windows out of status --json", async () => {
		const { deps } = harness({
			ok: true,
			stdout: JSON.stringify({ path: "/p", windows: { "codebuddy/hy3": { contextWindow: 192_000 } } }),
		});
		assert.deepEqual(await readPiCtxWindows(deps), { "codebuddy/hy3": { contextWindow: 192_000 } });
	});

	it("execs status --json only once per process", async () => {
		const { deps, calls } = harness({ ok: true, stdout: JSON.stringify({ windows: {} }) });
		await readPiCtxWindows(deps);
		await readPiCtxWindows(deps);
		assert.deepEqual(calls.map((c) => c.args), [["status", "--json"]]);
	});

	it("returns an empty list when pi-ctx is missing", async () => {
		const { deps, calls } = harness();
		deps.env = { PATH: "" };
		deps.exists = () => false;
		assert.deepEqual(await readPiCtxWindows(deps), {});
		assert.deepEqual(calls, []);
	});

	it("returns an empty list on a failed exec", async () => {
		const { deps } = harness({ ok: false, stdout: "", reason: "boom" });
		assert.deepEqual(await readPiCtxWindows(deps), {});
	});

	it("returns an empty list on unparseable JSON", async () => {
		const { deps, problems } = harness({ ok: true, stdout: "{not json" });
		assert.deepEqual(await readPiCtxWindows(deps), {});
		assert.equal(problems.length, 1);
	});

	it("returns an empty list when windows is not an object", async () => {
		const { deps } = harness({ ok: true, stdout: JSON.stringify({ windows: [1, 2] }) });
		assert.deepEqual(await readPiCtxWindows(deps), {});
	});
});
