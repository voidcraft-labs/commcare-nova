/**
 * Shared harness for the CI outbound healthz probes (auth-healthz,
 * firestore-healthz). Each probe does the real outbound work and returns a
 * one-line success summary; this owns the cross-cutting machinery so the two
 * gates can't drift apart:
 *
 *   - a hard watchdog — a broken keep-alive can HANG rather than throw, and CI
 *     must not sit to the job timeout;
 *   - a SYNCHRONOUS stderr failure diagnostic (`writeSync` is flushed before
 *     control returns, so the `process.exit` below can't truncate the regression
 *     signature — e.g. an ERR_STREAM_PREMATURE_CLOSE stack — on CI's piped
 *     stderr);
 *   - a force-exit — these gates deliberately exercise the WIF/gaxios keep-alive
 *     HTTP stack, and a lingering keep-alive socket (the exact layer under test)
 *     could keep the loop alive past the probe. Matches e2e/seed.ts's exit.
 */
import { writeSync } from "node:fs";

const TIMEOUT_MS = 30_000;

function logFailure(label: string, msg: string, err?: unknown): void {
	writeSync(2, `[${label}] FAIL: ${msg}\n`);
	if (err !== undefined) {
		writeSync(
			2,
			`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
		);
	}
}

/**
 * Run a CI healthz `probe` under the watchdog + force-exit. `probe` performs the
 * real outbound round-trip and resolves with a one-line success summary (logged
 * as `[label] OK — <summary>`); throwing or hanging reds the job.
 */
export function runHealthz(label: string, probe: () => Promise<string>): void {
	const timer = setTimeout(() => {
		logFailure(
			label,
			`timed out after ${TIMEOUT_MS}ms — the outbound call hung (a keep-alive / undici regression signature).`,
		);
		process.exit(1);
	}, TIMEOUT_MS);
	timer.unref();

	probe()
		.then((summary) => {
			clearTimeout(timer);
			console.log(`[${label}] OK — ${summary}`);
			process.exit(0);
		})
		.catch((err) => {
			clearTimeout(timer);
			logFailure(
				label,
				"probe threw — the outbound stack is broken (this is how prod outages look).",
				err,
			);
			process.exit(1);
		});
}
