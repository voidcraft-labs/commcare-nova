/**
 * Backfill / repair the media reverse index (`referencingAppIds`).
 *
 * The delete reference guard reads each asset's `referencingAppIds` — the set of
 * apps whose persisted blueprint references it — instead of loading every one of
 * the owner's apps (a measured ~8s scan on an 83-app account). New asset rows are
 * born `[]` and the blueprint writers `arrayUnion` app ids as references appear,
 * but rows written BEFORE the index shipped have the field ABSENT. For those the
 * guard full-scans (correct, slow) — UNTIL a writer arrayUnions one app onto the
 * absent field, which makes it DEFINED-but-partial and retires the fallback. So
 * this must run as part of the deploy, before the writers start partial-filling.
 *
 * It derives references exactly as production does — `collectAssetRefs` over each
 * live app's blueprint — so the backfilled set matches what app re-saves produce.
 *
 * SAFE TO RE-RUN AGAINST LIVE TRAFFIC. The writes mirror production's semantics:
 *   - Referenced asset → `arrayUnion(...apps)`: ADDITIVE, so a concurrent save
 *     that adds an app id between the scan and the write is never clobbered.
 *   - Unreferenced asset → set `[]` ONLY when the field is still absent, guarded
 *     by a `lastUpdateTime` precondition so a concurrent edge (an app that just
 *     started referencing it) aborts the `[]` write instead of dropping the edge.
 *   - An already-correct row is skipped (idempotent).
 * Owner-AGNOSTIC, matching production: an app is credited to every asset it
 * references regardless of owner (the guard filters foreign apps at read time).
 *
 * Dry-run by default (reads only, prints what it WOULD write). Pass `--apply` to
 * write. `--owner <id>` scopes which ASSETS get rewritten; the app scan that
 * builds the reference map always covers every app (so a cross-owner reference
 * can't be missed).
 *
 *   npx tsx scripts/backfill-media-reference-index.ts                 # dry run
 *   npx tsx scripts/backfill-media-reference-index.ts --apply         # write all
 *   npx tsx scripts/backfill-media-reference-index.ts --owner <id> --apply
 */
import type { DocumentSnapshot, Query } from "@google-cloud/firestore";
import { FieldValue } from "@google-cloud/firestore";
import { Command } from "commander";
import { collectAssetRefs } from "../lib/domain/mediaRefs";
import { db, hydrateBlueprint } from "./lib/firestore";
import { runMain } from "./lib/main";

interface Options {
	apply?: boolean;
	owner?: string;
}

const program = new Command();
program
	.description("Backfill / repair the media reverse index (referencingAppIds)")
	.option("--apply", "write to Firestore (default: dry run)")
	.option("--owner <userId>", "scope which assets get rewritten to one owner");
program.parse();
const opts = program.opts<Options>();

/** Max asset writes in flight at once — bounds concurrency on a large run. */
const WRITE_CONCURRENCY = 20;

interface Counts {
	total: number;
	referenced: number;
	wrote: number;
	skippedConcurrent: number;
	errors: number;
}

/** gRPC status codes the Firestore SDK puts on a rejected write's `.code`. */
const GRPC_NOT_FOUND = 5;
const GRPC_FAILED_PRECONDITION = 9;

function grpcCode(err: unknown): number | undefined {
	return typeof err === "object" && err !== null && "code" in err
		? (err as { code?: number }).code
		: undefined;
}

/**
 * The outcome of reconciling one asset — for counts + reporting. `reconcileAsset`
 * NEVER throws (every write is caught + classified), so one asset's failure can't
 * abort the streamed pass: a deploy-gating backfill that crashed on a single bad
 * row would be worse than one that reports what it couldn't do.
 */
type Action =
	| "arrayUnion" // referenced → app ids added (or would be, in dry-run)
	| "init-empty" // unreferenced + absent → field initialized to []
	| "skip" // already correct
	| "skip-gone" // row concurrently hard-deleted — no edge owed, benign
	| "skip-concurrent" // a concurrent edit beat us; correct to leave it
	| "error"; // a real, non-transient write failure (logged)

/**
 * Reconcile one asset's `referencingAppIds` against the derived `target` set.
 * Never clobbers a concurrent edge: referenced → additive arrayUnion;
 * unreferenced → `[]` guarded by a `lastUpdateTime` precondition. Throw-free —
 * write failures are classified, not propagated.
 */
async function reconcileAsset(
	snap: DocumentSnapshot,
	target: string[],
	apply: boolean,
): Promise<Action> {
	const current = snap.get("referencingAppIds") as string[] | undefined;

	if (target.length > 0) {
		// Referenced. Skip if every target app is already recorded (idempotent).
		if (current && target.every((id) => current.includes(id))) return "skip";
		if (!apply) return "arrayUnion";
		try {
			await snap.ref.update({
				referencingAppIds: FieldValue.arrayUnion(...target),
			});
			return "arrayUnion";
		} catch (err) {
			// A concurrent hard-delete of the row (NOT_FOUND) is benign — the asset
			// is gone, so no edge is owed. Anything else is a real failure.
			if (grpcCode(err) === GRPC_NOT_FOUND) return "skip-gone";
			console.warn(`  ! ${snap.id}: arrayUnion failed`, err);
			return "error";
		}
	}

	// Unreferenced. Only job is to make the field DEFINED (`[]`) so the guard
	// doesn't full-scan; leave any production-written value alone.
	if (current !== undefined) return "skip";
	if (!apply) return "init-empty";
	try {
		await snap.ref.update(
			{ referencingAppIds: [] },
			// Abort if a concurrent write touched the doc since the read — that write
			// is an app starting to reference it, which we must not clobber.
			{ lastUpdateTime: snap.updateTime },
		);
		return "init-empty";
	} catch (err) {
		// ONLY a precondition abort (a concurrent edit) is a benign "skip + re-run".
		// A NOT_FOUND is a concurrent delete (benign). Any OTHER code — permission,
		// quota, invalid — is a real failure that a re-run won't fix, so surface it
		// rather than mislabel it as a transient concurrency skip.
		const code = grpcCode(err);
		if (code === GRPC_FAILED_PRECONDITION) return "skip-concurrent";
		if (code === GRPC_NOT_FOUND) return "skip-gone";
		console.warn(`  ! ${snap.id}: init-[] failed`, err);
		return "error";
	}
}

async function main() {
	const apply = opts.apply === true;
	console.log(
		apply
			? "backfill-media-reference-index — APPLY (writes to Firestore)"
			: "backfill-media-reference-index — SCAN (dry run, read-only)",
	);
	if (opts.owner) console.log(`scope: assets owned by ${opts.owner}`);

	// ── Pass 1: stream EVERY live app, build assetId → Set<appId> ──
	// Always all apps (never owner-scoped) so a cross-owner reference can't be
	// missed. Streamed so a large `apps` collection never lands in memory at once.
	const refMap = new Map<string, Set<string>>();
	let appsScanned = 0;
	let appsWithMedia = 0;
	const appsStream = db
		.collection("apps")
		.where("deleted_at", "==", null)
		.stream() as AsyncIterable<DocumentSnapshot>;
	let appsUnreadable = 0;
	for await (const snap of appsStream) {
		appsScanned += 1;
		const blueprint = snap.get("blueprint");
		if (!blueprint || typeof blueprint !== "object") continue;
		// Per-app best-effort, mirroring production's `syncMediaReferences`: a single
		// legacy/structurally-off blueprint that throws in the walk must not abort
		// the whole deploy-gating pass — count it and move on.
		let assetIds: Set<string>;
		try {
			assetIds = collectAssetRefs(hydrateBlueprint(blueprint));
		} catch (err) {
			appsUnreadable += 1;
			console.warn(`  ! app ${snap.id}: blueprint walk failed`, err);
			continue;
		}
		if (assetIds.size === 0) continue;
		appsWithMedia += 1;
		for (const assetId of assetIds) {
			const apps = refMap.get(assetId) ?? new Set<string>();
			apps.add(snap.id);
			refMap.set(assetId, apps);
		}
	}
	if (appsUnreadable > 0) {
		console.warn(`  (${appsUnreadable} app blueprint(s) could not be walked)`);
	}
	console.log(
		`apps scanned: ${appsScanned}  (${appsWithMedia} reference media)  · referenced assets: ${refMap.size}`,
	);

	// ── Pass 2: stream assets, reconcile each (bounded concurrency) ──
	let assetsQuery: Query = db.collection("mediaAssets");
	if (opts.owner) assetsQuery = assetsQuery.where("owner", "==", opts.owner);
	const counts: Counts = {
		total: 0,
		referenced: 0,
		wrote: 0,
		skippedConcurrent: 0,
		errors: 0,
	};
	let inflight: Promise<void>[] = [];
	// NOT named `process` — that would shadow Node's global `process` for the rest
	// of `main`, so the `process.exitCode = 1` below would set an expando on this
	// arrow function instead of the real process and the error exit code would be
	// silently lost.
	const processAsset = async (snap: DocumentSnapshot) => {
		const target = [...(refMap.get(snap.id) ?? [])].sort();
		if (target.length > 0) {
			counts.referenced += 1;
			console.log(`  ${snap.id} → [${target.join(", ")}]`);
		}
		const action = await reconcileAsset(snap, target, apply);
		if (action === "arrayUnion" || action === "init-empty") counts.wrote += 1;
		if (action === "skip-concurrent") counts.skippedConcurrent += 1;
		if (action === "error") counts.errors += 1;
	};
	const assetsStream = assetsQuery.stream() as AsyncIterable<DocumentSnapshot>;
	for await (const snap of assetsStream) {
		counts.total += 1;
		inflight.push(processAsset(snap));
		if (inflight.length >= WRITE_CONCURRENCY) {
			await Promise.all(inflight);
			inflight = [];
		}
	}
	await Promise.all(inflight);

	console.log("");
	console.log(`assets total:        ${counts.total}`);
	console.log(`assets referenced:   ${counts.referenced}`);
	if (!apply) {
		console.log(`assets needing write: ${counts.wrote}`);
		console.log("\nmode: dry run — nothing written. Pass --apply to write.");
		return;
	}
	console.log(`assets written:      ${counts.wrote}`);
	if (counts.skippedConcurrent > 0) {
		console.log(
			`assets skipped:      ${counts.skippedConcurrent}  (concurrent edit — re-run to pick up)`,
		);
	}
	// A real (non-transient) write failure must NOT report as success — a deploy
	// gate keys on the exit code, and a re-run won't fix a permission/quota error.
	if (counts.errors > 0) {
		console.error(
			`\n${counts.errors} asset(s) FAILED to write (see warnings above). The index is incomplete; fix the cause before relying on the fast delete path.`,
		);
		process.exitCode = 1;
	}
}

runMain(main);
