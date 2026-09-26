// The pi-ctx bridge: report what the CodeBuddy CLI served, and read back the
// windows pi-ctx has learned.
//
// pi-ctx is the single authority for context-window sizes. This package is only
// the observer: it knows the CLI's `result.modelUsage` shape, and it knows how
// to call the pi-ctx CLI. It deliberately knows nothing about the store's path,
// shape, or plausibility rules — `pi-ctx status --json` is the only format here,
// so the store can change without silently breaking this package.
//
// Why exec and not import: packages here must not import each other; the
// boundary is the CLI (and the file). Why not read the store file directly: that
// would duplicate the format knowledge the CLI already owns. Direct reading
// stays a possible later optimization, not the default.
//
// Nothing here may break a turn. A missing binary, a non-zero exit, a timeout,
// or unparseable output all collapse to "no observation" / "no learned windows",
// and each distinct problem is logged at most once.

import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { delimiter, isAbsolute, join } from "path";
import { PROVIDER_ID } from "./convert.js";

/**
 * The `pi-ctx status --json` contract version this package understands.
 * Integer, matching pi-ctx's FORMAT_VERSION on purpose: a consumer branches on
 * the number, and a SemVer string would add parsing without adding safety.
 */
const SUPPORTED_FORMAT = 1;

/**
 * One learned window, as `pi-ctx status --json` reports it. */
export type PiCtxWindow = { contextWindow: number; maxOutputTokens?: number };
export type PiCtxWindows = Record<string, PiCtxWindow>;

export type PiCtxRun = { ok: boolean; stdout: string; reason?: string };

export type PiCtxDeps = {
	env?: Record<string, string | undefined>;
	exists?: (path: string) => boolean;
	/** Test seams for the self-announced path under ~/.pi/agent/pi-ctx/cli-path. */
	agentDir?: string;
	readFile?: (path: string, encoding: "utf8") => string;
	/** Injected so the rules stay unit-testable without spawning anything. */
	run?: (bin: string, args: string[]) => Promise<PiCtxRun>;
	timeoutMs?: number;
	/** Where a one-time problem report goes; defaults to silence. */
	onProblem?: (message: string) => void;
};

const DEFAULT_TIMEOUT_MS = 3_000;

/** In-process state on globalThis so a test can clear it like the old cache. */
const STATE_KEY = Symbol.for("codebuddy-sdk:piCtxState");
type PiCtxState = { read?: { key: string; promise: Promise<PiCtxWindows> }; warned: Set<string> };

function state(): PiCtxState {
	const holder = globalThis as unknown as Record<symbol, PiCtxState | undefined>;
	return (holder[STATE_KEY] ??= { warned: new Set<string>() });
}

function warnOnce(deps: PiCtxDeps, problem: string, message: string, stderrToo = false): void {
	const warned = state().warned;
	if (warned.has(problem)) return;
	warned.add(problem);
	deps.onProblem?.(message);
	if (stderrToo) {
		// A contract violation must be visible even when onProblem routes into a
		// debug file (default). Normal paths stay silent; only these format
		// warnings reach stderr, once each, via the same dedupe.
		try { process.stderr.write(`pi-codebuddy-sdk: ${message}\n`); } catch { /* stderr may be gone */ }
	}
}

/**
 * Where the pi-ctx CLI is: explicit override, PATH, then pi-ctx's own marker.
 * Undefined means "not installed", which is a supported state — observation is
 * skipped and the SDK keeps working on its own fallback window.
 */
export function resolvePiCtxBin(deps: PiCtxDeps = {}): string | undefined {
	const env = deps.env ?? process.env;
	const exists = deps.exists ?? existsSync;
	const explicit = env.PI_CTX_BIN;
	if (explicit && exists(explicit)) return explicit;
	const name = process.platform === "win32" ? "pi-ctx.cmd" : "pi-ctx";
	for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (exists(candidate)) return candidate;
	}
	const agentDir = deps.agentDir ?? join(homedir(), ".pi", "agent");
	const marker = join(agentDir, "pi-ctx", "cli-path");
	if (!exists(marker)) return undefined;
	try {
		const candidate = (deps.readFile ?? ((path) => readFileSync(path, "utf8")))(marker, "utf8").trim();
		if (candidate && isAbsolute(candidate) && exists(candidate)) return candidate;
	} catch {
		// A missing, unreadable, or stale marker is the same as no installed CLI.
	}
	return undefined;
}

function defaultRun(timeoutMs: number) {
	return (bin: string, args: string[]): Promise<PiCtxRun> =>
		new Promise((resolve) => {
			execFile(bin, args, { timeout: timeoutMs }, (error, stdout) => {
				if (error) resolve({ ok: false, stdout: String(stdout ?? ""), reason: error.message });
				else resolve({ ok: true, stdout: String(stdout ?? "") });
			});
		});
}

/** Run the CLI once. Never throws and never rejects. */
async function call(args: string[], deps: PiCtxDeps): Promise<PiCtxRun> {
	const bin = resolvePiCtxBin(deps);
	if (!bin) {
		warnOnce(deps, "not-found", "pi-ctx not found (set PI_CTX_BIN or put pi-ctx on PATH); window observations are skipped");
		return { ok: false, stdout: "", reason: "pi-ctx not found" };
	}
	const run = deps.run ?? defaultRun(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const result = await run(bin, args);
		if (!result.ok) warnOnce(deps, `exec:${args[0]}`, `pi-ctx ${args[0]} failed (${result.reason ?? "unknown"}); continuing without it`);
		return result;
	} catch (error) {
		warnOnce(deps, `exec:${args[0]}`, `pi-ctx ${args[0]} failed (${(error as Error).message}); continuing without it`);
		return { ok: false, stdout: "", reason: (error as Error).message };
	}
}

/**
 * Report one observation to pi-ctx. Fire-and-forget: the caller does not await
 * it, and a failure is a lost observation, never a broken turn.
 *
 * The plausible range is pi-ctx's rule, not this package's — a garbage number is
 * passed through and refused on the other side, so the rule lives in one place.
 * A non-number is dropped here because there is nothing to report at all.
 */
export async function observeWindow(
	modelId: string,
	reported: { contextWindow?: number; maxOutputTokens?: number },
	deps: PiCtxDeps = {},
): Promise<void> {
	const raw = reported.contextWindow;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return;
	const args = ["observe", "--provider", PROVIDER_ID, "--model", modelId, "--window", String(Math.floor(raw))];
	const max = reported.maxOutputTokens;
	if (typeof max === "number" && Number.isFinite(max) && max > 0) args.push("--max-output", String(Math.floor(max)));
	await call(args, deps);
}

/**
 * Read the windows pi-ctx has learned. One `pi-ctx status --json` per process:
 * the module-load path and the discovery path both need this, and a second exec
 * would only repeat the same answer.
 *
 * Any failure — no binary, non-zero exit, bad JSON — is an empty list, which is
 * exactly "nothing learned yet". The SDK must work with pi-ctx absent.
 *
 * On a format mismatch the fallback is also empty, which the registration path
 * treats as "no learned window" and keeps the wide fallback (1M). Widening is
 * only a delay; narrowing an unknown model is unrecoverable for the session it
 * starves, so this package defaults wide and lets pi-ctx own the corrections.
 */
export function readPiCtxWindows(deps: PiCtxDeps = {}): Promise<PiCtxWindows> {
	const key = resolvePiCtxBin(deps) ?? "";
	const cached = state().read;
	if (cached?.key === key) return cached.promise;
	const promise = call(["status", "--json"], deps).then((result) => {
		if (!result.ok) return {};
		try {
			const parsed = JSON.parse(result.stdout) as { format?: unknown; windows?: unknown };
			if (typeof parsed?.format !== "number") {
				// M1's bug was a parse that succeeded and was silently dropped. A
				// missing version must be loud, not treated as "the old format".
				warnOnce(deps, "status-format-missing", "pi-ctx status --json has no format version; ignoring its windows (update pi-ctx)", true);
				return {};
			}
			if (parsed.format > SUPPORTED_FORMAT) {
				// A newer format may use unknown key rules — reading it anyway would
				// repeat exactly the silently-dropped-keys failure.
				warnOnce(deps, `status-format-${parsed.format}`, `pi-ctx status --json format ${parsed.format} is newer than supported ${SUPPORTED_FORMAT}; ignoring its windows (update pi-codebuddy-sdk)`, true);
				return {};
			}
			if (parsed.format < SUPPORTED_FORMAT) {
				warnOnce(deps, `status-format-${parsed.format}`, `pi-ctx status --json format ${parsed.format} is older than supported ${SUPPORTED_FORMAT}; ignoring its windows (update pi-ctx)`, true);
				return {};
			}
			const windows = parsed?.windows;
			if (!windows || typeof windows !== "object" || Array.isArray(windows)) {
				warnOnce(deps, "status-windows", "pi-ctx status --json format 1 has no windows object; treating the learned windows as empty");
				return {};
			}
			const learned: PiCtxWindows = {};
			for (const [name, entry] of Object.entries(windows as PiCtxWindows)) {
				const [provider, ...rest] = name.split("/");
				if (!provider || rest.length !== 1 || !rest[0]) {
					// Keys are provider/model; anything else is unreadable by design,
					// and dropping it silently is the failure this contract exists to
					// prevent.
					warnOnce(deps, `status-key:${name}`, `pi-ctx reported a window under key "${name}", which is not provider/model; ignoring it`);
					continue;
				}
				learned[name] = entry;
			}
			return learned;
		} catch {
			warnOnce(deps, "status-json", "pi-ctx status --json was not valid JSON; treating the learned windows as empty");
			return {};
		}
	});
	state().read = { key, promise };
	return promise;
}
