/**
 * Tests for the compaction watchdog.
 *
 * Offline only: every source is a plain async generator, no CodeBuddy auth and
 * no child process. Covers the three ways a summarizer run must be able to end
 * — completion, Esc, and a deadline — plus the timer-leak and
 * release-the-generator guarantees the old `for await` loop got wrong.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { consumeWithWatchdog, describeSummaryStop } from "../src/summary-guard.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Yields `messages`, then completes. */
async function* finite(messages, { delayMs = 0 } = {}) {
	for (const m of messages) {
		if (delayMs) await sleep(delayMs);
		yield m;
	}
}

/** Yields one message, then never completes and never yields again. */
async function* silentAfterFirst(message) {
	yield message;
	await new Promise(() => {}); // parks forever, like a wedged CLI
}

/** Never yields anything. */
async function* mute() {
	await new Promise(() => {});
}

describe("consumeWithWatchdog", () => {
	it("reports completed and delivers every message in order", async () => {
		const seen = [];
		const stop = await consumeWithWatchdog(finite([{ i: 1 }, { i: 2 }, { i: 3 }]), {
			onMessage: (m) => seen.push(m.i),
		});
		assert.deepEqual(stop, { kind: "completed" });
		assert.deepEqual(seen, [1, 2, 3]);
	});

	it("calls onFirstEvent exactly once, before later messages", async () => {
		const order = [];
		await consumeWithWatchdog(finite([{ i: 1 }, { i: 2 }]), {
			onFirstEvent: () => order.push("first"),
			onMessage: (m) => order.push(`msg${m.i}`),
		});
		assert.deepEqual(order, ["first", "msg1", "msg2"]);
	});

	it("returns immediately for an already-aborted signal", async () => {
		const ac = new AbortController();
		ac.abort();
		const stop = await consumeWithWatchdog(mute(), { signal: ac.signal });
		assert.equal(stop.kind, "aborted");
	});

	it("aborts a generator that is parked inside next() (the Esc regression)", async () => {
		// The old loop could only notice an abort after a message arrived, so a
		// CLI that had gone silent left it waiting forever.
		const ac = new AbortController();
		const run = consumeWithWatchdog(mute(), { signal: ac.signal });
		await sleep(30);
		ac.abort();
		const stop = await Promise.race([run, sleep(1000).then(() => "HUNG")]);
		assert.deepEqual(stop, { kind: "aborted" });
	});

	it("fires the first-event deadline when the CLI never speaks", async () => {
		const stop = await consumeWithWatchdog(mute(), { firstEventTimeoutMs: 40 });
		assert.equal(stop.kind, "first-event-timeout");
		assert.ok(stop.waitedMs >= 30, `expected waitedMs to reflect the wait, got ${stop.waitedMs}`);
	});

	it("clears the first-event deadline once the CLI has spoken", async () => {
		// A slow-but-alive CLI must not be killed by the first-event budget.
		const stop = await consumeWithWatchdog(finite([{ i: 1 }], { delayMs: 20 }), {
			firstEventTimeoutMs: 60,
			totalTimeoutMs: 400,
		});
		assert.equal(stop.kind, "completed");
	});

	it("fires the total deadline on a CLI that spoke but never finished", async () => {
		const stop = await consumeWithWatchdog(silentAfterFirst({ i: 1 }), { totalTimeoutMs: 50 });
		assert.equal(stop.kind, "timeout");
		assert.ok(stop.elapsedMs >= 40, `expected elapsedMs to reflect the run, got ${stop.elapsedMs}`);
	});

	it("prefers the first-event deadline when both would fire together", async () => {
		const stop = await consumeWithWatchdog(mute(), { firstEventTimeoutMs: 30, totalTimeoutMs: 30 });
		assert.equal(stop.kind, "first-event-timeout");
	});

	it("asks the iterator to release itself on an early stop", async () => {
		// A generator parked inside `await` cannot be closed until that await
		// settles, so the guarantee is that return() is *called* — reaping the
		// child process is the caller's job (endQuery).
		let returnCalls = 0;
		let index = 0;
		const source = {
			[Symbol.asyncIterator]() {
				return {
					next: async () => {
						index += 1;
						if (index === 1) return { done: false, value: { i: 1 } };
						return new Promise(() => {}); // wedged
					},
					return: async () => {
						returnCalls += 1;
						return { done: true, value: undefined };
					},
				};
			},
		};
		const stop = await consumeWithWatchdog(source, { totalTimeoutMs: 40 });
		assert.equal(stop.kind, "timeout");
		await sleep(20);
		assert.equal(returnCalls, 1, "iterator.return() must be called exactly once");
	});

	it("does not leave a pending timer behind after completing", async () => {
		// A leaked total-timeout timer would keep the event loop alive for the
		// full budget after a fast run.
		const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
		await consumeWithWatchdog(finite([{ i: 1 }]), { firstEventTimeoutMs: 5000, totalTimeoutMs: 5000 });
		await sleep(10);
		const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
		assert.ok(after <= before, `expected no net timer growth, before=${before} after=${after}`);
	});

	it("works with no options at all", async () => {
		const stop = await consumeWithWatchdog(finite([{ i: 1 }]));
		assert.deepEqual(stop, { kind: "completed" });
	});

	it("propagates a throwing source as a rejection", async () => {
		await assert.rejects(
			consumeWithWatchdog((async function* () {
				yield { i: 1 };
				throw new Error("boom");
			})(), {}),
			/boom/,
		);
	});
});

describe("describeSummaryStop", () => {
	it("explains each failure mode with an actionable next step", () => {
		assert.match(describeSummaryStop({ kind: "aborted" }), /aborted/i);
		assert.match(describeSummaryStop({ kind: "first-event-timeout", waitedMs: 120_000 }), /120s/);
		assert.match(describeSummaryStop({ kind: "first-event-timeout", waitedMs: 120_000 }), /CODEBUDDY_SDK_DEBUG/);
		assert.match(describeSummaryStop({ kind: "timeout", elapsedMs: 600_000 }), /600s/);
		assert.match(describeSummaryStop({ kind: "timeout", elapsedMs: 600_000 }), /summaryTotalTimeoutMs/);
	});
});
