import { expect } from "vitest";
import {
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import { prepareAuthoringInput } from "@/lib/agent/authoring/input";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import { createModuleTool } from "@/lib/agent/tools/createModule";
export async function createEvaluationApp(input: unknown) {
	const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
	await harness.workspace.invoke({
		toolName: "createModule",
		async execute(ctx) {
			const canonical = await prepareAuthoringInput({
				toolName: "createModule",
				schema: createModuleTool.inputSchema,
				input: authoringToolSchema(
					"createModule",
					createModuleTool.inputSchema,
				).authored.parse(input),
				ctx,
			});
			const result = await createModuleTool.execute(
				createModuleTool.inputSchema.parse(canonical),
				ctx,
			);
			expect(result.result).not.toHaveProperty("error");
			return result;
		},
	});
	return harness.workspace.currentSnapshot().doc;
}
