// The context size pi itself computes for the request it is sending.
//
// Why this exists: pi anchors both its footer gauge and its auto-compaction
// threshold on `usage.totalTokens` (core/compaction/compaction.js —
// `calculateContextTokens` reads it, `shouldCompact` compares it against
// `contextWindow - reserveTokens`). The CLI's own reported usage is not that
// number. Measured on the same turn, in the same session:
//
//   actual content in the CLI session file   8,126 tokens
//   usage the CLI reported for that turn    27,439 tokens   (3.38x)
//   (earlier turn, independent sample)    259,919 vs 69,615 (3.73x)
//
// The inflation is consistent, so a real 8k conversation registers as 27k and
// sits permanently above a 272k cap's 255,616 threshold — which is what drove
// 126 consecutive compactions of a session that never once filled up.
//
// So the number pi gets must come from pi's own messages, using pi's own
// estimator, so it can never drift from the fallback core uses when no usage
// is present. `input`/`output`/`cacheRead`/`cacheWrite` are left exactly as the
// CLI reported them — `calculateCost` bills from those and is unaffected.

import { estimateTokens } from "@earendil-works/pi-coding-agent";

/**
 * Mirror of core's no-usage fallback: the current system message plus every
 * non-system message, each estimated on its own.
 */
export function estimatePiContextTokens(messages: Array<{ role: string; content: unknown }>, systemPrompt?: string): number {
	let tokens = systemPrompt ? estimateTokens({ role: "system", content: systemPrompt } as never) : 0;
	for (const message of messages) {
		if (message.role === "system") continue;
		tokens += estimateTokens(message as never);
	}
	return tokens;
}
