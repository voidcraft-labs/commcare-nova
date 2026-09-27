import type { ToolSet } from "ai";
import { WORK_TOOL_DEFINITIONS } from "@/lib/agent/authoring/lifecycleTools";
import {
	discardWork,
	executeWorkTool,
	getWork,
	saveWork,
	type WorkArgs,
} from "@/lib/agent/authoring/session";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { solutionsArchitectToolDefinitions } from "@/lib/agent/solutionsArchitect";

/** Production grammar and durable private work, restricted to the disposable
 * app. Project resources remain outside this bounded comparison. */
export function authoringTrialTools(work: WorkArgs): ToolSet {
	return Object.fromEntries(
		Object.entries(solutionsArchitectToolDefinitions()).map(
			([name, definition]) =>
				definition.type === "provider"
					? [name, definition]
					: [
							name,
							{
								...definition,
								execute: async (
									input: unknown,
									options: { toolCallId: string },
								) => {
									if (name === "getWork") {
										WORK_TOOL_DEFINITIONS.getWork.inputSchema.parse(input);
										return getWork(work);
									}
									if (name === "saveWork")
										return saveWork({
											...work,
											requestId: options.toolCallId,
											...WORK_TOOL_DEFINITIONS.saveWork.inputSchema.parse(
												input,
											),
										});
									if (name === "discardWork")
										return discardWork({
											...work,
											requestId: options.toolCallId,
											...WORK_TOOL_DEFINITIONS.discardWork.inputSchema.parse(
												input,
											),
										});
									const entry = SHARED_TOOL_REGISTRY.find(
										(entry) => entry.saName === name,
									);
									if (
										!entry ||
										entry.policy.capabilities.some(
											(capability) =>
												![
													"canonical-blueprint-write",
													"case-store-migration",
												].includes(capability),
										)
									)
										return {
											error:
												"This local comparison can only read or edit its disposable app.",
										};
									const outcome = await executeWorkTool({
										...work,
										requestId: options.toolCallId,
										toolName: name,
										input,
									});
									return outcome.kind === "read"
										? outcome.data
										: outcome.result;
								},
							},
						],
		),
	);
}
