/**
 * `nova.list_projects` — every Nova Project the authenticated user belongs
 * to, with their role in each and the personal-Project flag.
 *
 * Scope: floor only (`nova.read`, checked at the route layer). No per-tool
 * gate, deliberately: the list exposes nothing beyond the caller's own
 * memberships — roughly what floor-scoped `list_apps` already reveals by
 * enumerating across those same Projects — and default-scope OAuth clients
 * need it to resolve a `project_id` for `create_app`. The Project WRITE
 * tools (`create_project`, `invite_member`, `update_member_role`,
 * `move_app`) and the member-PII read (`list_members`) carry the orthogonal
 * `nova.projects.*` scopes instead.
 *
 * This is the id-resolution entry point for the whole Project surface:
 * every other Project tool takes a `project_id` from this list.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { listUserProjects } from "@/lib/projects/membership";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import type { ToolContext } from "../types";

/** One Project membership row on the wire. */
interface ProjectBody {
	project_id: string;
	name: string;
	slug: string;
	/** The caller's role in this Project (`viewer`/`editor`/`admin`/`owner`). */
	role: string;
	/** The auto-provisioned personal Project — private by construction. */
	personal: boolean;
}

/**
 * Register the zero-argument `list_projects` tool on an `McpServer`.
 *
 * Thin adapter over `listUserProjects` (the same read the header switcher
 * renders from), renamed to the wire's snake_case.
 */
export function registerListProjects(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"list_projects",
		{
			description:
				"List every Nova Project the user belongs to, with the user's role in each (viewer, editor, admin, or owner) and whether it's their personal Project. Projects are Nova's sharing unit: every app lives in exactly one Project, and every member of that Project can see the app plus its case data and media. Use the returned project_id values to target create_app, move_app, invite_member, list_members, and update_member_role. The personal Project can't be shared; when other people need access, create a shared Project with create_project and build there.",
		},
		async (): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				const projects = await listUserProjects(ctx.userId);
				const body: { projects: ProjectBody[] } = {
					projects: projects.map((p) => ({
						project_id: p.id,
						name: p.name,
						slug: p.slug,
						role: p.role,
						personal: p.personal,
					})),
				};
				return {
					content: [{ type: "text", text: JSON.stringify(body) }],
				};
			} catch (err) {
				return toMcpErrorResult(err, { userId: ctx.userId });
			}
		},
	);
}
