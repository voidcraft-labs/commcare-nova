/**
 * SA tool: `addModule` — set case list + detail columns for a module.
 *
 * Third step of the initial build, after `generateSchema` and
 * `generateScaffold`. The SA targets a module by positional index (the
 * indices the scaffold result returned). Survey-only modules carry no
 * case type and therefore no column mutations — the tool returns a
 * silent success for those.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Three exit branches all land
 * on the `MutatingToolResult` shape:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Survey-only module or null columns → `{ columns: null }`, no
 *      mutations.
 *   3. Normal path → computed mutations applied, typed result payload.
 */

import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { updateModuleMutations } from "../blueprintHelpers";
import { moduleContentSchema } from "../scaffoldSchemas";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "./common";

export const addModuleInputSchema = z.object({
	moduleIndex: z.number().describe("0-based module index"),
	case_list_columns: moduleContentSchema.shape.case_list_columns,
	case_detail_columns: moduleContentSchema.shape.case_detail_columns,
});

export type AddModuleInput = z.infer<typeof addModuleInputSchema>;

/**
 * The LLM-facing result shape. Three legal variants:
 *
 *   - `{ error }` when the moduleIndex is out of range.
 *   - `{ moduleIndex, name, columns: null }` when the target module is
 *     survey-only (no `caseType`) or the SA explicitly passed null for
 *     `case_list_columns`.
 *   - `{ moduleIndex, name, case_list_columns, case_detail_columns }`
 *     on the normal path; `case_detail_columns` is null when the SA
 *     didn't set it (auto-mirroring the list columns at compile time).
 */
export type AddModuleResult =
	| { error: string }
	| { moduleIndex: number; name: string; columns: null }
	| {
			moduleIndex: number;
			name: string;
			/* Non-null on this branch — the null / undefined-caseType path
			 * short-circuits to the `{ columns: null }` shape above, so by
			 * the time the tool assembles this payload we know both the
			 * module has a caseType and the SA passed real columns. */
			case_list_columns: NonNullable<AddModuleInput["case_list_columns"]>;
			case_detail_columns: AddModuleInput["case_detail_columns"];
	  };

export const addModuleTool = {
	description:
		"Set case list columns for a module. Call after generateScaffold. Provide the columns directly. Survey-only modules (no case_type) should pass null for both.",
	inputSchema: addModuleInputSchema,
	async execute(
		input: AddModuleInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddModuleResult>> {
		const { moduleIndex, case_list_columns, case_detail_columns } = input;
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid) {
				return {
					mutations: [],
					newDoc: doc,
					result: { error: `Module ${moduleIndex} not found` },
				};
			}
			const mod = doc.modules[moduleUuid];
			if (!mod) {
				return {
					mutations: [],
					newDoc: doc,
					result: { error: `Module ${moduleIndex} not found` },
				};
			}

			// Survey-only branch: the module already exists from scaffold and
			// has no case type, so there are no column mutations to apply.
			// Return a silent success — the client reads the module entity
			// directly, so no stream event is needed here.
			if (!mod.caseType || !case_list_columns) {
				return {
					mutations: [],
					newDoc: doc,
					result: { moduleIndex, name: mod.name, columns: null },
				};
			}

			const mutations = updateModuleMutations(doc, moduleUuid, {
				caseListColumns: case_list_columns,
				...(case_detail_columns && {
					caseDetailColumns: case_detail_columns,
				}),
			});
			const newDoc = applyToDoc(doc, mutations);
			// Stage tag encodes which module these mutations belong to —
			// useful for replay attribution and server-side telemetry.
			await ctx.recordMutations(mutations, newDoc, `module:${moduleIndex}`);
			return {
				mutations,
				newDoc,
				result: {
					moduleIndex,
					name: mod.name,
					case_list_columns,
					case_detail_columns: case_detail_columns ?? null,
				},
			};
		} catch (err) {
			// Match the error-envelope shape every other mutating tool
			// returns so the SA's error handling stays uniform. An
			// unexpected throw (Firestore down mid-recordMutations, etc.)
			// would otherwise abort the entire tool loop.
			return {
				mutations: [],
				newDoc: doc,
				result: { error: err instanceof Error ? err.message : String(err) },
			};
		}
	},
};
