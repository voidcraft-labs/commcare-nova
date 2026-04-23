/**
 * SA tool: `generateScaffold` — set the app's module + form structure.
 *
 * Runs immediately after `generateSchema` during a new build. The SA
 * hands in a full scaffold (app name, every module and its forms) and
 * the tool computes the module + form creation mutations and persists
 * them. Both the SA chat factory and the MCP adapter call this through
 * the shared `ToolExecutionContext` interface.
 *
 * The LLM-facing return condenses the scaffold input into a structured
 * index-plus-name summary so the SA can call `addModule` immediately
 * afterward with positional indices, without re-reading the doc.
 */

import type { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { setScaffoldMutations } from "../blueprintHelpers";
import { scaffoldModulesSchema } from "../scaffoldSchemas";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "./common";

export const generateScaffoldInputSchema = scaffoldModulesSchema;

export type GenerateScaffoldInput = z.infer<typeof generateScaffoldInputSchema>;

/**
 * Summary the LLM receives as tool output. Reflects the positional
 * ordering the scaffold mutations produce so the SA can target modules
 * and forms by index in the follow-up `addModule` calls.
 */
export interface GenerateScaffoldResult {
	appName: string;
	modules: Array<{
		index: number;
		name: string;
		case_type: string | null;
		formCount: number;
		forms: Array<{
			index: number;
			name: string;
			type: string;
		}>;
	}>;
}

/**
 * LLM-facing tool output. Adds an `{ error }` branch so the error
 * envelope the SA handles is identical across every mutating tool.
 */
export type GenerateScaffoldOutput = GenerateScaffoldResult | { error: string };

export const generateScaffoldTool = {
	name: "generateScaffold" as const,
	description:
		"Set the module and form structure for the app. Call after generateSchema. Provide the complete scaffold directly.",
	inputSchema: generateScaffoldInputSchema,
	strict: true as const,
	async execute(
		input: GenerateScaffoldInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<GenerateScaffoldOutput>> {
		try {
			const mutations = setScaffoldMutations(input);
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(mutations, newDoc, "scaffold");
			return {
				mutations,
				newDoc,
				result: {
					appName: input.app_name,
					modules: input.modules.map((m, i) => ({
						index: i,
						name: m.name,
						case_type: m.case_type,
						formCount: m.forms.length,
						forms: m.forms.map((f, j) => ({
							index: j,
							name: f.name,
							type: f.type,
						})),
					})),
				},
			};
		} catch (err) {
			// Catch to match the error envelope every other mutating tool
			// surfaces so the SA's error handling stays uniform. A thrown
			// exception here (Firestore down mid-recordMutations, etc.)
			// would otherwise abort the entire tool loop.
			return {
				mutations: [],
				newDoc: doc,
				result: { error: err instanceof Error ? err.message : String(err) },
			};
		}
	},
};
