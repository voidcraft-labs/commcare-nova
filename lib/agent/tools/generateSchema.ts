/**
 * SA tool: `generateSchema` — seed the app name + case-type catalog.
 *
 * First step of a new build. The SA calls this before `generateScaffold`
 * so downstream helpers can resolve case-property references. Shared
 * between the chat factory and future MCP adapters; both surfaces hand
 * in the current `BlueprintDoc` (empty on a fresh build) and receive the
 * computed mutations + post-mutation doc + a structured summary for the
 * LLM.
 */

import { z } from "zod";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { setCaseTypesMutations } from "../blueprintHelpers";
import { caseTypesOutputSchema } from "../scaffoldSchemas";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "./common";

export const generateSchemaInputSchema = z.object({
	appName: z.string().describe("Short app name (2-5 words)"),
	caseTypes: caseTypesOutputSchema.shape.case_types,
});

export type GenerateSchemaInput = z.infer<typeof generateSchemaInputSchema>;

/**
 * Structured summary the LLM sees as the tool output. One entry per
 * case type, carrying a count + the property names so the SA can
 * reference them in the follow-up `generateScaffold` call without
 * re-reading the doc.
 */
export interface GenerateSchemaResult {
	appName: string;
	caseTypes: Array<{
		name: string;
		propertyCount: number;
		properties: string[];
	}>;
}

export const generateSchemaTool = {
	name: "generateSchema",
	description:
		"Set the data model (case types and properties) for the app. Call this first before generateScaffold. Provide the structured case types directly.",
	inputSchema: generateSchemaInputSchema,
	strict: true as const,
	async execute(
		input: GenerateSchemaInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<GenerateSchemaResult>> {
		const mutations: Mutation[] = [
			{ kind: "setAppName", name: input.appName },
			...setCaseTypesMutations(doc, input.caseTypes),
		];
		const newDoc = applyToDoc(doc, mutations);
		await ctx.recordMutations(mutations, newDoc, "schema");
		return {
			mutations,
			newDoc,
			result: {
				appName: input.appName,
				caseTypes: input.caseTypes.map((ct) => ({
					name: ct.name,
					propertyCount: ct.properties.length,
					properties: ct.properties.map((p) => p.name),
				})),
			},
		};
	},
};
