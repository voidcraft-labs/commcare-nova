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
import { creditReconcile, type RunInput } from "./lib/creditReconcile";
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

// ── Firestore read shapes ───────────────────────────────────────────

/** The run-summary fields this scan reads, typed off a raw `.data()`. */
interface RunDocFields {
	runId?: string;
	costEstimate?: number;
	startedAt?: string;
	finishedAt?: string;
}

/** The app fields the owner/soft-delete join reads. */
interface AppDocFields {
	owner?: string;
	deleted_at?: string | null;
}

/** The usage fields the scan reads — including the off-schema orphan. */
interface UsageDocFields {
	cost_estimate?: number;
	unadjusted_estimate?: number;
}

/** A run doc paired with the appId resolved from its document path. */
interface RawRun {
	appId: string;
	runId: string;
	costEstimate: number;
	startedPeriod: string;
	finishedPeriod: string;
}

// ── Batch-read helpers (guard the empty case) ───────────────────────

/**
 * Chunked `getAll` over a list of refs. `db.getAll([])` THROWS ("At least one
 * document reference is required"), so the empty case short-circuits to `[]`.
 * Firestore caps `getAll` at 1000 refs per call; chunk to stay under it.
 */
async function getAllChunked(
	refs: FirebaseFirestore.DocumentReference[],
): Promise<FirebaseFirestore.DocumentSnapshot[]> {
	if (refs.length === 0) return [];
	const CHUNK = 300;
	const out: FirebaseFirestore.DocumentSnapshot[] = [];
	for (let i = 0; i < refs.length; i += CHUNK) {
		const snaps = await db.getAll(...refs.slice(i, i + CHUNK));
		out.push(...snaps);
	}
	return out;
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	printHeader("CREDIT RE-BASELINE SCAN (read-only)");

	// ── 1. Read every run doc across all apps (collection group) ──────
	const runsSnap = await db.collectionGroup("runs").get();

	let missingFieldSkips = 0;
	const rawRuns: RawRun[] = [];
	const appIds = new Set<string>();

	for (const doc of runsSnap.docs) {
		// `apps/{appId}/runs/{runId}` — the appId is the grandparent doc id.
		const appId = doc.ref.parent?.parent?.id;
		const data = doc.data() as RunDocFields;
		const cost = data.costEstimate;
		// Old or partial run docs may lack the fields we read. A missing
		// `startedAt`/`finishedAt` would crash `.slice(0, 7)` and take down the
		// whole scan, so skip-and-count rather than throw. The cost check is
		// `Number.isFinite` (not `typeof "number"`) because NaN/Infinity are
		// both numbers: a non-finite cost would render `$NaN` and, since
		// `NaN >= backstop` is false, silently leave a genuinely over-backstop
		// current-month cell UNFLAGGED — the one outcome this scan must never
		// miss. Unreachable from the normal pipeline (Zod rejects non-finite on
		// read), but free and matches the file's rigor. The `typeof` arm does the
		// TS narrowing (`Number.isFinite`'s lib signature takes `unknown` and
		// returns a plain `boolean`, so it can't narrow on its own); the
		// `isFinite` arm adds the NaN/Infinity rejection.
		if (
			appId === undefined ||
			typeof cost !== "number" ||
			!Number.isFinite(cost) ||
			typeof data.startedAt !== "string" ||
			typeof data.finishedAt !== "string"
		) {
			missingFieldSkips++;
			continue;
		}
		appIds.add(appId);
		rawRuns.push({
			appId,
			runId: data.runId ?? doc.id,
			costEstimate: cost,
			// A period is the yyyy-mm prefix of the ISO timestamp.
			startedPeriod: data.startedAt.slice(0, 7),
			finishedPeriod: data.finishedAt.slice(0, 7),
		});
	}

	// ── 2. Join each run to its app (owner + soft-delete signal) ──────
	const appRefs = [...appIds].map((id) => db.collection("apps").doc(id));
	const appSnaps = await getAllChunked(appRefs);
	const appMeta = new Map<string, { ownerId: string; deleted: boolean }>();
	for (const snap of appSnaps) {
		if (!snap.exists) continue;
		const a = snap.data() as AppDocFields;
		if (typeof a.owner !== "string") continue;
		appMeta.set(snap.id, {
			ownerId: a.owner,
			// Soft-deleted apps' runs were real cost — included, just flagged.
			deleted: a.deleted_at != null,
		});
	}

	let orphanRunSkips = 0;
	const runs: RunInput[] = [];
	for (const r of rawRuns) {
		const meta = appMeta.get(r.appId);
		// A run whose app doc is missing (or owner-less) can't be attributed to
		// a user — skip and count it as an orphan.
		if (!meta) {
			orphanRunSkips++;
			continue;
		}
		runs.push({
			runId: r.runId,
			appId: r.appId,
			ownerId: meta.ownerId,
			deleted: meta.deleted,
			costEstimate: r.costEstimate,
			startedPeriod: r.startedPeriod,
			finishedPeriod: r.finishedPeriod,
		});
	}

	// ── 3. Read current usage for exactly the cells the ledger touches ─
	// Derive the distinct (owner, finishedPeriod) cell keys from the runs and
	// read usage for only those — never enumerate "all periods".
	const cellPairs = new Map<string, { ownerId: string; period: string }>();
	for (const r of runs) {
		cellPairs.set(`${r.ownerId}/${r.finishedPeriod}`, {
			ownerId: r.ownerId,
			period: r.finishedPeriod,
		});
	}
	const usageRefs = [...cellPairs.values()].map((c) =>
		db.collection("usage").doc(c.ownerId).collection("months").doc(c.period),
	);
	const usageSnaps = await getAllChunked(usageRefs);
	const currentUsage = new Map<string, number>();
	for (const snap of usageSnaps) {
		if (!snap.exists) continue;
		const u = snap.data() as UsageDocFields;
		// `getAll` preserves request order, so the Nth snapshot maps to the Nth
		// ref/cellPair — but re-deriving the key from the snapshot's path is
		// order-independent and self-documenting: `usage/{owner}/months/{period}`.
		const ownerId = snap.ref.parent?.parent?.id;
		if (ownerId === undefined) continue;
		currentUsage.set(`${ownerId}/${snap.id}`, u.cost_estimate ?? 0);
	}

	// ── 4. Reconcile (pure) ───────────────────────────────────────────
	const currentPeriod = new Date().toISOString().slice(0, 7);
	const rows = creditReconcile(
		runs,
		currentUsage,
		currentPeriod,
		ACTUAL_COST_BACKSTOP_USD,
	);

	// ── 5. Resolve owner ids → emails for display ─────────────────────
	const ownerIds = [...new Set(rows.map((r) => r.ownerId))];
	const userRefs = ownerIds.map((id) => db.collection("auth_users").doc(id));
	const userSnaps = await getAllChunked(userRefs);
	const emailOf = new Map<string, string>();
	for (const snap of userSnaps) {
		if (!snap.exists) continue;
		const email = (snap.data() as { email?: string }).email;
		// Fall back to the id when a user record is missing/email-less.
		emailOf.set(snap.id, email ?? snap.id);
	}
	const email = (ownerId: string): string => emailOf.get(ownerId) ?? ownerId;

	// ── 6. Print scan summary ─────────────────────────────────────────
	console.log(`  Run docs scanned:        ${runsSnap.size}`);
	console.log(`  Skipped (missing field): ${missingFieldSkips}`);
	console.log(`  Skipped (orphan run):    ${orphanRunSkips}`);
	console.log(`  Distinct apps:           ${appIds.size}`);
	console.log(`  (owner, period) cells:   ${rows.length}`);
	console.log(`  Current period:          ${currentPeriod}`);
	console.log(`  Backstop:                ${usd(ACTUAL_COST_BACKSTOP_USD)}\n`);

	// 6a. Per-cell table — the full reconciliation.
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

	// 6b. Cross-month runs — these mis-attribute a thread's whole cost to the
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

	// 6c. Current-month cells whose re-baseline would trip the live $50
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

	// 6d. The re-baseline preview — every cell whose cost would actually move.
	// Threshold at half the last displayed (4-dp) digit, NOT `!== 0`:
	// `ledgerSum` (summed in collection-group order) and `current`
	// (server-accumulated via FieldValue.increment in completion order) are the
	// same multiset added in different orders, and float addition is
	// non-associative — so a cell whose TRUE delta is zero can carry ~1e-14
	// noise that survives `!== 0` and renders as a misleading `+$0.0000` move.
	printSection("Non-zero deltas — the re-baseline preview");
	const moved = rows.filter((r) => Math.abs(r.delta) >= 0.00005);
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

	// ── 7. Recorded cross-checks ──────────────────────────────────────
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
