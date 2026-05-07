/**
 * SA tool: `setCaseListSearchInputs` — replace the search input
 * declarations on a module's case list.
 *
 * Accepts the typed `SearchInputDef[]` shape directly. Each search
 * input declares an authoring-surface widget (`type`), an optional
 * targeted case property (`property`), an optional relation walk
 * (`via`), an explicit search mode (`mode`), an optional default
 * value (`default`), and an optional advanced predicate (`xpath`)
 * that replaces the `(property, mode)`-derived predicate when
 * present.
 *
 * Wholesale replacement: the supplied array fully replaces the
 * module's `caseListConfig.searchInputs` slot. An empty array
 * removes every search input.
 *
 * Schema-compiler ceiling note: `searchInputDefSchema` carries 5
 * optional fields per item (`property`, `via`, `mode`, `default`,
 * `xpath`) plus 3 required (`name`, `label`, `type`) — well below
 * the 8-optional ceiling Anthropic's structured-output compiler
 * imposes per array item (per root CLAUDE.md). The recursive AST
 * shapes (`relationPathSchema`, `searchInputModeSchema`,
 * `valueExpressionSchema`, `predicateSchema`) live nested under
 * single optional slots, so each consumes one slot regardless of
 * its inner field count — the same nested-object-optionals pattern
 * the field-mutation tool schemas use for `validate` and `repeat`.
 *
 * Both the SA chat factory and the MCP adapter call this through
 * the shared `ToolExecutionContext` interface. Two exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Success → human-readable summary, tagged
 *      `module:M:searchInputs`.
 */

import { z } from "zod";
import { type BlueprintDoc, searchInputDefSchema } from "@/lib/domain";
import { updateModuleMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { baseCaseListConfig } from "./shared";

export const setCaseListSearchInputsInputSchema = z.object({
	moduleIndex: z
		.number()
		.describe("0-based module index whose case list search inputs to replace"),
	searchInputs: z
		.array(searchInputDefSchema)
		.describe(
			"Replacement search input array. Each `SearchInputDef` declares a `name` (stable id the runtime binds the user input to), a `label` (widget label), a `type` (widget kind: text / select / date / date-range / barcode), an optional targeted `property`, an optional relation walk `via`, an optional search `mode`, an optional `default` ValueExpression, and an optional advanced `xpath` Predicate that overrides the (property, mode)-derived predicate. Wholesale replace.",
		),
});

export type SetCaseListSearchInputsInput = z.infer<
	typeof setCaseListSearchInputsInputSchema
>;

/** Human-readable success string or an error record. */
export type SetCaseListSearchInputsResult = string | { error: string };

export const setCaseListSearchInputsTool = {
	description:
		"Replace the search input declarations on a module's case list with a typed SearchInputDef AST array. Each entry declares a search widget (name, label, type) plus optional property targeting, relation walk, mode, default value, and advanced xpath override. Wholesale replace.",
	inputSchema: setCaseListSearchInputsInputSchema,
	async execute(
		input: SetCaseListSearchInputsInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetCaseListSearchInputsResult>> {
		const { moduleIndex, searchInputs } = input;
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
			const mod = doc.modules[moduleUuid];
			if (!mod) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: `Module ${moduleIndex} not found` },
				};
			}

			// Preserve every other slot of the case-list config; only
			// `searchInputs` is being replaced.
			const base = baseCaseListConfig(mod);
			const mutations = updateModuleMutations(doc, moduleUuid, {
				caseListConfig: { ...base, searchInputs },
			});
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`module:${moduleIndex}:searchInputs`,
			);

			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: `Successfully set ${searchInputs.length} search input${searchInputs.length === 1 ? "" : "s"} on module "${mod.name}" (index ${moduleIndex}).`,
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
