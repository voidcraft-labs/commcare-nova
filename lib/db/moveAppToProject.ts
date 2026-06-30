// lib/db/moveAppToProject.ts
//
// Move an app from one Project to another — the cross-store orchestrator behind
// the `moveApp` Server Action (`app/(app)/(site)/app-actions.ts`). An app's
// `project_id` is the tenant key for THREE stores at once (the Firestore app doc,
// the Postgres `cases` rows, and the Project-scoped media assets), so a move has
// to re-tenant all three in lockstep or the app silently breaks in its new home.
//
// Commit-last: `AppDoc.project_id` is the single authority every authz path reads
// and the join key list queries use, so the dependent writes — media copied into
// the destination (Step A), case rows re-tenanted (Step B) — happen BEFORE the
// `project_id` flip (Step C), which is the atomic commit point. The app is
// reachable under exactly one Project at every instant (source before the flip,
// destination after), and a crash before the flip self-heals on re-run because
// every step is idempotent. The one transient — case rows at the destination
// while the doc still points at the source — degrades only the source view (the
// app is leaving it anyway) and closes the moment Step C commits.
//
// Authorization is the Server Action's job (`delete` on the source, `edit` on the
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
 * The most times the orchestrator copies-then-commits before forcing the move
 * through. Each extra pass exists only to absorb a media ref a concurrent edit
 * adds AFTER that pass's copy step; the final pass commits regardless so the move
 * always reaches a consistent end state (see `commitAppProjectMove`'s
 * `allowUnresolved`). Two is ample — it would take a fresh concurrent media edit
 * landing inside the millisecond-wide commit window of every pass to exhaust it.
 */
const MAX_COMMIT_ATTEMPTS = 2;

/**
 * Move `appId` from `fromProjectId` to `toProjectId`, re-tenanting its case data
 * and media to match. Idempotent: a re-run after any partial failure converges
 * (media dedups on the destination, case re-tenant matches zero rows once moved,
 * the commit no-ops when already at the destination).
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
	if (app.project_id === args.toProjectId) return; // already moved
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

	for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
		// Re-read each attempt so a concurrent edit's newly-added media ref is
		// picked up by the copy step on the retry.
		const fresh = attempt === 1 ? app : await loadApp(args.appId);
		if (!fresh)
			throw new Error(`[moveAppToProject] app vanished: ${args.appId}`);
		if (fresh.project_id === args.toProjectId) return;

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

		// Step B — re-tenant the Postgres case rows.
		await retenantAppCases({
			appId: args.appId,
			fromProjectId: args.fromProjectId,
			toProjectId: args.toProjectId,
		});

		// Step C — repoint the blueprint + flip `project_id`, atomically.
		const result = await commitAppProjectMove(args.appId, {
			toProjectId: args.toProjectId,
			expectedFromProjectId: args.fromProjectId,
			assetIdMap,
			attemptedRealIds,
			allowUnresolved: attempt === MAX_COMMIT_ATTEMPTS,
		});
		if (result.kind === "moved" || result.kind === "already_moved") return;

		// `media_stale`: a concurrent edit added a ref after this pass's copy.
		// Loop to re-copy it (now in `attemptedRealIds`) and re-commit.
		log.warn("[moveAppToProject] media changed mid-move; retrying", {
			appId: args.appId,
			missing: result.missing,
		});
	}
}
