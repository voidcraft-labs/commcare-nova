/**
 * SA tool: `setCaseListColumns` — replace the case list's display
 * column array on a module.
 *
 * Accepts the typed `Column[]` shape directly (every kind in the
 * `columnSchema` discriminated union: `plain` / `date` / `phone` /
 * `id-mapping` / `late-flag` / `time-since-until` / `search-only`).
 * No string parsing, no flat-text shape — the SA emits the
 * structured AST and this tool plants it on the module's
 * `caseListConfig.columns` slot wholesale, preserving every other
 * slot of the config.
 *
 * Wholesale replacement matches the spec's "Case list columns are
 * fully LLM-controlled" contract (per root CLAUDE.md): no auto-
 * prepend, no expander filter, no merging. The SA owns the entire
 * column array on every call.
 *
 * Both the SA chat factory and the MCP adapter call this through
 * the shared `ToolExecutionContext` interface. Two exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Success → human-readable summary listing the column count,
 *      tagged `module:M:columns`.
 */

import { z } from "zod";
import { type BlueprintDoc, columnSchema } from "@/lib/domain";
import { updateModuleMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { baseCaseListConfig } from "./shared";

export const setCaseListColumnsInputSchema = z.object({
	moduleIndex: z
		.number()
		.describe("0-based module index whose case list columns to replace"),
	columns: z
		.array(columnSchema)
		.describe(
			"Replacement column array. Each entry is one Column AST node — `plain` (text property), `date` (date-formatted property with pattern), `phone` (tappable phone link), `id-mapping` (lookup table from value to label), `late-flag` (overdue flag past threshold), `time-since-until` (relative interval), or `search-only` (searchable but not displayed). The provided array replaces the module's case list columns wholesale; previously authored columns NOT in this array are removed.",
		),
});

export type SetCaseListColumnsInput = z.infer<
	typeof setCaseListColumnsInputSchema
>;

/** Human-readable success string or an error record. */
export type SetCaseListColumnsResult = string | { error: string };

export const setCaseListColumnsTool = {
	description:
		"Replace the case list display columns on a module with a typed Column AST array. Use this to author the case list's visible columns. Wholesale replace — the supplied array is the new column list in full.",
	inputSchema: setCaseListColumnsInputSchema,
	async execute(
		input: SetCaseListColumnsInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetCaseListColumnsResult>> {
		const { moduleIndex, columns } = input;
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

			// Preserve every other case-list-config slot — sort, filter,
			// calculatedColumns, searchInputs, detailColumns. Only
			// `columns` is being replaced. The base-config fallback
			// (`baseCaseListConfig`) handles the "first-time set"
			// case where the module has no config yet.
			const base = baseCaseListConfig(mod);
			const mutations = updateModuleMutations(doc, moduleUuid, {
				caseListConfig: { ...base, columns },
			});
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`module:${moduleIndex}:columns`,
			);

			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: `Successfully set ${columns.length} case list column${columns.length === 1 ? "" : "s"} on module "${mod.name}" (index ${moduleIndex}).`,
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
