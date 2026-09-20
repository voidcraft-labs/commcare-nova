import { runSharedToolCall } from "@/lib/agent/authoring/sharedToolCall";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import type { BlueprintDoc } from "@/lib/domain";
import {
	type MakeToolWorkspaceHarnessOptions,
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
} from "./fixtures";

/**
 * A registered shared tool called the way a client calls it: authored input
 * admitted by the published grammar, then production's one call body
 * (`runSharedToolCall`: bind, execute, print a read as authored content) inside
 * a workspace invocation. `runTool` on the workspace harness reaches a tool
 * body directly and sees canonical values; anything asserting what a client
 * reads or may write belongs here.
 */
export function makeAuthoringHarness(
	options: MakeToolWorkspaceHarnessOptions = {},
	initialDoc: BlueprintDoc = makeCanonicalGenesisDoc(),
) {
	const harness = makeToolWorkspaceHarness(initialDoc, options);
	/** A read's authored data, or a write's result (including a refusal the
	 * tool reports in that result). */
	async function call(name: string, input: unknown): Promise<unknown> {
		const entry = SHARED_TOOL_REGISTRY.find((entry) => entry.saName === name);
		if (!entry) throw new Error(`Unknown tool ${name}.`);
		const authored = authoringToolSchema(
			name,
			entry.tool.inputSchema,
		).authored.parse(input);
		return harness.workspace.invoke({
			toolName: name,
			async execute(ctx) {
				const outcome = await runSharedToolCall(entry, authored, ctx);
				return outcome.kind === "read" ? outcome.data : outcome.result;
			},
		});
	}
	return { ...harness, call };
}
