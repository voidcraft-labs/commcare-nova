/**
 * SA tool: `generateSchema` — seed the app name + case-type catalog.
 *
 * First step of a new build. The SA calls this before `generateScaffold`
 * so downstream helpers can resolve case-property references. Both the
 * SA chat factory and the MCP adapter call this through the shared
 * `ToolExecutionContext` interface; both surfaces hand in the current
 * `BlueprintDoc` (empty on a fresh build) and receive the computed
 * mutations + post-mutation doc + a structured summary for the LLM.
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

/**
 * Structured summary the LLM sees as the tool output on the error branch —
 * matches the same `{ error }` shape every mutating tool surfaces so the
 * SA sees a uniform error envelope regardless of which tool failed.
 */
export type GenerateSchemaOutput = GenerateSchemaResult | { error: string };

export const generateSchemaTool = {
	description:
		"Set the data model (case types and properties) for the app. Call this first before generateScaffold. Provide the structured case types directly.",
	inputSchema: generateSchemaInputSchema,
	strict: true as const,
	async execute(
		input: GenerateSchemaInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<GenerateSchemaOutput>> {
		try {
			const mutations: Mutation[] = [
				{ kind: "setAppName", name: input.appName },
				...setCaseTypesMutations(input.caseTypes),
			];
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(mutations, newDoc, "schema");
			return {
				kind: "mutate" as const,
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
		} catch (err) {
			// Match the error-envelope shape every other mutating tool
			// returns so the SA handles a generation-phase failure the same
			// way as an edit-phase failure. Without this, an unexpected
			// throw (Firestore down mid-recordMutations, malformed input
			// that escaped Zod, etc.) would propagate out of the tool loop
			// as an unhandled exception and abort the entire run.
			return {
				kind: "mutate" as const,
				mutations: [],
				newDoc: doc,
				result: { error: err instanceof Error ? err.message : String(err) },
			};
		}
	},
};
