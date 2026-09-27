import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { WORK_TOOL_DEFINITIONS } from "@/lib/agent/authoring/lifecycleTools";
import {
	beginWork,
	discardWork,
	getWork,
	listWork,
	saveWork,
} from "@/lib/agent/authoring/session";
import { ensurePersonalProject } from "@/lib/auth/provisionProject";
import { toMcpErrorResult } from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { requireProjectAccess } from "../ownership";
import { LARGE_RESULT_META } from "../resultSize";
import type { ToolContext } from "../types";
import { projectWorkPayload } from "../workProjection";

const work_id = z
	.string()
	.min(1)
	.describe("Stable private work ID returned by begin_work.");
const request_id = z
	.string()
	.min(1)
	.describe(
		"Unique request ID. Reuse only for an exact retry, including after a lost response.",
	);
const host = { kind: "mcp" } as const;
const response = (value: unknown) => ({
	content: [
		{ type: "text" as const, text: JSON.stringify(projectWorkPayload(value)) },
	],
});

/** Transport identifiers extend the single shared lifecycle definitions. The
 * session service owns authorization, retries, validation and publication. */
export function registerWorkTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"begin_work",
		{
			description: WORK_TOOL_DEFINITIONS.beginWork.description,
			_meta: LARGE_RESULT_META,
			inputSchema: WORK_TOOL_DEFINITIONS.beginWork.inputSchema.safeExtend({
				request_id,
			}),
		},
		async (args) => {
			try {
				let projectId: string;
				let target: { appId: string } | { name: string };
				if (args.app_id !== undefined) {
					projectId = (await loadAppBlueprint(args.app_id, ctx.userId, "edit"))
						.access.projectId;
					target = { appId: args.app_id };
				} else {
					if (!args.new_app) throw new Error("Validated work target missing.");
					projectId = args.new_app.project_id
						? (
								await requireProjectAccess(
									ctx.userId,
									args.new_app.project_id,
									"edit",
									"Your role in this Project can't create apps. Ask a Project admin to make you an editor.",
								)
							).projectId
						: await ensurePersonalProject(ctx.userId);
					target = { name: args.new_app.name };
				}
				return response(
					await beginWork({
						actorUserId: ctx.userId,
						projectId,
						target,
						requestId: args.request_id,
						host,
					}),
				);
			} catch (error) {
				return toMcpErrorResult(error, {
					userId: ctx.userId,
					appId: args.app_id,
					projectId: args.new_app?.project_id,
				});
			}
		},
	);
	server.registerTool(
		"get_work",
		{
			description: WORK_TOOL_DEFINITIONS.getWork.description,
			_meta: LARGE_RESULT_META,
			inputSchema: WORK_TOOL_DEFINITIONS.getWork.inputSchema.extend({
				work_id,
			}),
		},
		async ({ work_id: workId }) => {
			try {
				return response(
					await getWork({ actorUserId: ctx.userId, workId, host }),
				);
			} catch (error) {
				return toMcpErrorResult(error, { userId: ctx.userId });
			}
		},
	);
	server.registerTool(
		"list_work",
		{
			description: WORK_TOOL_DEFINITIONS.listWork.description,
			_meta: LARGE_RESULT_META,
			inputSchema: WORK_TOOL_DEFINITIONS.listWork.inputSchema,
		},
		async (args) => {
			try {
				const result = await listWork({
					actorUserId: ctx.userId,
					host,
					appId: args.app_id,
					projectId: args.project_id,
					limit: args.limit,
					offset: args.offset,
				});
				return response({ work: result.work.map(projectWorkPayload) });
			} catch (error) {
				return toMcpErrorResult(error, { userId: ctx.userId });
			}
		},
	);
	for (const [name, definition, execute] of [
		["save_work", WORK_TOOL_DEFINITIONS.saveWork, saveWork],
		["discard_work", WORK_TOOL_DEFINITIONS.discardWork, discardWork],
	] as const) {
		server.registerTool(
			name,
			{
				description: definition.description,
				_meta: LARGE_RESULT_META,
				inputSchema: definition.inputSchema
					.omit({ expectedRevision: true })
					.extend({
						work_id,
						request_id,
						expected_revision: definition.inputSchema.shape.expectedRevision,
					}),
			},
			async (args) => {
				try {
					return response(
						await execute({
							actorUserId: ctx.userId,
							workId: args.work_id,
							requestId: args.request_id,
							expectedRevision: args.expected_revision,
							host,
						}),
					);
				} catch (error) {
					return toMcpErrorResult(error, { userId: ctx.userId });
				}
			},
		);
	}
}
