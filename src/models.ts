// Dynamic model list from CodeBuddy SDK supportedModels().

import type { ModelInfo } from "@tencent-ai/agent-sdk";
import { PROVIDER_ID } from "./convert.js";
import type { PiCtxWindows } from "./pi-ctx.js";

export type PiModel = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string>;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

// The SDK's model list carries no window, so every model needs one before the
// CLI reports the served truth. This constant is NOT a value this package
// decides — pi-ctx is the authority, and `applyWindows` narrows whatever it has
// learned. It is only the safety net for when pi-ctx is not installed, without
// which registration itself is impossible. Start wide: a too-large window delays
// compaction by a bounded amount, while a too-small one compacts irreversibly
// and early. Names are not evidence — `hy3` serves 192k and `hy4-preview` serves
// 1M — so there is no per-family guess.
const FALLBACK_CONTEXT_WINDOW = 1_048_576;
const DEFAULT_MAX_TOKENS = 8192;

function detectThinking(id: string): boolean {
	return /claude|gemini|gpt-5|hy3|deepseek|glm/i.test(id);
}

function detectImages(id: string): boolean {
	return /claude|gemini|gpt/i.test(id);
}

function estimateMaxTokens(id: string): number {
	if (id.toLowerCase().includes("gpt")) return 16_384;
	return DEFAULT_MAX_TOKENS;
}

export function rawModelsFromSdk(supported: Array<ModelInfo & { id?: string; name?: string }>): PiModel[] {
	return supported
		.map((m) => ({ id: m.id ?? m.value, name: m.name ?? m.displayName ?? m.id ?? m.value }))
		.filter((m) => m.id)
		.map((m) => ({
		id: m.id!,
		name: m.name || m.id!,
		reasoning: detectThinking(m.id!),
		input: detectImages(m.id!) ? ["text", "image"] as const : ["text"] as const,
		contextWindow: FALLBACK_CONTEXT_WINDOW,
		maxTokens: estimateMaxTokens(m.id!),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
}

export const FALLBACK_MODELS: PiModel[] = [
	{ id: "hy3-preview-agent-ioa", name: "Hunyuan 3 Preview", reasoning: true, input: ["text"], contextWindow: FALLBACK_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
];

export type ModelOverrides = {
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	images?: boolean;
};

/**
 * Apply the windows pi-ctx has learned on top of the fallback metadata. Explicit
 * config overrides must still win, so this runs before the override layers in
 * buildModels.
 */
export function applyWindows<T extends { id: string; contextWindow: number; maxTokens: number }>(
	models: T[],
	windows: PiCtxWindows,
): T[] {
	return models.map((m) => {
		const learned = windows[`${PROVIDER_ID}/${m.id}`];
		if (!learned || typeof learned.contextWindow !== "number") return m;
		return {
			...m,
			contextWindow: learned.contextWindow,
			maxTokens: learned.maxOutputTokens ?? m.maxTokens,
		};
	});
}

/**
 * Apply config-driven overrides on top of the estimated model metadata.
 * `globalOverrides` applies to every model; `perModel` is keyed by model id
 * (matched by exact id first, then case-insensitive substring, longest key
 * wins) and beats the global defaults. `windows` carries what pi-ctx learned
 * from the CLI's own `modelUsage`, which outranks the fallback but loses to
 * both override layers.
 */
export function buildModels(
	models: PiModel[],
	globalOverrides?: ModelOverrides,
	perModel?: Record<string, ModelOverrides>,
	windows?: PiCtxWindows,
): PiModel[] {
	const sortedKeys = Object.keys(perModel ?? {}).sort((a, b) => b.length - a.length);
	const match = (id: string): ModelOverrides | undefined => {
		const lower = id.toLowerCase();
		for (const key of sortedKeys) {
			const k = key.toLowerCase();
			if (id === key || (lower.includes(k) && k.length > 0)) return perModel![key];
		}
		return undefined;
	};
	// Learned windows sit below the override layers: an explicit config value is
	// the user overriding us on purpose, and must win over what the CLI reported.
	const base = windows ? applyWindows(models, windows) : models;
	return base.map((m) => {
		const o = { ...globalOverrides, ...match(m.id) };
		const contextWindow = o.contextWindow ?? m.contextWindow;
		const maxTokens = o.maxTokens ?? m.maxTokens;
		const input: ("text" | "image")[] = o.images === undefined
			? m.input
			: (o.images ? ["text", "image"] as const : ["text"] as const);
		return {
			...m,
			contextWindow,
			maxTokens,
			reasoning: o.reasoning ?? m.reasoning,
			input,
			cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
	});
}

export function codebuddyModelId(model: { id: string }): string {
	return model.id;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower || m.id.toLowerCase().includes(lower));
}
