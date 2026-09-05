import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getEntryPointLink } from "@/lib/deployment/entryPointLinks";
import { getEntryPointLinkSchema } from "@/lib/deployment/entryPointTypes";
import { toMcpErrorResult } from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

const shapes = getEntryPointLinkSchema.shape;
const selection = shapes.selections.element.shape;

export function registerGetEntryPointLink(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"get_entry_point_link",
		{
			description:
				"Create a deep link after freshly checking the published entry point against the exact released build on CommCare HQ. Supply case IDs from that HQ project space, never Nova Preview case IDs. The public URL follows HQ's build selection when opened; it is not pinned to the checked release and a recipient's latest-build policy can select another build. This operation reads HQ and records its observation in Nova, so it requires HQ write scope and edit access. It never opens the link or executes case claims.",
			inputSchema: z
				.object({
					app_id: shapes.appId,
					server: shapes.server,
					domain: shapes.domain,
					entry_point_uuid: shapes.entryPointUuid,
					selections: z.array(
						z
							.object({
								module_uuid: selection.moduleUuid,
								case_ids: selection.caseIds,
							})
							.strict(),
					),
				})
				.strict(),
		},
		async (args) => {
			try {
				assertScope(ctx, SCOPES.hqWrite, "get_entry_point_link");
				const { doc, app, access } = await loadAppBlueprint(
					args.app_id,
					ctx.userId,
					"edit",
				);
				const link = await getEntryPointLink({
					scope: {
						appId: args.app_id,
						projectId: access.projectId,
						role: access.role,
						actorUserId: ctx.userId,
					},
					target: { server: args.server, domain: args.domain },
					doc,
					sourceSequence: app.mutation_seq,
					entryPointUuid: args.entry_point_uuid,
					selections: args.selections.map((item) => ({
						moduleUuid: item.module_uuid,
						caseIds: item.case_ids,
					})),
				});
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								app_id: args.app_id,
								url: link.url,
								checked_at: link.checkedAt,
								released_build_id: link.releasedBuildId,
								released_version: link.releasedVersion,
							}),
						},
					],
				};
			} catch (error) {
				return toMcpErrorResult(error, {
					appId: args.app_id,
					userId: ctx.userId,
				});
			}
		},
	);
}
