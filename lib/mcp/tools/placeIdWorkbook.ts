import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { dataAccessLost } from "@/lib/auth/dataGrant";
import { deploymentTargetSchema } from "@/lib/deployment/types";
import { preparePlaceWorkbook } from "@/lib/deployment/placeWorkbook";
import { toMcpErrorResult } from "../errors";
import { registerScopedTool } from "../scopedTool";
import type { ToolContext } from "../types";

export function registerPlaceIdWorkbook(server: McpServer, ctx: ToolContext) {
	registerScopedTool(
		server,
		ctx,
		"prepare_place_id_workbook",
		{
			description:
				"Prepare the organization workbook for a destination whose publication stopped for place IDs. An authorized editor can download it through the returned private resource and apply it in that project space.",
			inputSchema: z.object({
				app_id: deploymentTargetSchema.shape.appId,
				server: deploymentTargetSchema.shape.server,
				domain: deploymentTargetSchema.shape.domain,
			}),
		},
		async (args) => {
			try {
				if (!ctx.grant) return dataAccessLost();
				const artifact = await preparePlaceWorkbook(
					{ userId: ctx.userId, grant: ctx.grant },
					args.app_id,
					{ server: args.server, domain: args.domain },
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								artifact,
								resource: "nova://exports/" + artifact.id + "/bytes/0",
							}),
						},
					],
				};
			} catch (error) {
				return toMcpErrorResult(error, {
					userId: ctx.userId,
					toolName: "prepare_place_id_workbook",
					appId: args.app_id,
				});
			}
		},
	);
}
