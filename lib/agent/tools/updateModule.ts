/**
 * SA tool: `updateModule` — patch module-level metadata.
 *
 * Module-scoped name patches only. Case list authoring lives on the
 * typed case-list-config tools (`addCaseListColumn` /
 * `updateCaseListColumn` / `removeCaseListColumn` /
 * `reorderCaseListColumns`, the matching search-input quartet, and the
 * wholesale `setCaseListFilter`) — those preserve the typed `Column`
 * and `SearchInputDef` discriminated unions end-to-end.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface.
 *
 * Three exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Module disappeared between resolution and patch (shouldn't
 *      happen under normal flow) → `{ error }`.
 *   3. Success → human-readable summary listing the changed keys,
 *      tagged `module:M`.
 */

import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { updateModuleMutations } from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "./common";

export const updateModuleInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		name: z.string().describe("New module name"),
	})
	.strict();

export type UpdateModuleInput = z.infer<typeof updateModuleInputSchema>;

/** Human-readable success string or an error record. */
export type UpdateModuleResult = string | { error: string };

export const updateModuleTool = {
	description: "Update a module's display name.",
	inputSchema: updateModuleInputSchema,
	async execute(
		input: UpdateModuleInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<UpdateModuleResult>> {
		const { moduleIndex, name } = input;
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: `Module ${moduleIndex} not found` },
				};
			}
			// Structural defense: `moduleOrder` and `modules` could in
			// principle disagree under a partial Immer update, so the
			// helper trusts a resolved `Module` value and the call site
			// owns the lookup-and-check.
			const mod = doc.modules[moduleUuid];
			if (!mod) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: `Module ${moduleIndex} not found` },
				};
			}

			const mutations = updateModuleMutations(mod, { name });
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(mutations, newDoc, `module:${moduleIndex}`);

			// Read back from the post-mutation doc so the summary reflects
			// the values the SA can expect on a follow-up read — the patch
			// has already landed so `name` carries the new value.
			const newMod = newDoc.modules[moduleUuid];
			if (!newMod) {
				return {
					kind: "mutate" as const,
					mutations,
					newDoc,
					result: { error: `Module ${moduleIndex} not found after update` },
				};
			}
			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: `Successfully renamed module to "${newMod.name}" (index ${moduleIndex}).`,
			};
		} catch (err) {
			return {
				kind: "mutate" as const,
				mutations: [],
				newDoc: doc,
				result: { error: err instanceof Error ? err.message : String(err) },
			};
		}
	},
};
