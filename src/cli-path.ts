// Resolution of a CodeBuddy executable path the SDK can actually spawn.
//
// `@tencent-ai/agent-sdk` spawns its CLI through a runtime, and for any path
// ending in `bin/codebuddy` it does a *string* rewrite before spawning:
//
//   cliJsPath = executablePath.replace(/bin[/\\]codebuddy$/, 'dist/codebuddy-headless.js')
//   spawn(node, [cliJsPath, ...args])
//
// The rewrite is driven by the path string alone — symlinks are not followed and
// the target's existence is never checked. An nvm-style shim therefore breaks:
//
//   configured   ~/.nvm/versions/node/v24.17.0/bin/codebuddy        (symlink)
//   spawned      ~/.nvm/versions/node/v24.17.0/dist/codebuddy-headless.js
//   reality      no dist/ directory there at all
//
// Node dies with `Cannot find module`, stderr is swallowed, and the only symptom
// reaching the user is the transport's `CLI process stdout closed unexpectedly`
// roughly a second later.
//
// This module resolves the executable *first* and verifies the file the SDK will
// actually spawn. All I/O is injected so the rules stay unit-testable.

import { existsSync, readFileSync, realpathSync } from "fs";
import { delimiter, dirname, join } from "path";
import { fileURLToPath } from "url";

/** Where a candidate path came from, for debug logging. */
export type CliPathSource = "configured" | "sdk-bundled" | "path";

export type CliPathDeps = {
	exists?: (path: string) => boolean;
	realpath?: (path: string) => string;
	env?: Record<string, string | undefined>;
};

export type CliPathResult =
	| { kind: "ok"; path: string; source: CliPathSource; rewrittenTo: string }
	| { kind: "error"; reason: string; checked: string[] };

const CLI_BASENAME = process.platform === "win32" ? "codebuddy.exe" : "codebuddy";
const REWRITE_PATTERN = /bin[/\\]codebuddy(\.exe)?$/;

/** The file the SDK will spawn for a given `pathToCodebuddyCode`. Mirrors its regex. */
export function sdkSpawnTarget(executablePath: string): string {
	return executablePath.replace(REWRITE_PATTERN, "dist/codebuddy-headless.js");
}

/** The SDK's own bundled CLI, when this package is installed next to it. */
function bundledCliPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@tencent-ai", "agent-sdk", "cli", "bin", CLI_BASENAME);
}

/** Every `codebuddy` on PATH, in PATH order. */
function pathCandidates(env: Record<string, string | undefined>): string[] {
	const raw = env.PATH ?? env.Path ?? "";
	if (!raw) return [];
	return raw
		.split(delimiter)
		.filter((dir) => dir.length > 0)
		.map((dir) => join(dir, CLI_BASENAME));
}

/**
 * Pick a CodeBuddy executable whose SDK spawn target actually exists.
 *
 * Candidates are tried in trust order — explicit config, then the SDK's bundled
 * CLI, then PATH — and each is `realpath`'d first so a symlink shim resolves to
 * the package that actually ships `dist/codebuddy-headless.js`.
 */
export function resolveSpawnableCli(configured: string | undefined, deps: CliPathDeps = {}): CliPathResult {
	const exists = deps.exists ?? existsSync;
	const realpath = deps.realpath ?? realpathSync;
	const env = deps.env ?? process.env;

	const candidates: Array<{ path: string; source: CliPathSource }> = [];
	if (configured) candidates.push({ path: configured, source: "configured" });
	candidates.push({ path: bundledCliPath(), source: "sdk-bundled" });
	for (const path of pathCandidates(env)) candidates.push({ path, source: "path" });

	const checked: string[] = [];
	for (const candidate of candidates) {
		checked.push(candidate.path);
		if (!exists(candidate.path)) continue;

		let resolved = candidate.path;
		try {
			resolved = realpath(candidate.path);
		} catch {
			// Broken symlink or a race with an uninstall; try the next candidate.
			continue;
		}
		if (!exists(resolved)) continue;

		const target = sdkSpawnTarget(resolved);
		if (!exists(target)) continue;

		return { kind: "ok", path: resolved, source: candidate.source, rewrittenTo: target };
	}

	return {
		kind: "error",
		checked,
		reason:
			`No runnable CodeBuddy CLI found. The SDK spawns "${CLI_BASENAME}" by rewriting any ` +
			`"bin/${CLI_BASENAME}" path to "dist/codebuddy-headless.js" without following symlinks, ` +
			`so a shim (nvm, homebrew) fails with "Cannot find module" and surfaces as ` +
			`"CLI process stdout closed unexpectedly". Point provider.pathToCodebuddyCode at the ` +
			`package's real bin script, whose sibling dist/ exists. Checked: ${checked.join(", ") || "nothing"}`,
	};
}

/**
 * True when the file looks like a Node launcher rather than a native binary.
 * Kept for diagnostics only: the SDK rewrites on path shape, not content.
 */
export function isJsLauncher(path: string): boolean {
	try {
		return readFileSync(path, { encoding: "utf8" }).startsWith("#!");
	} catch {
		return false;
	}
}
