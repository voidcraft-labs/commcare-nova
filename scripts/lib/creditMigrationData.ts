/**
 * Shared PROD read loader for the credit re-baseline migration.
 *
 * The read-only SCAN (`inspect-credit-migration.ts`, which PREVIEWS the
 * re-baseline) and the guarded MIGRATOR (`migrate-actual-cost.ts`, which APPLIES
 * it) must read PROD identically — a preview that reads differently from the
 * apply is worse than no preview. This module is that single read path: both
 * callers drive `creditReconcile` / `planRebaseline` off the exact same
 * `{ runs, currentUsage, currentPeriod, emailOf }`, so the preview can never
 * diverge from what the apply will do.
 *
 * Strictly READ-ONLY. Like the scan, it issues no `.set` / `.update` / `.delete`
 * and constructs no `FieldValue` sentinel — it only reads. The pure
 * reconciliation it feeds lives in `./creditReconcile` (no Firestore, no I/O).
 */

import type { RunInput } from "./creditReconcile";
import { db } from "./firestore";

// ── Firestore read shapes (typed off raw `.data()`) ─────────────────

/** The run-summary fields this loader reads, typed off a raw `.data()`. */
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

/**
 * The usage fields read off a cell — including the off-schema orphan. Exported
 * so the scan's recorded cross-check / orphan reads cast against the SAME shape
 * rather than re-declaring it (the off-schema `unadjusted_estimate` lives here
 * because it's a leftover from a manual reset, absent from `usageDocSchema`).
 */
export interface UsageDocFields {
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

/**
 * The full read result the scan and migrator both consume.
 *
 * `runs` / `currentUsage` / `currentPeriod` feed `creditReconcile`; `emailOf`
 * maps owner id → REAL email (the `--current-user` opt-in match key). It holds
 * ONLY owners that actually have an email — an absent owner has no resolvable
 * email and must never be opted in, so callers needing a display label apply
 * their own `?? ownerId` fallback at the print site, not in this match map. The
 * four skip/scope counts are RETURNED (not logged here) so the scan prints them
 * in its own summary block unchanged — the loader stays a pure reader with no
 * console output of its own.
 */
export interface ReconciliationData {
	runs: RunInput[];
	currentUsage: Map<string, number>;
	currentPeriod: string;
	emailOf: Map<string, string>;
	/** Total run docs scanned across the collection group. */
	runDocsScanned: number;
	/** Runs skipped for missing/non-finite fields (can't be attributed). */
	missingFieldSkips: number;
	/** Runs whose app doc is missing/owner-less (can't be attributed to a user). */
	orphanRunSkips: number;
	/** Distinct apps that contributed at least one attributable run. */
	distinctApps: number;
}

// ── Batch-read helper (guards the empty case) ───────────────────────

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

// ── The shared load ─────────────────────────────────────────────────

/**
 * Read the whole fleet's run-ledger and current usage from PROD and shape it for
 * reconciliation. This is the read block lifted verbatim out of the scan so the
 * scan and migrator share ONE source of truth for what they reconcile.
 */
export async function loadReconciliationData(): Promise<ReconciliationData> {
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
		// whole load, so skip-and-count rather than throw. The cost check is
		// `Number.isFinite` (not `typeof "number"`) because NaN/Infinity are
		// both numbers: a non-finite cost would render `$NaN` and, since
		// `NaN >= backstop` is false, silently leave a genuinely over-backstop
		// current-month cell UNFLAGGED — the one outcome this load must never
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

	// ── 4. Resolve owner ids → emails ─────────────────────────────────
	// Keyed off `runs` (not reconciled rows) because the load runs BEFORE
	// reconcile. The owner set is identical either way — every reconciled cell's
	// owner is some run's owner and vice versa — so callers see the same emails.
	const ownerIds = [...new Set(runs.map((r) => r.ownerId))];
	const userRefs = ownerIds.map((id) => db.collection("auth_users").doc(id));
	const userSnaps = await getAllChunked(userRefs);
	// A REAL-email map: only owners with an actual email are entered. An owner
	// whose `auth_users` doc is missing OR present-but-email-less is simply absent
	// here — both fold to "" at the match site, which is the documented opt-in
	// fail-safe (no current-month write for an unresolvable owner). The owner-id
	// fallback for DISPLAY lives at the print sites, not in this match map.
	const emailOf = new Map<string, string>();
	for (const snap of userSnaps) {
		if (!snap.exists) continue;
		const email = (snap.data() as { email?: string }).email;
		if (email) emailOf.set(snap.id, email);
	}

	const currentPeriod = new Date().toISOString().slice(0, 7);

	return {
		runs,
		currentUsage,
		currentPeriod,
		emailOf,
		runDocsScanned: runsSnap.size,
		missingFieldSkips,
		orphanRunSkips,
		distinctApps: appIds.size,
	};
}
