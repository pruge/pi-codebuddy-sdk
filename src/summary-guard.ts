// Bounded consumption of the CodeBuddy CLI message stream.
//
// The SDK's `Query` is an async generator backed by a child process speaking
// ndJSON over stdio. Two properties of that transport make a bare
// `for await (const m of query)` loop unsafe as a control path:
//
//   1. The prompt write is fire-and-forget. `Query.sendPrompt()` calls
//      `transport.sendUserMessage()`, which only writes a line to the child's
//      stdin. There is no acknowledgement, so a child that never consumes the
//      line is indistinguishable from a slow one.
//   2. Nothing bounds the wait. The SDK's only built-in deadline is the 60s
//      timeout on `initialize`'s control request; the model turn itself has no
//      timeout at all.
//
// When those combine, both sides wait forever: the child sits idle with no
// socket open, the parent sits in `await iterator.next()`. Nothing rejects, so
// pi's retry helper never sees a failure either — silence is not a rejection.
//
// This module consumes the stream with three independent stop sources so a
// wedged child can never hold a turn open indefinitely:
//
//   - the caller's AbortSignal (Esc during a compaction),
//   - a first-event deadline (the child started but never spoke),
//   - a total-runtime deadline (the child spoke but never finished).
//
// Each `iterator.next()` is raced against the stop promise, so an abort lands
// even while we are parked inside `next()` — the case the old
// `if (wasAborted) break` check could never reach, because it only ran after a
// message arrived.

/** Why consumption stopped. */
export type SummaryStopKind = "completed" | "aborted" | "first-event-timeout" | "timeout";

export type SummaryStop =
	| { kind: "completed" }
	| { kind: "aborted" }
	| { kind: "first-event-timeout"; waitedMs: number }
	| { kind: "timeout"; elapsedMs: number };

export type SummaryWatchdogOptions<T> = {
	/** Deadline for the first message. Omit to disable. */
	firstEventTimeoutMs?: number;
	/** Deadline for the whole run, first event or not. Omit to disable. */
	totalTimeoutMs?: number;
	/** Caller abort (Esc). An already-aborted signal returns immediately. */
	signal?: AbortSignal;
	/** Called once, synchronously, for every message the CLI emitted. */
	onMessage?: (message: T) => void;
	/** Called when the first message arrives, for progress reporting. */
	onFirstEvent?: () => void;
};

/** One iteration of the source, or the stop signal winning the race. */
type StreamStep<T> = { kind: "message"; value: T } | { kind: "done" } | { kind: "stop" };

/**
 * Drain `source`, returning as soon as it ends or a stop source fires.
 *
 * On a non-`completed` stop the underlying iterator is released without being
 * awaited — the caller owns child teardown via `endQuery()`, and awaiting
 * `return()` here would park us on the same wedged child we are escaping.
 */
export async function consumeWithWatchdog<T>(
	source: AsyncIterable<T>,
	options: SummaryWatchdogOptions<T> = {},
): Promise<SummaryStop> {
	const startedAt = Date.now();
	const { signal } = options;
	if (signal?.aborted) return { kind: "aborted" };

	const iterator = source[Symbol.asyncIterator]();
	let stopKind: Exclude<SummaryStopKind, "completed"> | undefined;
	let firstEventTimer: ReturnType<typeof setTimeout> | undefined;
	let totalTimer: ReturnType<typeof setTimeout> | undefined;
	let settledEarly = false;

	let resolveStopped: () => void = () => {};
	const stopped = new Promise<void>((resolve) => {
		resolveStopped = resolve;
	});
	const requestStop = (kind: Exclude<SummaryStopKind, "completed">) => {
		if (stopKind !== undefined) return;
		stopKind = kind;
		resolveStopped();
	};

	const onAbort = () => requestStop("aborted");
	signal?.addEventListener("abort", onAbort, { once: true });

	if (options.firstEventTimeoutMs !== undefined) {
		firstEventTimer = setTimeout(() => requestStop("first-event-timeout"), options.firstEventTimeoutMs);
	}
	if (options.totalTimeoutMs !== undefined) {
		totalTimer = setTimeout(() => requestStop("timeout"), options.totalTimeoutMs);
	}

	try {
		let sawFirstEvent = false;
		for (;;) {
			const nextStep: Promise<StreamStep<T>> = iterator.next().then((result) =>
				result.done ? { kind: "done" } : { kind: "message", value: result.value },
			);
			const step = await Promise.race([nextStep, stopped.then((): StreamStep<T> => ({ kind: "stop" }))]);

			if (step.kind === "stop") {
				settledEarly = true;
				break;
			}
			if (step.kind === "done") return { kind: "completed" };

			if (!sawFirstEvent) {
				sawFirstEvent = true;
				if (firstEventTimer !== undefined) {
					clearTimeout(firstEventTimer);
					firstEventTimer = undefined;
				}
				options.onFirstEvent?.();
			}
			options.onMessage?.(step.value);
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (firstEventTimer !== undefined) clearTimeout(firstEventTimer);
		if (totalTimer !== undefined) clearTimeout(totalTimer);
		if (settledEarly) {
			// Ask the iterator to release itself without waiting: a generator parked
			// inside `await` cannot be closed until that await settles, which is
			// exactly the situation we are escaping. Reaping the child process is
			// the caller's job via endQuery().
			try {
				void iterator.return?.();
			} catch {
				// Nothing to do — teardown belongs to the caller.
			}
		}
	}

	const elapsedMs = Date.now() - startedAt;
	return stopKind === "first-event-timeout"
		? { kind: "first-event-timeout", waitedMs: elapsedMs }
		: stopKind === "timeout"
			? { kind: "timeout", elapsedMs }
			: { kind: "aborted" };
}

/** Human-facing reason for a non-`completed` stop, used for the error message. */
export function describeSummaryStop(stop: Exclude<SummaryStop, { kind: "completed" }>): string {
	switch (stop.kind) {
		case "aborted":
			return "Operation aborted";
		case "first-event-timeout":
			return (
				`CodeBuddy CLI produced no output within ${Math.round(stop.waitedMs / 1000)}s. ` +
				`The CLI subprocess most likely never consumed the summarization prompt. ` +
				`Retry, switch model, or set CODEBUDDY_SDK_DEBUG=1 and share the log if it repeats.`
			);
		case "timeout":
			return (
				`CodeBuddy CLI did not finish summarizing within ${Math.round(stop.elapsedMs / 1000)}s. ` +
				`The conversation is large enough that one summarization pass exceeds the budget. ` +
				`Raise provider.summaryTotalTimeoutMs, switch model, or start a new session.`
			);
	}
}
