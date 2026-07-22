// lib/db/moveAppToProject.ts
//
// Move an app from one Project to another — the cross-store orchestrator behind
// the `moveApp` Server Action (`app/(app)/(site)/app-actions.ts`). An app's
// `project_id` is the tenant key for THREE stores at once (the `apps` row, the
// `cases` rows, and the Project-scoped media assets), so a move has to
// re-tenant all three or the app silently breaks in its new home.
//
// Flip-first, cases-follow. `AppDoc.project_id` is the single authority every
// authz path reads and the join key list queries use, so it is also the
// concurrency arbiter: the order is
//   A. copy the referenced media into the destination Project (non-destructive),
//   B. the guarded commit — repoint the blueprint's media refs onto the copies and
//      flip `project_id`, in ONE commit transaction, AND
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
// S01 TEMPORARY POLICY: every true cross-Project request is rejected at this
// boundary before media copying. The Server Action performs the same policy
// check after source authorization, but the orchestrator owns an independent
// guard so another server caller cannot bypass it. Exact same-Project calls keep
// the idempotent case-row reconciliation path for historical partial moves.

import { retenantAppCases } from "@/lib/case-store";
import { isBuiltinIconRef } from "@/lib/domain/builtinIcons";
import { asWalkableDoc, collectMovableAssetRefs } from "@/lib/domain/mediaRefs";
import { log } from "@/lib/logger";
import { copyAssetsIntoProject } from "@/lib/media/moveMedia";
import {
	appProjectMovePolicy,
	CROSS_PROJECT_MOVE_UNAVAILABLE_CODE,
	CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE,
} from "@/lib/projects/moveTargets";
import { commitAppProjectMove, loadApp } from "./apps";

/** The app is mid-generation; a move would race the build's blueprint writes. */
export class AppBusyError extends Error {
	readonly name = "AppBusyError";
	constructor() {
		super("Cannot move an app while it is being generated.");
	}
}

/** Defense-in-depth refusal for the temporary S01 cross-Project move block. */
export class CrossProjectAppMoveBlockedError extends Error {
	readonly name = "CrossProjectAppMoveBlockedError";
	readonly code = CROSS_PROJECT_MOVE_UNAVAILABLE_CODE;

	constructor() {
		super(CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE);
	}
}

/**
 * Re-tenanting the Postgres case rows failed after all retries. During S01 the
 * only reachable path is an exact same-Project recovery, so the rows remain
 * intact and retryable; the type lets the Server Action give specific recovery
 * guidance without claiming that a move occurred.
 */
export class CaseDataStrandedError extends Error {
	readonly name = "CaseDataStrandedError";
	constructor() {
		super("App case data could not be synced to its Project.");
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
 * How many times the case re-tenant (Step C) is retried before giving up. Unlike
 * the flip, Step C runs AFTER the app doc has already committed to the
 * destination, so a transient Cloud SQL error here can't be cleanly undone — the
 * retries (with a short backoff) absorb a connection drop / pool blip so the
 * common case self-completes; a sustained failure logs at `error` (the rows are
 * recoverable by any later move of the app) and surfaces as a failed move.
 */
const MAX_RETENANT_ATTEMPTS = 3;
const RETENANT_RETRY_DELAY_MS = 250;

/**
 * Reconcile the app's tenant state. S01 permits only exact same-Project recovery;
 * the dormant cross-Project saga remains below for S02 to replace with its
 * reference-aware admission rule.
 */
export async function moveAppToProject(args: {
	appId: string;
	fromProjectId: string;
	toProjectId: string;
	actorUserId: string;
}): Promise<void> {
	const policy = appProjectMovePolicy(args.fromProjectId, args.toProjectId);
	if (policy.kind === "cross_project_blocked") {
		// This must precede every load/copy/commit side effect. The action's check is
		// the user-facing gate; this one protects all present and future server calls.
		throw new CrossProjectAppMoveBlockedError();
	}

	const app = await loadApp(args.appId);
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
			if (fresh.project_id === args.toProjectId) {
				// A concurrent move already flipped the doc to the destination. The
				// flip is done — still fall through to reconcile the case rows.
				flipped = true;
				break;
			}

			// One walk over the MOVABLE refs (every present id, including the gated
			// case-list slots `commitAppProjectMove`'s guard re-collects the same
			// way): the full set feeds the media copy, the real-only subset
			// (built-ins excluded) feeds the commit's concurrency guard.
			const walkable = asWalkableDoc(fresh.blueprint);
			const refs = [...collectMovableAssetRefs(walkable)];
			const attemptedRealIds = new Set(
				refs.filter((id) => !isBuiltinIconRef(id)),
			);

			// Step A — copy referenced media into the destination Project.
			const assetIdMap = await copyAssetsIntoProject({
				appId: args.appId,
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
			if (result.kind === "busy") {
				// A build started between the caller's authz read and the commit.
				throw new AppBusyError();
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
	// the flip and here, or the app was already at the destination. Retried,
	// because the flip already committed: a transient failure here would otherwise
	// leave the app at its destination with its case rows behind.
	let caseErr: unknown;
	for (let attempt = 1; attempt <= MAX_RETENANT_ATTEMPTS; attempt++) {
		try {
			await retenantAppCases({
				appId: args.appId,
				toProjectId: args.toProjectId,
			});
			return;
		} catch (err) {
			caseErr = err;
			if (attempt < MAX_RETENANT_ATTEMPTS) {
				await new Promise((resolve) =>
					setTimeout(resolve, RETENANT_RETRY_DELAY_MS * attempt),
				);
			}
		}
	}
	// Rows remain intact and a same-Project retry re-runs this idempotent repair.
	// Log loudly, then raise the typed error so the caller can give specific
	// recovery guidance without claiming a cross-Project move succeeded.
	log.error(
		"[moveAppToProject] case re-tenant failed after retries; case rows remain intact",
		caseErr,
		{ appId: args.appId, toProjectId: args.toProjectId },
	);
	throw new CaseDataStrandedError();
}
