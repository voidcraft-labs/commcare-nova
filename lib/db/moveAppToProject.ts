// Cross-Project move orchestration.

import { log } from "@/lib/logger";
import { copyAssetsIntoProject } from "@/lib/media/moveMedia";
import { appProjectMovePolicy } from "@/lib/projects/moveTargets";
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

const MAX_MOVE_ATTEMPTS = 4;

export interface MoveAppToProjectArgs {
	readonly appId: string;
	readonly fromProjectId: string;
	readonly toProjectId: string;
	readonly actorUserId: string;
}

/** The result comes from the committed move or freshly locked repair, never
 * from a caller's preflight snapshot. */
export type AppProjectMoveResult =
	| {
			readonly kind: "moved";
			readonly fromProjectId: string;
			readonly projectId: string;
	  }
	| { readonly kind: "already_in_project"; readonly projectId: string };

/**
 * Production entry point. Exact same-Project calls are not moves: they take
 * the app-locked case-only repair and derive the destination from the fresh row.
 */
export async function moveAppToProject(
	args: MoveAppToProjectArgs,
): Promise<AppProjectMoveResult> {
	const policy = appProjectMovePolicy(args.fromProjectId, args.toProjectId);
	if (policy.kind === "cross_project_move") {
		return await runCrossProjectMove(args);
	}
	const repaired = await repairAppCaseTenancy(args.appId, args.actorUserId);
	return { kind: "already_in_project", projectId: repaired.projectId };
}

/**
 * The move itself: prepare under the app lock, copy media bytes outside the
 * transaction, then commit atomically — retrying when the app's run holder or
 * media closure changed underneath.
 */
export async function runCrossProjectMove(
	args: MoveAppToProjectArgs,
): Promise<AppProjectMoveResult> {
	for (let attempt = 1; attempt <= MAX_MOVE_ATTEMPTS; attempt++) {
		const preparation = await prepareAppProjectMove({
			appId: args.appId,
			expectedFromProjectId: args.fromProjectId,
			toProjectId: args.toProjectId,
			actorUserId: args.actorUserId,
		});
		if (preparation.kind === "already_moved") {
			const repaired = await repairAppCaseTenancy(args.appId, args.actorUserId);
			return { kind: "already_in_project", projectId: repaired.projectId };
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

		const assetIdMap = await copyAssetsIntoProject({
			assetIds: preparation.assetIds,
			fromProjectId: args.fromProjectId,
			toProjectId: args.toProjectId,
			actorUserId: args.actorUserId,
		});
		const committed = await commitAppProjectMove(args.appId, {
			expectedFromProjectId: args.fromProjectId,
			toProjectId: args.toProjectId,
			actorUserId: args.actorUserId,
			assetIdMap,
		});
		if (committed.kind === "moved")
			return {
				kind: "moved",
				fromProjectId: args.fromProjectId,
				projectId: args.toProjectId,
			};
		if (committed.kind === "already_moved") {
			const repaired = await repairAppCaseTenancy(args.appId, args.actorUserId);
			return { kind: "already_in_project", projectId: repaired.projectId };
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
