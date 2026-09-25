/**
 * Tests for CodeBuddy CLI path resolution.
 *
 * Offline and filesystem-free: every candidate's existence and symlink target
 * comes from injected `exists`/`realpath` maps, so the nvm-shim case is proven
 * without touching a real install.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSpawnableCli, sdkSpawnTarget } from "../src/cli-path.js";

/** Build a fake filesystem: keys are the paths that exist, values their realpath. */
function fsDeps(paths, { env = {} } = {}) {
	const exists = (p) => Object.hasOwn(paths, p);
	const realpath = (p) => {
		if (!Object.hasOwn(paths, p)) throw new Error(`ENOENT: ${p}`);
		return paths[p];
	};
	return { exists, realpath, env };
}

const SHIM = "/nvm/v/bin/codebuddy";
const REAL_BIN = "/nvm/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy";
const REAL_HEADLESS = "/nvm/lib/node_modules/@tencent-ai/codebuddy-code/dist/codebuddy-headless.js";

describe("sdkSpawnTarget", () => {
	it("rewrites a bin/codebuddy path to the sibling headless script", () => {
		assert.equal(sdkSpawnTarget(REAL_BIN), REAL_HEADLESS);
	});

	it("leaves a path that is not a bin/codebuddy shim alone", () => {
		assert.equal(sdkSpawnTarget("/opt/codebuddy/codebuddy"), "/opt/codebuddy/codebuddy");
	});

	it("keeps the .exe suffix handling in sync with the SDK", () => {
		assert.equal(sdkSpawnTarget("C:/x/bin/codebuddy.exe"), "C:/x/dist/codebuddy-headless.js");
	});
});

describe("resolveSpawnableCli", () => {
	it("follows an nvm shim to the package bin whose dist/ exists", () => {
		// The exact trap: the shim dir has no dist/, the real package does.
		const result = resolveSpawnableCli(SHIM, fsDeps({ [SHIM]: REAL_BIN, [REAL_BIN]: REAL_BIN, [REAL_HEADLESS]: REAL_HEADLESS }));
		assert.equal(result.kind, "ok");
		assert.equal(result.path, REAL_BIN);
		assert.equal(result.rewrittenTo, REAL_HEADLESS);
		assert.equal(result.source, "configured");
	});

	it("skips a candidate whose rewritten target is missing", () => {
		const orphan = "/broken/bin/codebuddy";
		const result = resolveSpawnableCli(orphan, fsDeps({
			[orphan]: orphan,
			[SHIM]: REAL_BIN,
			[REAL_BIN]: REAL_BIN,
			[REAL_HEADLESS]: REAL_HEADLESS,
		}, { env: { PATH: "/nvm/v/bin" } }));
		assert.equal(result.kind, "ok");
		assert.equal(result.path, REAL_BIN, "must fall through to the PATH candidate");
		assert.equal(result.source, "path");
	});

	it("resolves from PATH when nothing is configured", () => {
		const result = resolveSpawnableCli(undefined, fsDeps({
			[SHIM]: REAL_BIN,
			[REAL_BIN]: REAL_BIN,
			[REAL_HEADLESS]: REAL_HEADLESS,
		}, { env: { PATH: "/usr/bin:/nvm/v/bin" } }));
		assert.equal(result.kind, "ok");
		assert.equal(result.source, "path");
	});

	it("prefers an explicit config over PATH", () => {
		const configured = "/opt/cb/bin/codebuddy";
		const configuredHeadless = "/opt/cb/dist/codebuddy-headless.js";
		const result = resolveSpawnableCli(configured, fsDeps({
			[configured]: configured,
			[configuredHeadless]: configuredHeadless,
			[SHIM]: REAL_BIN,
			[REAL_BIN]: REAL_BIN,
			[REAL_HEADLESS]: REAL_HEADLESS,
		}, { env: { PATH: "/nvm/v/bin" } }));
		assert.equal(result.path, configured);
		assert.equal(result.source, "configured");
	});

	it("accepts a directly executable path that needs no rewrite", () => {
		const native = "/opt/codebuddy/native/codebuddy";
		const result = resolveSpawnableCli(native, fsDeps({ [native]: native }));
		assert.equal(result.kind, "ok");
		assert.equal(result.path, native);
		assert.equal(result.rewrittenTo, native);
	});

	it("reports an actionable error when nothing is runnable", () => {
		const result = resolveSpawnableCli("/nope/bin/codebuddy", fsDeps({}, { env: {} }));
		assert.equal(result.kind, "error");
		assert.match(result.reason, /codebuddy-headless\.js/);
		assert.match(result.reason, /pathToCodebuddyCode/);
		assert.ok(result.checked.includes("/nope/bin/codebuddy"), "the failing candidate must be reported");
	});

	it("keeps a broken symlink from winning over a good candidate", () => {
		const dangling = "/stale/bin/codebuddy";
		const result = resolveSpawnableCli(dangling, fsDeps({
			[dangling]: dangling, // exists, but realpath throws
			[SHIM]: REAL_BIN,
			[REAL_BIN]: REAL_BIN,
			[REAL_HEADLESS]: REAL_HEADLESS,
		}, { env: { PATH: "/nvm/v/bin" } }));
		assert.equal(result.kind, "ok");
		assert.equal(result.source, "path");
	});

	it("resolves on this machine (real filesystem)", () => {
		// The default deps must find a genuinely spawnable CLI here, otherwise
		// every user on an nvm install hits the transport-close error.
		const result = resolveSpawnableCli(undefined);
		assert.equal(result.kind, "ok", `expected a runnable CLI, got: ${result.kind === "error" ? result.reason : "?"}`);
		assert.ok(result.rewrittenTo.endsWith("codebuddy-headless.js"));
	});
});
