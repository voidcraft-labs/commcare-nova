/**
 * `nova.create_project` — mint a shared Nova Project owned by the
 * authenticated user, for giving other people access to apps and their data.
 *
 * Scope: `nova.projects.write` (per-tool, in addition to the route-layer
 * floor). Creating a tenancy container is the first step of an
 * outward-facing grant chain (create → invite → share), so it sits behind
 * the Projects scope even though the create itself touches nobody else.
 *
 * The write is `lib/projects/manage.ts::createProject` — a direct authDb
 * transaction (organization row + owner membership, atomic), because Better
 * Auth's `createOrganization` endpoint writes those two rows non-atomically
 * and the MCP surface has no session for the plugin's session-bound paths.
 *
 * No ownership check: there's nothing to own yet. Name-policy rejections
 * (empty, too long) throw `ProjectManagementError`, which the error
 * serializer passes through as `invalid_input` with the message intact.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createProject } from "@/lib/projects/manage";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

/**
 * Input schema, exported so the provider-acceptance smoke test
 * (`scripts/test-schema.ts`) can exercise it the same way it does the
 * shared tools.
 */
export const createProjectInputSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.describe(
				"Display name for the new Project (up to 64 characters after trimming). Name it for the program or team, not the run.",
			),
	})
	.strict();

/**
 * Register the `create_project` tool on an `McpServer`.
 *
 * The caller becomes the Project's owner; the URL slug is derived from the
 * name with a random suffix, so names don't need to be unique.
 */
export function registerCreateProject(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"create_project",
		{
			description:
				"Create a shared Nova Project owned by the user and return its project_id. A shared Project is how other people get access to apps: every member sees the Project's apps plus their case data and media. Create one Project per program or team and reuse it across builds, never one per run or per app, because Project deletion is disabled and every Project created is permanent. Give apps to the Project at birth via create_app's project_id (move_app is the recovery path for apps born elsewhere), and bring people in with invite_member.",
			inputSchema: createProjectInputSchema,
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				/* Per-tool scope gate — before any data touch, so a
				 * missing-scope credential learns nothing and creates
				 * nothing. */
				assertScope(ctx, SCOPES.projectsWrite, "create_project");

				const created = await createProject(ctx.userId, args.name);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								project_id: created.id,
								name: created.name,
								slug: created.slug,
								role: "owner",
							}),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err, { userId: ctx.userId });
			}
		},
	);
}
