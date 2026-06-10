/**
 * SA tool: `updateModule` — patch module-level metadata.
 *
 * Module-scoped patches: display name and `case_type`. The case-type
 * slot is the SA's repair path when the commit gate rejects adding a
 * case form to a module that never declared one (`NO_CASE_TYPE` names
 * exactly this fix) — without it the only correction would be
 * remove-and-recreate. A case-type change re-scopes what every form's
 * references resolve to, so the gate validates the batch under a full
 * run (`scopeOfMutations` maps the patch to `"full"`). Case list
 * authoring lives on the typed case-list-config tools (`addCaseListColumns` /
 * `updateCaseListColumn` / `removeCaseListColumn` /
 * `reorderCaseListColumns`, the matching search-input family, and the
 * wholesale `setCaseListFilter`) — those preserve the typed `Column`
 * and `SearchInputDef` discriminated unions end-to-end. Case-search
 * authoring lives on the parallel case-search-config family
 * (`setCaseSearchDisplay` for the display cluster + `setCaseSearchAdvanced`
 * for the advanced cluster) — wholesale-replace tools rather than
 * atomic ops, since `caseSearchConfig` is a settings bag, not an
 * addressable list.
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
import { guardedMutate, type MutatingToolResult } from "./common";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const updateModuleInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		name: z
			.string()
			.optional()
			.describe("New module display name. Omit to leave unchanged."),
		case_type: z
			.string()
			.optional()
			.describe(
				'The case type this module manages (e.g. "patient"). A module needs one before it can hold registration/followup/close forms. Omit to leave unchanged.',
			),
	})
	.strict();

export type UpdateModuleInput = z.infer<typeof updateModuleInputSchema>;

/** Human-readable success string or an error record. */
export type UpdateModuleResult = MutationSuccess | { error: string };

export const updateModuleTool = {
	description:
		"Update a module's display name and/or its case type. Set case_type before adding registration/followup/close forms to a module created without one.",
	inputSchema: updateModuleInputSchema,
	async execute(
		input: UpdateModuleInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<UpdateModuleResult>> {
		const { moduleIndex, name, case_type } = input;
		try {
			if (name === undefined && case_type === undefined) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: "Nothing to update — pass `name`, `case_type`, or both.",
					},
				};
			}
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

			const mutations = updateModuleMutations(mod, {
				...(name !== undefined && { name }),
				...(case_type !== undefined && { caseType: case_type }),
			});
			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`module:${moduleIndex}`,
			);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: commit.error },
				};
			}
			const newDoc = commit.newDoc;

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
				result: {
					message: `Successfully updated module "${newMod.name}" (index ${moduleIndex})${
						case_type !== undefined ? ` — case type: ${newMod.caseType}` : ""
					}.`,
					summary: { subject: newMod.name } satisfies ToolCallSummary,
				},
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
