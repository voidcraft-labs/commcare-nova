import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { configureProjectSearchDestination } from "@/lib/deployment/projectSearchDestination";
import {
	projectSearchDestinationEdit,
	projectSearchDestinationInput,
} from "@/lib/deployment/projectSearchDestinationInput";
import { inspectProjectSearchDestination } from "@/lib/deployment/store";
import { toMcpErrorResult } from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { LARGE_RESULT_META } from "../resultSize";
import { registerScopedTool } from "../scopedTool";
import type { ToolContext } from "../types";
import { projectSearchReview } from "./projectSearchReview";

export function registerProjectSearchDestinations(
	server: McpServer,
	ctx: ToolContext,
) {
	const address = projectSearchDestinationInput
		.omit({ appId: true })
		.extend({ app_id: projectSearchDestinationInput.shape.appId });
	registerScopedTool(
		server,
		ctx,
		"get_project_search_destination",
		{
			description:
				"Read the named searches this app uses in one project space, their service IDs there, and the version to confirm when connecting them. Follow next_page until the final version is available. Large reviews list each search, menu, parameter and result. Join numbered text parts in order. If restarted, review the new pages from the beginning.",
			_meta: LARGE_RESULT_META,
			inputSchema: address.extend({
				page: z
					.strictObject({
						from: z.number().int().positive(),
						token: z.string().regex(/^[a-f0-9]{64}$/),
					})
					.optional(),
			}),
		},
		async (args) => {
			try {
				const { access } = await loadAppBlueprint(
					args.app_id,
					ctx.userId,
					"view",
				);
				const { review } = await inspectProjectSearchDestination(
					{ ...access, appId: args.app_id, actorUserId: ctx.userId },
					args,
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(projectSearchReview(review, args.page)),
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
	registerScopedTool(
		server,
		ctx,
		"connect_project_searches",
		{
			description:
				"Connect an app’s named searches to the service IDs a contributor chose in this project space. Read get_project_search_destination first. Supply every search, with a null ID to disconnect one. Services and their data stay in CommCare HQ.",
			_meta: LARGE_RESULT_META,
			inputSchema: address.extend(projectSearchDestinationEdit.shape),
		},
		async (args) => {
			try {
				const { access } = await loadAppBlueprint(
					args.app_id,
					ctx.userId,
					"edit",
				);
				const review = await configureProjectSearchDestination(
					{ ...access, appId: args.app_id, actorUserId: ctx.userId },
					args,
					args,
				);
				return {
					content: [
						{ type: "text", text: JSON.stringify(projectSearchReview(review)) },
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
