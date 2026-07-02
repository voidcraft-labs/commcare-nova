import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The single-reader invariant, mechanically enforced.
 *
 * Run liveness / ownership / paused / settled state is derived ONLY through
 * `runLeaseState` (`lib/db/runLiveness.ts`). The P9 read-layer divergence class was
 * exactly this class: "is this run alive / mine / paused" computed independently
 * at ~10 sites, each reading a different subset of the run-state leaves, so the
 * sites diverged. This guard fails the build if any file OUTSIDE `runLiveness.ts`
 * makes a raw READ of one of the PURE ownership/liveness leaves — the fields with
 * no legitimate reader anywhere else:
 *
 *   - `run_lock.expireAt`  (the edit lease horizon)
 *   - `run_lock.runId`     (edit ownership)
 *   - `reservation.runId`  (build ownership + reap identity)
 *
 * A new decision path physically cannot diverge: it has no raw field to read, so
 * it must consume `runLeaseState`'s derived booleans (`live` / `mine` / `paused`
 * / `reapableStrandedEdit` / `reapableStaleBuild`) and gets the identical decision
 * every other path gets.
 *
 * `reservation.settled` is deliberately NOT in this hard guard: its only external
 * readers are the atomic writers' settle-shaping expressions (`!reservation.settled
 * ? { reservation: { ...reservation, settled: true } } : {}`), which are WRITES,
 * not liveness decisions — and the settled/cleared skew was closed by
 * making settle+release atomic (`settleAndRelease`), not by guarding the field.
 * Liveness/paused DECISIONS over `status` / `awaiting_input` are likewise routed
 * through `runLeaseState` by construction (a blanket grep on those two would flag
 * the UI, the build page, and status transitions), so they are not hard-guarded.
 */

/** Object-member READS of the pure fields — `x.run_lock.expireAt`,
 * `x.run_lock?.runId`, `reservation.runId`, etc. A dotted-path WRITE KEY
 * (`"run_lock.expireAt": …`) is a string literal, not a member read, so the
 * leading `.`/`?.` accessor (never a quote) is what distinguishes them. */
const PURE_FIELD_READ =
	/(?<![\w"'`])(?:run_lock\s*\??\.\s*(?:expireAt|runId)|reservation\s*\??\.\s*runId)\b/;

/** Strip `//` and `/* *​/` comments so a field name in prose never trips the scan. */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((line) => line.replace(/\/\/.*$/, ""))
		.join("\n");
}

function offenders(source: string): string[] {
	return (
		stripComments(source)
			.split("\n")
			.map((line, i) => ({ line: line.trim(), n: i + 1 }))
			.filter(({ line }) => PURE_FIELD_READ.test(line))
			// A dotted-path write key survives comment-strip but is inside quotes.
			.filter(({ line }) => !/["'`]run_lock\.(expireAt|runId)["'`]/.test(line))
			.map(({ line, n }) => `${n}: ${line}`)
	);
}

/** All non-test `.ts` / `.tsx` under a top-level dir, except `runLiveness.ts`. */
function sourceFilesUnder(dir: string): string[] {
	return readdirSync(join(process.cwd(), dir), {
		recursive: true,
		encoding: "utf8",
	})
		.filter(
			(p) =>
				(p.endsWith(".ts") || p.endsWith(".tsx")) &&
				!p.includes("__tests__") &&
				!p.endsWith(".test.ts") &&
				!p.endsWith(".test.tsx"),
		)
		.map((p) => `${dir}/${p}`)
		.filter((f) => f !== "lib/db/runLiveness.ts");
}

describe("run-liveness single-reader guard: no raw read of the pure ownership/liveness fields", () => {
	const files = ["lib", "app"].flatMap(sourceFilesUnder);
	it.each(files)("%s", (relativePath) => {
		const source = readFileSync(join(process.cwd(), relativePath), "utf8");
		expect(offenders(source)).toEqual([]);
	});

	it("the regex actually matches a raw read (tripwire self-test)", () => {
		expect(offenders("if (fresh.run_lock?.runId === runId) {}")).not.toEqual(
			[],
		);
		expect(offenders("const x = data.reservation.runId;")).not.toEqual([]);
		expect(
			offenders("x.run_lock.expireAt.toDate().getTime() <= now"),
		).not.toEqual([]);
		// A dotted-path WRITE KEY is allowed (it's a Firestore field path, a write).
		expect(
			offenders('tx.update(ref, { "run_lock.expireAt": deadline });'),
		).toEqual([]);
		// `reservation.settled` is not in the hard guard (settle-writes read it).
		expect(offenders("if (!reservation.settled) {}")).toEqual([]);
	});
});
