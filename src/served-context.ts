// Learned context windows, straight from the CodeBuddy CLI.
//
// `@tencent-ai/agent-sdk`'s model list is `{id, name}` and nothing else — it
// carries no window sizes at all. So `estimateContext()` has to guess from the
// model id, and it only knows three families:
//
//   gemini          → 1_048_576
//   claude, gpt     → 200_000
//   everything else → DEFAULT_CONTEXT (131_072)
//
// The CLI does not serve 131_072 for the hunyuan / deepseek / glm / kimi line —
// it reports 1_000_000 in `modelUsage` on the first result. That guess is not a
// display detail. pi derives all of this from the registered number:
//
//   shouldCompact(tokens, contextWindow - reserveTokens)   → compacts at 114_688
//                                                            instead of 983_616
//   the footer's context indicator                          → 86% full at 11% used
//   summarization maxTokens = min(0.8 * reserveTokens, model.maxTokens)
//                                                             → summaries capped at 8_192
//                                                            output tokens
//
// which is exactly the reported failure: compact, land at ~96k of a claimed
// 131k, one or two ordinary turns push it back over the threshold, compact
// again — while the model itself is nowhere near full.
//
// The CLI *does* report the truth, per request, in `result.modelUsage`. This
// module persists it so the next session registers the real window instead of
// the guess. The first session on a model still guesses; after that it does not.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export type ServedWindow = {
	contextWindow: number;
	maxOutputTokens?: number;
	/** Epoch ms of the observation, for diagnostics. */
	observedAt: number;
};

export type ServedWindows = Record<string, ServedWindow>;

const SERVED_CACHE_KEY = Symbol.for("codebuddy-sdk:servedWindows");

const defaultCacheFile = () => join(homedir(), ".pi", "agent", "codebuddy-sdk-served.json");

const cacheFile = () => process.env.CODEBUDDY_SDK_SERVED_PATH || defaultCacheFile();

/**
 * Plausibility floor/ceiling. A malformed or partial `modelUsage` must not be
 * able to poison the cache: too small and pi stops compacting at all, too large
 * and every request overruns the real window.
 */
const MIN_WINDOW = 8_192;
const MAX_WINDOW = 20_000_000;

/** In-process first, then disk — mirrors readModelsCache(). */
export function readServedWindows(): ServedWindows {
	const inProcess = (globalThis as Record<symbol, unknown>)[SERVED_CACHE_KEY] as ServedWindows | undefined;
	if (inProcess && Object.keys(inProcess).length) return inProcess;
	try {
		const parsed: unknown = JSON.parse(readFileSync(cacheFile(), "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ServedWindows;
	} catch {
		// No cache yet, or corrupt file — start empty.
	}
	return {};
}

function persist(windows: ServedWindows): void {
	(globalThis as Record<symbol, unknown>)[SERVED_CACHE_KEY] = windows;
	try {
		const path = cacheFile();
		mkdirSync(dirname(path), { recursive: true });
		// Atomic: a torn file here would be read back as a corrupt cache.
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(windows, null, 2));
		renameSync(tmp, path);
	} catch {
		// Best-effort. Losing the cache only costs one more guessed session.
	}
}

/**
 * Record what the CLI said it served for `modelId`.
 *
 * `modelUsage` is keyed by the model the CLI actually used, which is not always
 * the id we asked for — a role alias such as `default-model` resolves server
 * side. Entries are therefore stored under the id the caller passed, and the
 * value is only accepted when it is a plausible window.
 *
 * Returns the stored entry, or undefined when the report carried nothing usable.
 */
export function recordServedWindow(
	modelId: string,
	reported: { contextWindow?: number; maxOutputTokens?: number },
	now: number = Date.now(),
): ServedWindow | undefined {
	const raw = reported.contextWindow;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
	const contextWindow = Math.floor(raw);
	if (contextWindow < MIN_WINDOW || contextWindow > MAX_WINDOW) return undefined;

	const maxOutput =
		typeof reported.maxOutputTokens === "number" && Number.isFinite(reported.maxOutputTokens) && reported.maxOutputTokens > 0
			? Math.floor(reported.maxOutputTokens)
			: undefined;

	const existing = readServedWindows()[modelId];
	const entry: ServedWindow = {
		contextWindow,
		...(maxOutput !== undefined ? { maxOutputTokens: maxOutput } : existing?.maxOutputTokens !== undefined ? { maxOutputTokens: existing.maxOutputTokens } : {}),
		observedAt: now,
	};
	persist({ ...readServedWindows(), [modelId]: entry });
	return entry;
}

/**
 * Apply learned windows to a model list. Explicit config overrides must still
 * win, so callers run this *before* buildModels' override layers — see
 * buildModels' `served` parameter, which is the preferred entry point.
 */
export function applyServedWindows<T extends { id: string; contextWindow: number; maxTokens: number }>(
	models: T[],
	windows: ServedWindows,
): T[] {
	return models.map((m) => {
		const served = windows[m.id];
		if (!served) return m;
		return {
			...m,
			contextWindow: served.contextWindow,
			maxTokens: served.maxOutputTokens ?? m.maxTokens,
		};
	});
}
