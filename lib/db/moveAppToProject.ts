// Cross-Project move orchestration. Whether a true move may run is runtime
// state, read at the Server Action boundary and threaded in here;
// `lockProjectMoveCompatibility` re-reads the same switch inside the move
// transaction and remains the authority.

import { log } from "@/lib/logger";
import { copyAssetsIntoProject } from "@/lib/media/moveMedia";
import {
	appProjectMovePolicy,
	CROSS_PROJECT_MOVE_UNAVAILABLE_CODE,
	CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE,
} from "@/lib/projects/moveTargets";
import {
	commitAppProjectMove,
	normalizeReapableRunForProjectMove,
	prepareAppProjectMove,
	repairAppCaseTenancy,
} from "./apps";

/** A live or paused run currently owns the app. */
export class AppBusyError extends Error {
	readonly name = "AppBusyError";
	constructor() {
		super("Cannot move an app while a Solutions Architect run owns it.");
	}
}

/** A present run is neither active nor a canonical reaper target. */
export class AppRunStateCorruptError extends Error {
	readonly name = "AppRunStateCorruptError";
	constructor() {
		super(
			"The app has an inconsistent run holder and cannot move until it is repaired.",
		);
	}
}

/** Defense-in-depth refusal when the move switch is off. */
export class CrossProjectAppMoveBlockedError extends Error {
	readonly name = "CrossProjectAppMoveBlockedError";
	readonly code = CROSS_PROJECT_MOVE_UNAVAILABLE_CODE;

	constructor() {
		super(CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE);
	}
}

/** Retained for the existing action contract; atomic repair no longer strands. */
export class CaseDataStrandedError extends Error {
	readonly name = "CaseDataStrandedError";
	constructor() {
		super("App case data could not be synced to its Project.");
	}
}

const MAX_MOVE_ATTEMPTS = 4;

export interface MoveAppToProjectArgs {
	readonly appId: string;
	readonly fromProjectId: string;
	readonly toProjectId: string;
	readonly actorUserId: string;
}

/**
 * Production entry point. A cross-Project request with the switch off stops
 * before any database, media, or GCS work. Exact same-Project calls are not
 * moves: they take the app-locked case-only repair and derive the destination
 * from the fresh row.
 */
export async function moveAppToProject(
	args: MoveAppToProjectArgs & { readonly movesEnabled: boolean },
): Promise<void> {
	const policy = appProjectMovePolicy(
		args.fromProjectId,
		args.toProjectId,
		args.movesEnabled,
	);
	if (policy.kind === "cross_project_blocked") {
		throw new CrossProjectAppMoveBlockedError();
	}
	if (policy.kind === "cross_project_move") {
		await runCrossProjectMove(args);
		return;
	}
	await repairAppCaseTenancy(args.appId, args.actorUserId);
}

/**
 * The move itself: prepare under the app lock, copy media bytes outside the
 * transaction, then commit atomically — retrying when the app's run holder or
 * media closure changed underneath. Every database wrapper it calls declares
 * this runtime's real capabilities and re-proves admission, so calling it
 * directly with the switch off still fails closed.
 */
export async function runCrossProjectMove(
	args: MoveAppToProjectArgs,
): Promise<void> {
	for (let attempt = 1; attempt <= MAX_MOVE_ATTEMPTS; attempt++) {
		const preparation = await prepareAppProjectMove({
			appId: args.appId,
			expectedFromProjectId: args.fromProjectId,
			toProjectId: args.toProjectId,
			actorUserId: args.actorUserId,
		});
		if (preparation.kind === "already_moved") {
			await repairAppCaseTenancy(args.appId, args.actorUserId);
			return;
		}
		if (preparation.kind === "busy") throw new AppBusyError();
		if (preparation.kind === "corrupt_holder") {
			throw new AppRunStateCorruptError();
		}
		if (preparation.kind === "reapable") {
			await normalizeReapableRunForProjectMove(
				args.appId,
				preparation.identity,
			);
			continue;
		}

		const attemptedRealIds = new Set([
			...preparation.requiredAssetIds,
			...preparation.historicalAssetIds,
		]);
		const assetIdMap = await copyAssetsIntoProject({
			requiredAssetIds: preparation.requiredAssetIds,
			historicalAssetIds: preparation.historicalAssetIds,
			fromProjectId: args.fromProjectId,
			toProjectId: args.toProjectId,
			actorUserId: args.actorUserId,
		});
		const committed = await commitAppProjectMove(args.appId, {
			expectedFromProjectId: args.fromProjectId,
			toProjectId: args.toProjectId,
			actorUserId: args.actorUserId,
			assetIdMap,
			attemptedRealIds,
		});
		if (committed.kind === "moved") return;
		if (committed.kind === "already_moved") {
			await repairAppCaseTenancy(args.appId, args.actorUserId);
			return;
		}
		if (committed.kind === "busy") throw new AppBusyError();
		if (committed.kind === "corrupt_holder") {
			throw new AppRunStateCorruptError();
		}
		if (committed.kind === "reapable") {
			await normalizeReapableRunForProjectMove(args.appId, committed.identity);
			continue;
		}
		log.warn("[moveAppToProject] media closure changed; retrying", {
			appId: args.appId,
			missing: committed.missing,
			attempt,
		});
	}
	throw new Error(
		`[moveAppToProject] app state kept changing during the move of ${args.appId}; nothing moved`,
	);
}
