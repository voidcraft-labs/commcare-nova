/**
 * `nova.move_app` — move an app into another Nova Project, bringing its
 * case data, media, and chat history along as one transaction.
 *
 * Scope: `nova.projects.write` (per-tool, in addition to the route-layer
 * floor). Re-tenanting an app changes who can reach it — the same
 * outward-facing power the other Project writes carry.
 *
 * Access, in two phases:
 * 1. The caller needs the `delete` capability on the app's CURRENT
 *    Project (resolved here, with denials collapsed to the standard app
 *    not-found envelope). Failures in this phase are about the caller or
 *    the app, so their error context carries no destination Project id.
 * 2. The caller needs the `delete` capability on the DESTINATION Project
 *    (preflighted here: a non-member gets the Project not-found collapse,
 *    a member short of admin/owner gets an explicit permission message).
 *    The move transaction then re-checks both memberships plus owner
 *    retention under the app lock, so no preflight can go stale.
 *
 * In-tool error mapping, because the generic classifier would mislead:
 *   - `AppBusyError` — a run owns the app; retriable, so the copy says so.
 *   - `AppRunStateCorruptError` — needs operator repair; contact support.
 *   - `ProjectMoveDeniedError` — the transaction's governance re-check
 *     refused (source role, destination role, or owner retention); each
 *     arm's own message surfaces as a permission denial.
 *   - Plain `CommitReauthError` (the app row vanished mid-move) flows to
 *     the classifier's not-found collapse, which is what it means.
 * `BlueprintCommitRejectedError` (lookup-table closure, capture rows, a
 * deleted app) already carries person-readable copy and flows to the
 * classifier's `invalid_input` passthrough untouched.
 *
 * Targeting the Project the app is already in is not a move: the app-state
 * layer verifies and repairs the app's case-data tenancy (the same-Project
 * recovery that is always available), and the response says so explicitly
 * via `result: "already_in_project"` instead of pretending a move happened.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type ProjectAccess, resolveAppScope } from "@/lib/db/appAccess";
import { ProjectMoveDeniedError } from "@/lib/db/commitGuard";
import {
	AppBusyError,
	AppRunStateCorruptError,
	moveAppToProject,
} from "@/lib/db/moveAppToProject";
import { ProjectPermissionError } from "@/lib/projects/manage";
import {
	McpInvalidInputError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { requireProjectAccess, rethrowAsMcpAccess } from "../ownership";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

/**
 * Input schema, exported so the provider-acceptance smoke test
 * (`scripts/test-schema.ts`) can exercise it the same way it does the
 * shared tools.
 */
export const moveAppInputSchema = z
	.object({
		app_id: z.string().min(1).describe("The app to move."),
		to_project_id: z
			.string()
			.min(1)
			.describe("The destination Project, from list_projects."),
	})
	.strict();

/**
 * Register the `move_app` tool on an `McpServer`.
 */
export function registerMoveApp(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"move_app",
		{
			description:
				"Move an app into another Nova Project, re-tenanting its case data, media, and chat history with it in one transaction. Requires an admin or owner role in both the source and destination Projects, and unless a source owner performs the move themselves, every owner of the source Project must already be a member of the destination. An app that references lookup tables or has captured form submissions can't move, so the primary flow is birth in the right Project via create_app's project_id; moving is the recovery path for apps born elsewhere (for example in the personal Project). Targeting the Project the app is already in moves nothing — it verifies and repairs the app's case-data tenancy and reports `already_in_project`.",
			inputSchema: moveAppInputSchema,
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			/* Phase 1 — scope gate + source resolution. The error context here
			 * deliberately omits `to_project_id`: a denial in this phase is
			 * about the caller's credential or the app, and stamping the
			 * destination id would mislabel the audit log's probe target. */
			let scope: ProjectAccess;
			try {
				/* Per-tool scope gate — before any data read, so a
				 * missing-scope credential can't probe whether the app
				 * exists. */
				assertScope(ctx, SCOPES.projectsWrite, "move_app");

				/* Resolve the app's current Project at the `delete`
				 * capability (moving OUT is destructive for the source
				 * tenant). Denials collapse to the app-flavored not-found
				 * envelope like every other app tool. */
				try {
					scope = await resolveAppScope(args.app_id, ctx.userId, "delete");
				} catch (err) {
					rethrowAsMcpAccess(err);
				}
			} catch (err) {
				return toMcpErrorResult(err, {
					userId: ctx.userId,
					appId: args.app_id,
				});
			}

			/* Phase 2 — destination preflight + the move. Errors from here on
			 * are about the destination (or the move itself), so the context
			 * carries `to_project_id`. */
			try {
				/* Destination preflight: a non-member (or a nonexistent id)
				 * collapses to "Project not found."; a member short of
				 * admin/owner gets the explicit permission message. The move
				 * transaction re-checks this under the app lock — the
				 * preflight exists so the common denials answer with the
				 * right shape instead of a mid-transaction refusal. */
				await requireProjectAccess(
					ctx.userId,
					args.to_project_id,
					"delete",
					"Moving an app into a Project requires an admin or owner role there. Ask an admin or owner of the destination Project to grant you that role, or have them move the app.",
				);

				try {
					await moveAppToProject({
						appId: args.app_id,
						fromProjectId: scope.projectId,
						toProjectId: args.to_project_id,
						actorUserId: ctx.userId,
					});
				} catch (err) {
					if (err instanceof AppBusyError) {
						throw new McpInvalidInputError(
							"This app is being generated right now. Try the move again once the run finishes.",
						);
					}
					if (err instanceof AppRunStateCorruptError) {
						throw new McpInvalidInputError(
							"This app's run state is inconsistent, so it can't move until it's repaired. Contact support.",
						);
					}
					if (err instanceof ProjectMoveDeniedError) {
						throw new ProjectPermissionError(err.message);
					}
					throw err;
				}

				if (scope.projectId === args.to_project_id) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									app_id: args.app_id,
									project_id: args.to_project_id,
									result: "already_in_project",
									note: "The app is already in this Project, so nothing moved. Its case-data tenancy was verified and repaired where needed.",
								}),
							},
						],
					};
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								app_id: args.app_id,
								from_project_id: scope.projectId,
								to_project_id: args.to_project_id,
								result: "moved",
							}),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err, {
					userId: ctx.userId,
					appId: args.app_id,
					projectId: args.to_project_id,
				});
			}
		},
	);
}
