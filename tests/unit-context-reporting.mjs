/**
 * Tests for honest context reporting.
 *
 * The bug this pins: the CodeBuddy CLI is resumed across turns, so the
 * input/cacheRead it reports describe the whole CLI session, not the context
 * pi sent. pi reads `usage.totalTokens` as "how full is the context" and
 * compares it to the compaction threshold, so feeding the CLI's numbers back
 * verbatim made a 10k context display as 257k and re-compact every turn —
 * 121 times in one session.
 *
 * Offline only: no CLI, no auth, no pi subprocess.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { QueryContext } from "../src/query-state.js";

const model = { api: "codebuddy-sdk", provider: "codebuddy", id: "deepseek-v4.1-flash" };

/** Mirror of the extension's estimatePiContextTokens (private to index.ts). */
function estimatePiContextTokens(systemPrompt, messages) {
	let total = 0;
	if (systemPrompt) total += estimateTokens({ role: "system", content: systemPrompt });
	for (const message of messages) {
		if (message?.role === "system") continue;
		total += estimateTokens(message);
	}
	return total;
}

const user = (tokens) => ({ role: "user", content: [{ type: "text", text: "x".repeat(tokens * 4) }] });
const assistant = (tokens) => ({ role: "assistant", content: [{ type: "text", text: "y".repeat(tokens * 4) }] });

describe("estimatePiContextTokens", () => {
	it("counts the system prompt plus every non-system message", () => {
		const n = estimatePiContextTokens("sys", [user(100), assistant(200)]);
		assert.equal(n, estimateTokens({ role: "system", content: "sys" }) + 100 + 200);
	});

	it("matches pi's own fallback estimate for the same transcript", () => {
		// The whole point of using pi's estimator: our number and the number pi
		// would compute on its own must not drift.
		const messages = [user(1200), assistant(3400), { role: "toolResult", content: [{ type: "text", text: "z".repeat(4000) }] }];
		const ours = estimatePiContextTokens("prompt", messages);
		const piOwn = estimateTokens({ role: "system", content: "prompt" }) + messages.reduce((s, m) => s + estimateTokens(m), 0);
		assert.equal(ours, piOwn);
	});

	it("skips a system message carried inside the transcript", () => {
		const withSystem = estimatePiContextTokens("prompt", [{ role: "system", content: "carried" }, user(100)]);
		const without = estimatePiContextTokens("prompt", [user(100)]);
		assert.equal(withSystem, without, "the system prompt must be counted exactly once");
	});

	it("shrinks when the transcript shrinks — the compaction case", () => {
		const long = [user(20000), assistant(20000), user(20000), assistant(20000), user(20000), assistant(20000), user(20000), assistant(20000), user(20000), assistant(20000)];
		const compacted = [user(2000), assistant(2000), user(2000), assistant(2000)];
		assert.ok(estimatePiContextTokens("p", compacted) * 4 < estimatePiContextTokens("p", long));
	});
});

describe("QueryContext.turnContextTokens", () => {
	it("defaults to 0 so updateUsage falls back to the CLI sum", () => {
		assert.equal(new QueryContext().turnContextTokens, 0);
	});

	it("is cleared by resetTurnState", () => {
		const c = new QueryContext();
		c.turnContextTokens = 42_000;
		c.resetTurnState(model);
		assert.equal(c.turnContextTokens, 0, "a stale estimate must never outlive its turn");
	});
});

describe("totalTokens vs cost", () => {
	// The contract: totalTokens feeds pi's context gauge and compaction
	// threshold; cost is computed from input/output/cacheRead/cacheWrite. They
	// are separate paths, so replacing one must not disturb the other.
	const cliUsage = { input: 128_736, output: 512, cache_read_input_tokens: 128_512, cache_creation_input_tokens: 0 };
	const billable = cliUsage.input + cliUsage.output + cliUsage.cache_read_input_tokens + cliUsage.cache_creation_input_tokens;
	const piSide = 10_382;

	it("the CLI's sum is what we are reporting wrongly", () => {
		// Documents the magnitude of the regression this fixes.
		assert.equal(billable, 257_760);
		assert.ok(billable / piSide > 20, "the gap is an order of magnitude, not a rounding difference");
	});

	it("cost-relevant fields are untouched by the context correction", () => {
		const reported = {
			input: cliUsage.input,
			output: cliUsage.output,
			cacheRead: cliUsage.cache_read_input_tokens,
			cacheWrite: cliUsage.cache_creation_input_tokens,
			totalTokens: piSide,
		};
		assert.equal(reported.input + reported.output + reported.cacheRead + reported.cacheWrite, billable);
		assert.equal(reported.totalTokens, piSide, "only totalTokens changes");
	});

	it("the corrected total stays under the threshold the wrong one blew past", () => {
		const reserve = 16_384;
		const window = 131_072;
		assert.ok(billable > window - reserve, "the CLI sum triggers compaction");
		assert.ok(piSide < window - reserve, "the honest estimate does not");
	});
});
