/**
 * Pre-push gate: block the push if any test leaks an async resource.
 *
 * ## What this protects against
 *
 * A test "leaks" when it leaves an async resource alive after it
 * finishes — an uncleared `setInterval` / `setTimeout`, an open handle,
 * or a promise that never settles. A live timer or handle keeps Node's
 * event loop open, so the Vitest worker that ran the test cannot exit on
 * its own. Vitest force-kills the worker after `teardownTimeout`; that
 * usually just adds delay, but it occasionally races — and that race is
 * the intermittent "the test suite hangs and I have to kill it by hand"
 * failure. A *perpetual* leak (an animation frame loop, an uncleared
 * `setInterval`) is worse: the worker never goes idle, so the run can
 * hang outright. This gate stops a leaking test from ever being pushed,
 * so that failure mode can't re-arm for the next person.
 *
 * ## How it works
 *
 * Runs the full suite under Vitest's `--detect-async-leaks`, which uses
 * `node:async_hooks` to report every async resource still open when a
 * test finishes, WITH source locations. The flag makes the run markedly
 * slower (it instruments every async resource) — that's expected, and is
 * exactly why this lives on `pre-push` (fires once before sharing code)
 * rather than `pre-commit` (fires on every commit).
 *
 * Three outcomes:
 *   - Clean run, no leak banner → exit 0, push proceeds.
 *   - Leak banner present → print the source-located report plus a
 *     structured "what / why / how to fix" message → exit 1.
 *   - The detector itself does not finish within {@link TIMEOUT_MS} →
 *     that *is* a failure: a perpetual leak made the detector wait
 *     forever. Kill the run, explain, exit 1.
 *
 * If Vitest is ever upgraded, re-confirm the `--detect-async-leaks` flag
 * still triggers detection — the deliberate-leak acceptance test
 * (introduce a leak, confirm this gate blocks) is the check that proves
 * the flag is effective on the installed version.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

/**
 * Wall-clock ceiling for the instrumented run. The full suite completes
 * in ~90s under the flag, so this is generous headroom that still trips
 * promptly on a true hang rather than wedging the developer's terminal
 * (or a CI runner) indefinitely. A perpetual-loop leak never settles, so
 * without this ceiling the detector would wait forever.
 */
const TIMEOUT_MS = 600_000;

/**
 * Local Vitest binary. Invoked directly (not through `npx`) so the gate
 * runs the version pinned in the repo and we control the child process
 * group for a clean kill on timeout.
 */
const VITEST_BIN = resolve(process.cwd(), "node_modules", ".bin", "vitest");

/**
 * Markers Vitest prints when one or more leaks are detected. The banner
 * (`⎯⎯ Async Leaks N ⎯⎯`) heads the source-located report; the summary
 * line (`Leaks  N leaks`) appears in the run totals. Matching either is
 * enough — a clean run prints neither.
 */
const LEAK_BANNER = /Async Leaks\s+\d+/;
const LEAK_SUMMARY = /\bLeaks\b\s+\d+\s+leak/;

/**
 * The pointer every failure message resolves to. Tracked guidance — not
 * scratch notes — so it's there for whoever hits this gate.
 */
const GUIDANCE_POINTER =
	'See the "Testing — async-resource leaks" section in CLAUDE.md for the fix patterns.';

/** Shared "how to fix" block — identical advice whether we detected a
 *  leak banner or timed out waiting for a perpetual leak to settle. */
function howToFix(): string {
	return [
		"How to fix it — at the source, in the leaking test's teardown:",
		"  • Timer: clear it (clearTimeout / clearInterval) in afterEach/afterAll.",
		"  • Promise: await it, or cancel it, before the test ends.",
		"  • React tree: unmount it (let RTL cleanup run) and await any pending",
		"    state update with `await screen.findBy*` / `await waitFor(...)` so it",
		"    settles inside `act` — do not assert synchronously and leave it pending.",
		"  • Library with a module-level timer / animation loop: mock it at the",
		"    import boundary so the timer never starts.",
		"",
		"Do NOT paper over it: no bumping teardownTimeout, no switching pools, no",
		"retries, no suppressing the report. Those hide the hang instead of fixing it.",
		"",
		GUIDANCE_POINTER,
	].join("\n");
}

/**
 * Run Vitest under the leak detector, streaming its output to the
 * terminal (so the developer sees the source-located report live) while
 * also buffering it for post-run analysis. Resolves with the captured
 * output and how the run ended.
 */
function runLeakDetection(): Promise<{
	output: string;
	exitCode: number | null;
	timedOut: boolean;
}> {
	return new Promise((resolvePromise) => {
		// Own process group (`detached`) so a timeout can kill the whole
		// tree — Vitest spawns worker subprocesses, and a perpetual leak
		// lives in a worker that would otherwise outlive the parent.
		const child = spawn(
			VITEST_BIN,
			["run", "--configLoader", "runner", "--detect-async-leaks"],
			{
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			},
		);

		let output = "";
		let timedOut = false;

		const capture = (chunk: Buffer): void => {
			const text = chunk.toString("utf8");
			output += text;
			process.stdout.write(text);
		};
		child.stdout.on("data", capture);
		child.stderr.on("data", capture);

		const timer = setTimeout(() => {
			timedOut = true;
			// Negative pid targets the whole process group.
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				// Group already gone — nothing to kill.
			}
		}, TIMEOUT_MS);

		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ output, exitCode: code, timedOut });
		});
	});
}

async function main(): Promise<void> {
	const { output, exitCode, timedOut } = await runLeakDetection();

	if (timedOut) {
		console.error(
			[
				"",
				"✗ ASYNC LEAK GATE FAILED — push blocked.",
				"",
				`What happened: the leak detector did not finish within ${
					TIMEOUT_MS / 1000
				}s.`,
				"That is itself the failure, not a flake: a test leaked a *perpetual*",
				"async resource — an animation frame loop, an uncleared setInterval, an",
				"open handle — that never settles, so the detector waited for it forever.",
				"This is the exact resource class that hangs the suite in CI.",
				"",
				"Find the offender by running the detector and watching which file never",
				"completes:  npm run test:leaks",
				"",
				howToFix(),
				"",
			].join("\n"),
		);
		process.exit(1);
	}

	const leaked = LEAK_BANNER.test(output) || LEAK_SUMMARY.test(output);

	if (leaked) {
		console.error(
			[
				"",
				"✗ ASYNC LEAK GATE FAILED — push blocked.",
				"",
				"This is a real failure you must fix, not a flake — do not re-run or",
				"--no-verify around it.",
				"",
				"What happened: a test left an async resource (a timer, an open handle,",
				"or an unsettled promise) alive after it finished.",
				"",
				"Why the push is blocked: a leaked timer or handle keeps Node's event",
				"loop open, so the Vitest worker that ran the test can't exit on its own.",
				"Vitest force-kills it after a timeout, and when that races the whole run",
				"hangs — the intermittent suite hang this gate exists to prevent. Shipping",
				"a leaking test re-arms that hang for everyone.",
				"",
				"Which resource leaked and where: see Vitest's source-located report",
				"above (the `Async Leaks` section names the file, line, and stack of each",
				"leaked resource).",
				"",
				howToFix(),
				"",
			].join("\n"),
		);
		process.exit(1);
	}

	// Whether the run actually finished (Vitest prints a `Test Files`
	// summary only on a completed run). If Vitest exited non-zero WITHOUT
	// finishing — a crash, a config error, the detector itself erroring —
	// the absence of a leak banner is meaningless (detection never ran to
	// completion), so block and say the run didn't finish.
	const runCompleted = /Test Files\s+\d/.test(output);
	if (exitCode !== 0 && !runCompleted) {
		console.error(
			[
				"",
				"✗ ASYNC LEAK GATE: the leak run did not finish — Vitest exited",
				`${exitCode} before printing a run summary, so the leak verdict can't`,
				"be trusted. Re-run `npm run test:leaks` to see what went wrong.",
				"",
			].join("\n"),
		);
		process.exit(1);
	}

	// The run finished with zero leaks. This gate blocks on async-resource
	// leaks ONLY — test correctness is a separate concern owned by the
	// test suite's own run (pre-push gates lint + typecheck, not tests, by
	// design). If some test failed, surface it so the developer isn't
	// blind to it, but do NOT block the push: a flaky or failing test is
	// orthogonal to a leaked handle, and coupling them would make this
	// gate fire on unrelated failures and erode trust in it.
	if (exitCode !== 0) {
		const failing = [...output.matchAll(/^\s*FAIL\s+(.+)$/gm)].map((m) =>
			m[1].trim(),
		);
		console.warn(
			[
				"",
				"⚠ async-leak gate: no leaks — but the run reported test failure(s),",
				"which this gate does NOT block on (test correctness is the suite's own",
				"gate, not the leak gate). Investigate separately:",
				...failing.map((name) => `    • ${name}`),
				"",
			].join("\n"),
		);
	}

	console.log("✓ no async-resource leaks — all tests released their handles.");
}

main().catch((err: unknown) => {
	console.error("✗ async-leak gate could not run:", err);
	process.exit(1);
});
