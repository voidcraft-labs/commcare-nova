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
 * sites diverged. This guard fails the build if any file OUTSIDE the sanctioned
 * readers makes a raw READ of one of the PURE ownership/liveness leaves — the
 * fields with no legitimate reader anywhere else.
 *
 * On Postgres those leaves are BOTH the derived-view fields on the assembled
 * `AppDoc` / `Partial<AppDoc>` (`run_lock.expireAt`, `run_lock.runId`,
 * `reservation.runId` — a decision reading them bypasses `runLeaseState`) AND
 * the flat `apps`-row COLUMNS they project from (`lock_expire_at`, `lock_run_id`,
 * `res_run_id` — a decision reading a column directly bypasses the row→view
 * mapping too). Both are guarded here.
 *
 * The sanctioned readers — exempt from the scan — are:
 *   - `lib/db/runLiveness.ts` in full (the ONE decision reader — it consumes the
 *     derived-view fields to compute the booleans everyone else branches on);
 *   - the row→view mapping helpers `leaseView` / `rowReservation` / `rowRunLock`
 *     (`lib/db/leaseView.ts`, shared by `apps.ts` + `credits.ts`), the ONLY
 *     sites that member-read
 *     the raw COLUMNS — to reassemble the nullable column groups into the
 *     `AppReservation` / `AppRunLock` shapes `runLeaseState` reads. Their bodies
 *     are stripped before the scan so the columns they legitimately read don't
 *     trip it;
 *   - the forward-only runtime-holder migrations, whose PostgreSQL row triggers
 *     are the database authority that stamps the exact same holder identity.
 *     Their SQL must read the physical columns and is covered by dedicated
 *     migration + cutoff-race tests instead of this TypeScript decision guard.
 *
 * A new decision path physically cannot diverge: it has no raw field to read, so
 * it must consume `runLeaseState`'s derived booleans (`live` / `mine` / `paused`
 * / `reapableStrandedEdit` / `reapableStaleBuild`) and gets the identical decision
 * every other path gets.
 *
 * `reservation.settled` / `res_settled` is deliberately NOT in this hard guard:
 * its only external readers are the atomic writers' settle-shaping expressions
 * (`...(reservation && !reservation.settled && { res_settled: true })`), which are
 * WRITES, not liveness decisions — and the settled/cleared skew was closed by
 * making settle+release atomic (`settleAndRelease`), not by guarding the field.
 * Liveness/paused DECISIONS over `status` / `awaiting_input` are likewise routed
 * through `runLeaseState` by construction (a blanket grep on those two would flag
 * the UI, the build page, and status transitions), so they are not hard-guarded.
 */

/** Object-member READS of the derived-view pure fields — `x.run_lock.expireAt`,
 * `x.run_lock?.runId`, `reservation.runId`, etc. The leading `.`/`?.` accessor
 * (never a quote) is what distinguishes a member read from an object KEY. */
const DERIVED_FIELD_READ =
	/(?<![\w"'`])(?:run_lock\s*\??\.\s*(?:expireAt|runId)|reservation\s*\??\.\s*runId)\b/;

/** Object-member READS of the raw pure COLUMNS — `row.lock_run_id`,
 * `fresh?.res_run_id`, `x.lock_expire_at`. The REQUIRED leading `.`/`?.`
 * accessor is what tells a member read apart from a Kysely `.select([...])`
 * string literal (`"lock_run_id"` — quote before it) or a `.set({...})` / type
 * KEY (`lock_run_id:` — no accessor before it), both of which are allowed. */
const COLUMN_FIELD_READ = /\??\.\s*(?:res_run_id|lock_run_id|lock_expire_at)\b/;

/** Strip `//` and `/* *​/` comments so a field name in prose never trips the scan. */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((line) => line.replace(/\/\/.*$/, ""))
		.join("\n");
}

/**
 * Blank out the bodies of the sanctioned row→view mapping helpers
 * (`leaseView` / `rowReservation` / `rowRunLock`) so the raw columns they
 * legitimately member-read don't trip the scan. Each is a top-level `function`
 * declaration, so its body runs from the declaration line to the first line
 * that is EXACTLY a closing brace (`}` at column 0) — Biome formats the closer
 * there, and a multi-line param object's `}): T {` line is NOT bare-`}`, so it
 * never ends the strip early.
 */
const SANCTIONED_READER =
	/^(?:export\s+)?function\s+(?:leaseView|rowReservation|rowRunLock)\b/;
function stripSanctionedReaders(source: string): string {
	const lines = source.split("\n");
	const out: string[] = [];
	let skipping = false;
	for (const line of lines) {
		if (!skipping && SANCTIONED_READER.test(line)) {
			skipping = true;
			out.push(""); // preserve line numbering
			continue;
		}
		if (skipping) {
			out.push("");
			if (/^}\s*$/.test(line)) skipping = false;
			continue;
		}
		out.push(line);
	}
	return out.join("\n");
}

function offenders(source: string): string[] {
	const scanned = stripSanctionedReaders(stripComments(source));
	return scanned
		.split("\n")
		.map((line, i) => ({ line: line.trim(), n: i + 1 }))
		.filter(
			({ line }) =>
				DERIVED_FIELD_READ.test(line) || COLUMN_FIELD_READ.test(line),
		)
		.map(({ line, n }) => `${n}: ${line}`);
}

/** All non-test `.ts` / `.tsx` under a top-level dir, except `runLiveness.ts`. */
const SANCTIONED_DATABASE_READERS = new Set([
	"lib/case-store/migrations/20260722080000_runtime_reader_rollout.ts",
	"lib/case-store/migrations/20260722120000_run_holder_nonce.ts",
]);

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
		.filter(
			(f) =>
				f !== "lib/db/runLiveness.ts" && !SANCTIONED_DATABASE_READERS.has(f),
		);
}

describe("run-liveness single-reader guard: no raw read of the pure ownership/liveness fields", () => {
	const files = ["lib", "app"].flatMap(sourceFilesUnder);
	it.each(files)("%s", (relativePath) => {
		const source = readFileSync(join(process.cwd(), relativePath), "utf8");
		expect(offenders(source)).toEqual([]);
	});

	it("the regex actually matches a raw read (tripwire self-test)", () => {
		// Derived-view member reads (the AppDoc-shaped leaves).
		expect(offenders("if (fresh.run_lock?.runId === runId) {}")).not.toEqual(
			[],
		);
		expect(offenders("const x = data.reservation.runId;")).not.toEqual([]);
		expect(offenders("x.run_lock.expireAt.getTime() <= now")).not.toEqual([]);
		// Raw-COLUMN member reads (the flat apps-row leaves), off any variable.
		expect(offenders("if (fresh.lock_run_id === runId) {}")).not.toEqual([]);
		expect(offenders("const t = row?.lock_expire_at;")).not.toEqual([]);
		expect(offenders("return marker.res_run_id === runId;")).not.toEqual([]);
	});

	it("allows the sanctioned column NON-reads (tripwire negatives)", () => {
		// A Kysely `.select([...])` string literal is a column NAME, not a read.
		expect(offenders('.select(["res_run_id", "lock_run_id"])')).toEqual([]);
		// A `.set({...})` object key / a type declaration is a write / a shape,
		// not a read — no leading accessor.
		expect(offenders(".set({ lock_run_id: null, res_run_id: runId })")).toEqual(
			[],
		);
		expect(offenders("\tlock_expire_at: Date | null;")).toEqual([]);
		// `reservation.settled` / `res_settled` is not in the hard guard.
		expect(offenders("if (!reservation.settled) {}")).toEqual([]);
		expect(offenders("if (row.res_settled) {}")).toEqual([]);
		// A member read INSIDE a sanctioned reader body is stripped before the scan.
		expect(
			offenders(
				"function rowRunLock(row) {\n\treturn { runId: row.lock_run_id, expireAt: row.lock_expire_at };\n}",
			),
		).toEqual([]);
	});
});
