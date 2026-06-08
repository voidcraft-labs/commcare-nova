/**
 * Read-only SCAN for the credit-system re-baseline migration.
 *
 * The usage docs (`usage/{user}/months/{period}.cost_estimate`) historically
 * UNDER-count actual spend versus the authoritative per-run summaries
 * (`apps/{appId}/runs/{runId}.costEstimate`). At migration time (post-merge,
 * with the user) we will re-baseline usage cost from the run-ledger. THIS
 * script surfaces the real per-`(owner, period)` deltas — plus the three
 * per-cell hazards (cross-month threads, soft-deleted contributions,
 * current-month over-backstop cells) — so the apply decision is made on data,
 * not on argument.
 *
 * STRICTLY READ-ONLY. This script issues no `.set` / `.update` / `.delete` and
 * constructs no `FieldValue` sentinel — it only reads and prints. The pure
 * reconciliation it drives lives in `./lib/creditReconcile` (no Firestore, no
 * I/O). Run with `--help` for flags.
 */
import { Command } from "commander";
import { ACTUAL_COST_BACKSTOP_USD } from "@/lib/db/creditPolicy";
import {
	loadReconciliationData,
	type UsageDocFields,
} from "./lib/creditMigrationData";
import { creditReconcile, MATERIAL_DELTA_USD } from "./lib/creditReconcile";
import { db } from "./lib/firestore";
import { printHeader, printSection, printTable, usd } from "./lib/format";
import { runMain } from "./lib/main";

// ── CLI ─────────────────────────────────────────────────────────────

// The scan takes no arguments — it reconciles the whole fleet and prints
// every cell — so the program exists only for `--help` and a clean
// "unexpected argument" error.
const program = new Command();
program
	.name("inspect-credit-migration")
	.description(
		"Read-only scan of the credit re-baseline: per-(owner, period) ledger-sum vs current usage cost, with cross-month / soft-deleted / current-month-over-$50 flags. Writes nothing.",
	)
	.addHelpText(
		"after",
		"\nExamples:\n  $ npx tsx scripts/inspect-credit-migration.ts\n",
	);
program.parse();

// ── Recorded cross-check anchors (from the credit-system memory) ─────

/**
 * Users whose usage docs were manually reset before the credit system, so the
 * scan can live-read their current usage fields next to the ledger sums it
 * computed for the same period — a sanity check that the pipeline reproduces
 * the recorded figures. `period` is the field's attribution month.
 */
const CROSS_CHECKS = [
	{
		label: "mmaher",
		userId: "w4KlwedcG1WijXOK0hVz",
		period: "2026-06",
		field: "cost_estimate" as const,
	},
	{
		label: "alohi",
		userId: "7oCUsMFQBYTY43zoyxjt",
		period: "2026-06",
		field: "cost_estimate" as const,
	},
] satisfies ReadonlyArray<{
	label: string;
	userId: string;
	period: string;
	field: "cost_estimate" | "unadjusted_estimate";
}>;

/**
 * mmaher's April orphan field. `unadjusted_estimate` is NOT in `usageDocSchema`
 * — it's a leftover from the manual reset — so it must be read off the raw
 * `.data()`, never through a Zod converter that would drop the unknown key.
 */
const ORPHAN = {
	label: "mmaher",
	userId: "w4KlwedcG1WijXOK0hVz",
	period: "2026-04",
	field: "unadjusted_estimate",
} as const;

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	printHeader("CREDIT RE-BASELINE SCAN (read-only)");

	// ── 1. Load the fleet (shared with the migrator's apply path) ─────
	// Every PROD read lives in the loader so the scan PREVIEW and the migrator
	// APPLY reconcile the exact same data — they can never diverge.
	const {
		runs,
		currentUsage,
		currentPeriod,
		emailOf,
		runDocsScanned,
		missingFieldSkips,
		orphanRunSkips,
		distinctApps,
	} = await loadReconciliationData();

	// ── 2. Reconcile (pure) ───────────────────────────────────────────
	const rows = creditReconcile(
		runs,
		currentUsage,
		currentPeriod,
		ACTUAL_COST_BACKSTOP_USD,
	);

	// Resolve an owner id to its email for display, falling back to the id.
	const email = (ownerId: string): string => emailOf.get(ownerId) ?? ownerId;

	// ── 3. Print scan summary ─────────────────────────────────────────
	console.log(`  Run docs scanned:        ${runDocsScanned}`);
	console.log(`  Skipped (missing field): ${missingFieldSkips}`);
	console.log(`  Skipped (orphan run):    ${orphanRunSkips}`);
	console.log(`  Distinct apps:           ${distinctApps}`);
	console.log(`  (owner, period) cells:   ${rows.length}`);
	console.log(`  Current period:          ${currentPeriod}`);
	console.log(`  Backstop:                ${usd(ACTUAL_COST_BACKSTOP_USD)}\n`);

	// 3a. Per-cell table — the full reconciliation.
	printSection("Per-(owner, period) reconciliation");
	printTable(
		[
			{ header: "email" },
			{ header: "period" },
			{ header: "current", align: "right" },
			{ header: "ledger_sum", align: "right" },
			{ header: "delta", align: "right" },
			{ header: "CURRENT?" },
			{ header: "soft-deleted", align: "right" },
		],
		rows.map((r) => [
			email(r.ownerId),
			r.period,
			usd(r.current),
			usd(r.ledgerSum),
			signedUsd(r.delta),
			r.isCurrentMonth ? "★" : "",
			usd(r.softDeletedContribution),
		]),
	);

	// 3b. Cross-month runs — these mis-attribute a thread's whole cost to the
	// finished month. Reviewed manually before any apply.
	printSection("CROSS-MONTH runs — manual review");
	const crossMonth = rows.flatMap((r) =>
		r.crossMonthRuns.map((c) => ({ ownerId: r.ownerId, run: c })),
	);
	if (crossMonth.length === 0) {
		console.log("  (none)");
	} else {
		printTable(
			[
				{ header: "email" },
				{ header: "runId" },
				{ header: "appId" },
				{ header: "started→finished" },
				{ header: "cost", align: "right" },
			],
			crossMonth.map(({ ownerId, run }) => [
				email(ownerId),
				run.runId,
				run.appId,
				`${run.startedPeriod} → ${run.finishedPeriod}`,
				usd(run.costEstimate),
			]),
		);
	}

	// 3c. Current-month cells whose re-baseline would trip the live $50
	// backstop — loud, because it re-blocks the very users a reset unblocked.
	printSection("CURRENT-MONTH over $50 — would re-block");
	const reblock = rows.filter((r) => r.overBackstopCurrentMonth);
	if (reblock.length === 0) {
		console.log("  (none)");
	} else {
		printTable(
			[
				{ header: "email" },
				{ header: "period" },
				{ header: "ledger_sum", align: "right" },
				{ header: "current", align: "right" },
			],
			reblock.map((r) => [
				email(r.ownerId),
				r.period,
				usd(r.ledgerSum),
				usd(r.current),
			]),
		);
	}

	// 3d. The re-baseline preview — every cell whose cost would actually move.
	// Filtered at the SAME `MATERIAL_DELTA_USD` cut the migrator's planner uses
	// (NOT `!== 0`): `ledgerSum` and `current` are the same multiset summed in
	// different orders, and float addition is non-associative — so a cell whose
	// TRUE delta is zero can carry ~1e-14 noise that survives `!== 0` and renders
	// as a misleading `+$0.0000` move. Sharing the constant makes the preview and
	// the apply list the exact same moved cells.
	printSection("Non-zero deltas — the re-baseline preview");
	const moved = rows.filter((r) => Math.abs(r.delta) >= MATERIAL_DELTA_USD);
	if (moved.length === 0) {
		console.log("  (none)");
	} else {
		printTable(
			[
				{ header: "email" },
				{ header: "period" },
				{ header: "current", align: "right" },
				{ header: "→ ledger_sum", align: "right" },
				{ header: "delta", align: "right" },
			],
			moved.map((r) => [
				email(r.ownerId),
				r.period,
				usd(r.current),
				usd(r.ledgerSum),
				signedUsd(r.delta),
			]),
		);
	}

	// ── 4. Recorded cross-checks ──────────────────────────────────────
	// Live-read the recorded users' usage fields and print them next to the
	// ledger sum THIS scan computed for the same cell — the sums come from the
	// pipeline's own `rows`, so a match validates the whole read→reconcile path.
	printSection("Recorded cross-checks");
	const ledgerSumOf = (ownerId: string, period: string): number | null => {
		const cell = rows.find((r) => r.ownerId === ownerId && r.period === period);
		return cell ? cell.ledgerSum : null;
	};

	for (const xc of CROSS_CHECKS) {
		const snap = await db
			.collection("usage")
			.doc(xc.userId)
			.collection("months")
			.doc(xc.period)
			.get();
		const u = snap.exists ? (snap.data() as UsageDocFields) : undefined;
		const recorded = u?.[xc.field];
		const ledger = ledgerSumOf(xc.userId, xc.period);
		console.log(
			`  ${xc.label} ${xc.period} usage.${xc.field}: ${
				recorded === undefined ? "(absent)" : usd(recorded)
			}   |   scan ledger-sum: ${ledger === null ? "(no runs)" : usd(ledger)}`,
		);
	}

	// The April orphan field — printed so the user can confirm the
	// guarded orphan-delete precondition later (re-baselined >= orphan).
	const orphanSnap = await db
		.collection("usage")
		.doc(ORPHAN.userId)
		.collection("months")
		.doc(ORPHAN.period)
		.get();
	const orphanData = orphanSnap.exists
		? (orphanSnap.data() as UsageDocFields)
		: undefined;
	const orphanValue = orphanData?.unadjusted_estimate;
	const orphanLedger = ledgerSumOf(ORPHAN.userId, ORPHAN.period);
	console.log(
		`  ${ORPHAN.label} ${ORPHAN.period} usage.unadjusted_estimate (orphan): ${
			orphanValue === undefined ? "(absent)" : usd(orphanValue)
		}   |   scan ledger-sum: ${
			orphanLedger === null ? "(no runs)" : usd(orphanLedger)
		}`,
	);
}

/**
 * Format a signed USD delta. `usd` always renders a magnitude, so the sign is
 * prefixed here: `+$1.0000` / `−$1.0000` (Unicode minus) / `$0.0000`.
 */
function signedUsd(delta: number): string {
	if (delta === 0) return usd(0);
	const sign = delta > 0 ? "+" : "−";
	return `${sign}${usd(Math.abs(delta))}`;
}

runMain(main);
