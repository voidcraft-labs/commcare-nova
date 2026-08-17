/**
 * `nova.update_member_role` — change a member's role in a shared Nova
 * Project.
 *
 * Scope: `nova.projects.write` (per-tool, in addition to the route-layer
 * floor). A role change re-shapes what another person can reach — the same
 * outward-facing power as inviting.
 *
 * The write is `lib/projects/manage.ts::updateProjectMemberRole` — a direct
 * authDb transaction under the exclusive membership gate (Better Auth's
 * `updateMemberRole` endpoint is session-bound and unusable headless).
 * Only `viewer`/`editor`/`admin` are assignable; the owner's role is never
 * changeable here, mirroring the settings UI, which also moots last-owner
 * hazards. Setting the role a member already holds succeeds as a no-op.
 *
 * Error mapping matches `invite_member`: nonexistent Project / non-member
 * caller collapse to not-found; a member whose role can't manage gets an
 * explicit `permission_denied`; policy rejections (personal Project,
 * unknown member id, the owner row) pass through as `invalid_input`.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	ASSIGNABLE_PROJECT_ROLES,
	type UpdatedMemberRole,
	updateProjectMemberRole,
} from "@/lib/projects/manage";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { rethrowAsMcpProjectAccess } from "../ownership";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

const updateMemberRoleInputSchema = z
	.object({
		project_id: z
			.string()
			.min(1)
			.describe("The Project the member belongs to, from list_projects."),
		member_id: z
			.string()
			.min(1)
			.describe(
				"The member to change, from list_members' member_id (the membership-row id, not the user id).",
			),
		role: z
			.enum(ASSIGNABLE_PROJECT_ROLES)
			.describe(
				"The member's new role: viewer (read only), editor (edit apps and data), or admin (also manage members). Owner isn't assignable, and the owner's own role can't be changed.",
			),
	})
	.strict();

/**
 * Register the `update_member_role` tool on an `McpServer`.
 */
export function registerUpdateMemberRole(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"update_member_role",
		{
			description:
				"Change a member's role in a shared Nova Project (viewer, editor, or admin). Requires an admin or owner role in the Project. Takes the member_id from list_members. The Project owner's role can't be changed, and setting the role a member already holds succeeds without a write.",
			inputSchema: updateMemberRoleInputSchema,
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				/* Per-tool scope gate — before any data read, so a
				 * missing-scope credential can't probe whether the Project
				 * exists. */
				assertScope(ctx, SCOPES.projectsWrite, "update_member_role");

				let updated: UpdatedMemberRole;
				try {
					updated = await updateProjectMemberRole({
						projectId: args.project_id,
						actorUserId: ctx.userId,
						memberId: args.member_id,
						role: args.role,
					});
				} catch (err) {
					/* `not_found` / `not_member` collapse to the Project-flavored
					 * not-found envelope. Role enforcement lives in the manage
					 * layer, which throws its own `ProjectPermissionError` naming
					 * the actor's actual role — the mapper's generic
					 * insufficient-role copy is only a safety net. */
					rethrowAsMcpProjectAccess(err);
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								project_id: args.project_id,
								member_id: updated.memberId,
								user_id: updated.userId,
								name: updated.name,
								email: updated.email,
								previous_role: updated.previousRole,
								role: updated.role,
							}),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err, {
					userId: ctx.userId,
					projectId: args.project_id,
				});
			}
		},
	);
}
