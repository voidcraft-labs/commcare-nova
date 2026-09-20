import type { SharedToolModule } from "@/lib/mcp/adapters/sharedToolAdapter";
import type { MutatingToolResult, ReadToolResult } from "../tools/common";
import type { ToolInvocationContext } from "../workspace/types";
import { prepareAuthoringInput } from "./input";
import { projectAuthoringReadInContext } from "./output";

/**
 * The body every client runs for one shared tool call, inside its authorized
 * workspace invocation: bind the authored input, run the tool, and print a
 * read's canonical result as authored content. The SA editor, the build
 * architect, and MCP all call this, so the path a test exercises is the path
 * production runs.
 *
 * The two halves fail differently on purpose. Preparation throws
 * `AuthoringInputError` for input the caller can correct; the read projection
 * throws `ReadProjectionError` for stored content Nova could not print.
 */
export async function runSharedToolCall(
	entry: { readonly saName: string; readonly tool: SharedToolModule },
	input: unknown,
	ctx: ToolInvocationContext,
): Promise<ReadToolResult<unknown> | MutatingToolResult<unknown>> {
	const prepared = await prepareAuthoringInput({
		toolName: entry.saName,
		schema: entry.tool.inputSchema,
		input,
		ctx,
	});
	const outcome = await entry.tool.execute(prepared, ctx);
	return outcome.kind === "read"
		? {
				...outcome,
				data: await projectAuthoringReadInContext(
					entry.saName,
					outcome.data,
					ctx,
				),
			}
		: outcome;
}
