// lib/db/moveAppToProject.ts
//
// Move an app from one Project to another — the cross-store orchestrator behind
// the `moveApp` Server Action (`app/(app)/(site)/app-actions.ts`). An app's
// `project_id` is the tenant key for THREE stores at once (the Firestore app doc,
// the Postgres `cases` rows, and the Project-scoped media assets), so a move has
// to re-tenant all three or the app silently breaks in its new home.
//
// Flip-first, cases-follow. `AppDoc.project_id` is the single authority every
// authz path reads and the join key list queries use, so it is also the
// concurrency arbiter: the order is
//   A. copy the referenced media into the destination Project (non-destructive),
//   B. the guarded commit — repoint the blueprint's media refs onto the copies and
//      flip `project_id`, in ONE Firestore transaction, AND
//   C. re-tenant the case rows to wherever the app doc now lives, keyed by
//      `app_id` and idempotent.
// The flip (B) is the commit point: of two concurrent moves only one transaction
// can flip the doc, and the loser aborts on source-drift BEFORE step C — so the
// case rows are never moved on behalf of a move whose flip didn't win, and can't
// be stranded under a different Project than the doc. Step C keys on `app_id` (not
// a source Project) and targets the committed Project, so a crash between B and C,
// or a retry after one, converges: the cases follow the doc wherever it landed.
// The one transient is the destination briefly seeing the app before its cases
// arrive (it's mid-move), which closes the instant C runs and self-heals on re-run.
//
// Authorization is the Server Action's job (owner of the source, edit on the
// destination); this orchestrator trusts its caller and only guards data-shape
// preconditions (already-moved, source drift, mid-generation, trashed).

import { retenantAppCases } from "@/lib/case-store";
import { isBuiltinIconRef } from "@/lib/domain/builtinIcons";
import { asWalkableDoc, collectAssetRefs } from "@/lib/domain/mediaRefs";
import { log } from "@/lib/logger";
import { copyAssetsIntoProject } from "@/lib/media/moveMedia";
import { commitAppProjectMove, loadApp } from "./apps";
import type { AppDoc } from "./types";

/** The app is mid-generation; a move would race the build's blueprint writes. */
export class AppBusyError extends Error {
	readonly name = "AppBusyError";
	constructor() {
		super("Cannot move an app while it is being generated.");
	}
}

/**
 * How many times the flip step copies-then-commits before giving up. The only
 * reason to retry is a concurrent edit that adds a media ref AFTER a pass's copy
 * step; the retry re-copies it and re-commits. Because the commit writes nothing
 * until the media resolves, an exhausted retry leaves the app untouched (the move
 * simply fails and the user retries) — no half-moved state. Two is ample: it
 * takes a fresh concurrent media edit inside the commit window of every pass.
 */
const MAX_COMMIT_ATTEMPTS = 2;

/**
 * Move `appId` from `fromProjectId` to `toProjectId`, re-tenanting its case data
 * and media to match. Idempotent: a re-run after any partial failure converges
 * (media dedups on the destination, the flip no-ops once the doc is at the
 * destination, and the case re-tenant always reconciles the rows to the doc).
 */
export async function moveAppToProject(args: {
	appId: string;
	fromProjectId: string;
	toProjectId: string;
	actorUserId: string;
	/** Pre-loaded by the Server Action's source authz, to skip a re-read. */
	app?: AppDoc;
}): Promise<void> {
	const app = args.app ?? (await loadApp(args.appId));
	if (!app) {
		throw new Error(`[moveAppToProject] app not found: ${args.appId}`);
	}

	// Flip the app doc to the destination, unless it is already there (a prior
	// move's flip committed, or a concurrent move won). When already there we
	// still fall through to the case re-tenant below, which is what heals a crash
	// between the flip and the re-tenant.
	if (app.project_id !== args.toProjectId) {
		if (app.project_id !== args.fromProjectId) {
			throw new Error(
				`[moveAppToProject] source Project mismatch for ${args.appId} (expected ${args.fromProjectId}, found ${app.project_id ?? "null"})`,
			);
		}
		if (app.status === "generating") throw new AppBusyError();
		if (app.deleted_at !== null) {
			throw new Error(
				`[moveAppToProject] cannot move a deleted app: ${args.appId} (restore it first)`,
			);
		}

		let flipped = false;
		for (
			let attempt = 1;
			attempt <= MAX_COMMIT_ATTEMPTS && !flipped;
			attempt++
		) {
			// Re-read each attempt so a concurrent edit's newly-added media ref is
			// picked up by the copy step on the retry.
			const fresh = attempt === 1 ? app : await loadApp(args.appId);
			if (!fresh) {
				throw new Error(`[moveAppToProject] app vanished: ${args.appId}`);
			}
			if (fresh.project_id === args.toProjectId) break; // a concurrent move won

			const refs = [...collectAssetRefs(asWalkableDoc(fresh.blueprint))];
			const attemptedRealIds = new Set(
				refs.filter((id) => !isBuiltinIconRef(id)),
			);

			// Step A — copy referenced media into the destination Project.
			const assetIdMap = await copyAssetsIntoProject({
				assetIds: refs,
				fromProjectId: args.fromProjectId,
				toProjectId: args.toProjectId,
				actorUserId: args.actorUserId,
			});

			// Step B — repoint the blueprint + flip `project_id`, atomically.
			const result = await commitAppProjectMove(args.appId, {
				toProjectId: args.toProjectId,
				expectedFromProjectId: args.fromProjectId,
				assetIdMap,
				attemptedRealIds,
			});
			if (result.kind === "moved" || result.kind === "already_moved") {
				flipped = true;
				break;
			}

			// `media_stale`: a concurrent edit added a ref after this pass's copy.
			// Loop to re-copy it (now in `attemptedRealIds`) and re-commit. Nothing
			// has been written yet, so an exhausted loop leaves the app untouched.
			log.warn("[moveAppToProject] media changed mid-move; retrying", {
				appId: args.appId,
				missing: result.missing,
			});
		}

		if (!flipped) {
			throw new Error(
				`[moveAppToProject] media kept changing during the move of ${args.appId}; aborted after ${MAX_COMMIT_ATTEMPTS} attempts (nothing moved)`,
			);
		}
	}

	// Step C — reconcile the case rows to the app's committed Project. Keyed by
	// `app_id` and idempotent (it moves every row not already at the destination),
	// so it converges whether the flip just happened, a prior move crashed between
	// the flip and here, or the app was already at the destination.
	await retenantAppCases({ appId: args.appId, toProjectId: args.toProjectId });
}
