import {
	type ReadSourceInput,
	readSourceDocument,
	readSourceInputSchema,
} from "../../sourceDocuments";
import type { ToolInvocationContext } from "../../workspace/types";

export const readSourceTool = {
	description:
		"Read a Project library document's prepared requirements extract, including documents not attached to this conversation. Find ids with listMediaAssets. This is the working extract, not a lossless copy of the original file. Follow nextOffset with the returned revision to read further pages. Embedded authoring prepares unread documents automatically; external clients receive preparation status without starting a model call.",
	inputSchema: readSourceInputSchema,
	async execute(input: ReadSourceInput, ctx: ToolInvocationContext) {
		return {
			kind: "read" as const,
			data: await readSourceDocument({
				projectId: ctx.projectId,
				input,
				requestId: ctx.invocation.requestId,
				runtime: ctx.sourceDocuments,
			}),
		};
	},
};
