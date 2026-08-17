/**
 * `nova.list_members` — the members of a Nova Project plus its pending
 * invitations.
 *
 * Scope: `nova.projects.read` (per-tool, in addition to the route-layer
 * floor). Member rows carry other people's names and email addresses —
 * PII beyond the caller's own data — so this read sits behind the Projects
 * scope while `list_projects` (the caller's own memberships only) stays on
 * the floor.
 *
 * Access: any member can view (`view` capability via
 * `requireProjectAccess`); a nonexistent Project and a Project the caller
 * isn't a member of both collapse to the not-found envelope.
 *
 * The returned `member_id` is the handle `update_member_role` takes — it
 * names the membership row, not the user.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	listPendingInvitations,
	listProjectMembers,
} from "@/lib/projects/membership";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { requireProjectAccess } from "../ownership";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

const listMembersInputSchema = z
	.object({
		project_id: z
			.string()
			.min(1)
			.describe("The Project whose members to list, from list_projects."),
	})
	.strict();

/** One member row on the wire. */
interface MemberBody {
	/** The membership-row id `update_member_role` takes (not the user id). */
	member_id: string;
	user_id: string;
	name: string;
	email: string;
	role: string;
	joined_at: string;
}

/** One pending invitation on the wire. */
interface PendingInvitationBody {
	invitation_id: string;
	email: string;
	role: string;
	expires_at: string;
}

/**
 * Register the `list_members` tool on an `McpServer`.
 */
export function registerListMembers(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"list_members",
		{
			description:
				"List a Nova Project's members (member_id, name, email, role, join date) and its pending invitations (email, role, expiry). Any member of the Project can call this. member_id is the handle update_member_role takes. An invitation past its expires_at can no longer be accepted; re-invite with invite_member if it lapsed.",
			inputSchema: listMembersInputSchema,
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				/* Per-tool scope gate — before any data read, so a
				 * missing-scope credential can't probe whether the Project
				 * exists. */
				assertScope(ctx, SCOPES.projectsRead, "list_members");

				/* Any member can view — every role holds `view`, so the only
				 * reachable denials are the not-found collapse. */
				await requireProjectAccess(ctx.userId, args.project_id, "view");

				const [members, pending] = await Promise.all([
					listProjectMembers(args.project_id),
					listPendingInvitations(args.project_id, new Date()),
				]);
				const body: {
					project_id: string;
					members: MemberBody[];
					pending_invitations: PendingInvitationBody[];
				} = {
					project_id: args.project_id,
					members: members.map((m) => ({
						member_id: m.memberId,
						user_id: m.userId,
						name: m.name,
						email: m.email,
						role: m.role,
						joined_at: m.createdAt.toISOString(),
					})),
					pending_invitations: pending.map((p) => ({
						invitation_id: p.id,
						email: p.email,
						role: p.role ?? "viewer",
						expires_at: p.expiresAt.toISOString(),
					})),
				};
				return {
					content: [{ type: "text", text: JSON.stringify(body) }],
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
