/**
 * `nova.invite_member` — invite an email address to a shared Nova Project.
 *
 * Scope: `nova.projects.write` (per-tool, in addition to the route-layer
 * floor). Inviting is the canonical outward-facing grant: it gives another
 * person access to every app, case row, and media asset in the Project.
 *
 * The write is `lib/projects/manage.ts::createProjectInvitation` — a direct
 * authDb transaction under the exclusive membership gate, re-stating the
 * same policy the session path's `organizationHooks` enforce (dimagi-domain
 * gate, personal-Project privacy, the pending cap) because Better Auth's
 * `inviteMember` endpoint is session-bound and unusable headless.
 *
 * Error mapping: a nonexistent Project and a Project the caller isn't a
 * member of both collapse to the not-found envelope (a probing key can't
 * distinguish existence); a member whose role can't invite gets an explicit
 * `permission_denied` message; policy rejections (personal Project, already
 * a member, duplicate invite, the cap) pass through as `invalid_input`.
 *
 * No invitation email exists by design — the invitee discovers the invite
 * in-app on their next sign-in, so the success payload says so rather than
 * letting the caller assume a notification went out.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	ASSIGNABLE_PROJECT_ROLES,
	type CreatedInvitation,
	createProjectInvitation,
} from "@/lib/projects/manage";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { rethrowAsMcpProjectAccess } from "../ownership";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

/**
 * The role enum reuses the manage layer's assignable set, so the schema
 * can't drift from the authority that enforces it.
 */
const inviteMemberInputSchema = z
	.object({
		project_id: z
			.string()
			.min(1)
			.describe("The Project to invite into, from list_projects."),
		email: z
			.string()
			.min(1)
			.describe(
				"The invitee's email address. Invitations are limited to Dimagi addresses.",
			),
		role: z
			.enum(ASSIGNABLE_PROJECT_ROLES)
			.describe(
				"The role the invitee holds on accepting: viewer (read only), editor (edit apps and data), or admin (also manage members). Owner isn't assignable; the creator stays the one owner.",
			),
	})
	.strict();

/**
 * Register the `invite_member` tool on an `McpServer`.
 */
export function registerInviteMember(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"invite_member",
		{
			description:
				"Invite an email address to a shared Nova Project at a chosen role (viewer, editor, or admin). Requires an admin or owner role in the Project. Personal Projects can't be shared. No email is sent: the invitee sees the invitation in commcare nova the next time they sign in and accepts it there, so tell the human to expect it. Invitations expire after 48 hours; a still-pending duplicate is rejected rather than re-issued.",
			inputSchema: inviteMemberInputSchema,
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				/* Per-tool scope gate — before any data read, so a
				 * missing-scope credential can't probe whether the Project
				 * exists. */
				assertScope(ctx, SCOPES.projectsWrite, "invite_member");

				let created: CreatedInvitation;
				try {
					created = await createProjectInvitation({
						projectId: args.project_id,
						actorUserId: ctx.userId,
						email: args.email,
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
								invitation_id: created.invitationId,
								project_id: created.projectId,
								project_name: created.projectName,
								email: created.email,
								role: created.role,
								expires_at: created.expiresAt.toISOString(),
								note: `No email is sent. ${created.email} will see this invitation in commcare nova the next time they sign in, and can accept it there.`,
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
