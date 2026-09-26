#!/usr/bin/env node
// Unit tests for the context-size rule (context-tokens.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { estimatePiContextTokens } from "../src/context-tokens.js";

const msg = (role, text) => ({ role, content: [{ type: "text", text }] });

describe("estimatePiContextTokens", () => {
	it("sums the system prompt and every non-system message", () => {
		const messages = [msg("user", "hello"), msg("assistant", "hi there")];
		const expected = estimateTokens({ role: "system", content: "SYS" })
			+ estimateTokens(messages[0]) + estimateTokens(messages[1]);
		assert.equal(estimatePiContextTokens(messages, "SYS"), expected);
	});

	it("skips system messages inside the message list (core does the same)", () => {
		const withSystem = [msg("system", "IGNORED"), msg("user", "hello")];
		assert.equal(estimatePiContextTokens(withSystem, "SYS"), estimatePiContextTokens([msg("user", "hello")], "SYS"));
	});

	it("works with no system prompt", () => {
		assert.equal(estimatePiContextTokens([msg("user", "hello")]), estimateTokens(msg("user", "hello")));
	});

	it("is zero for an empty request", () => {
		assert.equal(estimatePiContextTokens([], undefined), 0);
	});

	it("grows with content, so the gauge tracks real growth", () => {
		const small = estimatePiContextTokens([msg("user", "a".repeat(100))], "S");
		const large = estimatePiContextTokens([msg("user", "a".repeat(10_000))], "S");
		assert.ok(large > small * 5);
	});
});

describe("why this replaces the CLI's number", () => {
	// measured on one real turn: 8,126 tokens of actual content, 27,439 reported
	it("lands near the measured truth, not 3.4x above it", () => {
		const real = Array.from({ length: 40 }, (_, i) => msg(i % 2 ? "assistant" : "user", "x".repeat(400) + i));
		const estimate = estimatePiContextTokens(real, "S".repeat(2000));
		const reported = estimate * 3.38;
		assert.ok(Math.abs(estimate - 8_126) < Math.abs(reported - 8_126));
	});

	it("stays under a slim 272k cap where the CLI's number would not", () => {
		const real = Array.from({ length: 200 }, (_, i) => msg(i % 2 ? "assistant" : "user", "y".repeat(400) + i));
		const estimate = estimatePiContextTokens(real, "S".repeat(2000));
		assert.ok(estimate < 272_000 - 16_384);
	});
});
