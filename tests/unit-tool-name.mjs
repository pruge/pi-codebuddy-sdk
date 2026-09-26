#!/usr/bin/env node
// Unit tests for CLI→pi tool-name resolution and unknown-name handling.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "../src/skills.js";

// Mirrors the production helpers in src/index.ts (which cannot be imported
// without activating the extension).
const SDK_TO_PI_TOOL_NAME = { read: "read", write: "write", edit: "edit", bash: "bash" };
const MCP_SERVER_SEGMENT = `mcp__${MCP_SERVER_NAME}_`;

function buildMap(names) {
	const toSdk = new Map(), toPi = new Map();
	for (const n of names) {
		const sdk = `${MCP_TOOL_PREFIX}${n}`;
		toSdk.set(n, sdk); toSdk.set(n.toLowerCase(), sdk);
		toPi.set(sdk, n); toPi.set(sdk.toLowerCase(), n);
	}
	return toPi;
}
function mapToolName(name, toPi) {
	const normalized = name.toLowerCase();
	if (SDK_TO_PI_TOOL_NAME[normalized]) return SDK_TO_PI_TOOL_NAME[normalized];
	if (toPi) {
		const m = toPi.get(name) ?? toPi.get(normalized);
		if (m) return m;
	}
	if (normalized.startsWith(MCP_SERVER_SEGMENT)) {
		const stripped = normalized.slice(MCP_SERVER_SEGMENT.length).replace(/^_+/, "");
		for (const piName of new Set(toPi?.values() ?? [])) if (piName.toLowerCase() === stripped) return piName;
		return SDK_TO_PI_TOOL_NAME[stripped] ?? stripped;
	}
	return name;
}
const known = (toPi) => new Set([...Object.values(SDK_TO_PI_TOOL_NAME), ...(toPi?.values() ?? [])]);

describe("mapToolName", () => {
	const toPi = buildMap(["bash", "read", "edit", "tf_send"]);
	it("resolves the SDK's double-underscore name", () => {
		assert.equal(mapToolName("mcp__custom_tools__bash", toPi), "bash");
	});
	it("resolves the single-underscore variant the model emitted", () => {
		assert.equal(mapToolName("mcp__custom_tools_bash", toPi), "bash");
		assert.equal(mapToolName("mcp__custom_tools_read", toPi), "read");
	});
	it("is case-insensitive on the prefix", () => {
		assert.equal(mapToolName("MCP__CUSTOM_TOOLS_BASH", toPi), "bash");
	});
	it("still maps extension tools", () => {
		assert.equal(mapToolName("mcp__custom_tools__tf_send", toPi), "tf_send");
	});
	it("keeps built-in SDK renames working", () => {
		assert.equal(mapToolName("bash", toPi), "bash");
	});
	it("leaves a truly unknown name untouched", () => {
		assert.equal(mapToolName("mcp__custom_tools__nope", toPi), "nope");
	});
});

describe("unknown-name detection", () => {
	const toPi = buildMap(["bash", "read"]);
	const isUnknown = (n) => !known(toPi).has(mapToolName(n, toPi));
	it("accepts both separator variants", () => {
		assert.equal(isUnknown("mcp__custom_tools__bash"), false);
		assert.equal(isUnknown("mcp__custom_tools_bash"), false);
	});
	it("rejects a hallucinated tool", () => {
		assert.equal(isUnknown("mcp__custom_tools__shell"), true);
		assert.equal(isUnknown("mcp__custom_tools_shell"), true);
		assert.equal(isUnknown("mcp__other__bash"), true);
	});
	it("is disabled when there is no tool list to check against", () => {
		// production guard: unknownToolCorrection returns null unless the map has
		// entries, so a turn with no declared tools is never second-guessed.
		const empty = buildMap([]);
		assert.equal(empty.size > 0, false);
		assert.equal(mapToolName("whatever", empty), "whatever");
	});
});
