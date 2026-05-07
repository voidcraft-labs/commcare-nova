/**
 * SA tool: `setCaseListFilter` — set or clear the always-on
 * predicate filter on a module's case list.
 *
 * Accepts the typed `Predicate` shape directly. The case list
 * filter narrows the cases that show up on the module's list at
 * load time — applied unconditionally before any search-input-
 * driven refinement runs. The wire emitter stamps it as a nodeset
 * filter on the module's `<entry>` session datum; the Postgres
 * runtime applies it as a SQL `WHERE` clause.
 *
 * The `predicate` slot is `nullable()` — `null` clears the filter
 * (case list shows every case of the module's case type), a
 * supplied predicate replaces whatever was there. Matches the
 * "clear via null" convention `updateModule.case_detail_columns`
 * uses for its analogous nullable slot.
 *
 * Both the SA chat factory and the MCP adapter call this through
 * the shared `ToolExecutionContext` interface. Two exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Success → human-readable summary, tagged
 *      `module:M:filter`.
 */

import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { predicateSchema } from "@/lib/domain/predicate";
import { updateModuleMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { baseCaseListConfig } from "./shared";

export const setCaseListFilterInputSchema = z.object({
	moduleIndex: z
		.number()
		.describe("0-based module index whose case list filter to set"),
	filter: predicateSchema
		.nullable()
		.describe(
			"Replacement Predicate AST, or `null` to clear the filter. The filter narrows which cases appear on the case list at load time — applied unconditionally before any search-input refinement. Pass `null` to remove an existing filter and show every case of the module's case type.",
		),
});

export type SetCaseListFilterInput = z.infer<
	typeof setCaseListFilterInputSchema
>;

/** Human-readable success string or an error record. */
export type SetCaseListFilterResult = string | { error: string };

export const setCaseListFilterTool = {
	description:
		"Set or clear the always-on case list filter on a module. Pass a typed Predicate AST to filter the case list; pass null to remove an existing filter. Filter applies before any search-input refinement. To clear, always pass null — `match-all` is a non-empty filter expressing 'match every case' as a value, not a clear signal.",
	inputSchema: setCaseListFilterInputSchema,
	async execute(
		input: SetCaseListFilterInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetCaseListFilterResult>> {
		const { moduleIndex, filter } = input;
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

			// `filter === null` clears the slot. The schema treats absent
			// as "no filter," so we OMIT the key on the persisted config
			// rather than write `filter: undefined` (which would round-
			// trip as a present-with-undefined key under Zod's strip
			// mode and break round-trip equality). Matches the
			// optional-slot omission idiom `searchInputDef` uses for its
			// `via` slot.
			const base = baseCaseListConfig(mod);
			const { filter: _existingFilter, ...baseWithoutFilter } = base;
			const nextConfig =
				filter === null ? baseWithoutFilter : { ...baseWithoutFilter, filter };
			const mutations = updateModuleMutations(doc, moduleUuid, {
				caseListConfig: nextConfig,
			});
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`module:${moduleIndex}:filter`,
			);

			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result:
					filter === null
						? `Successfully cleared case list filter on module "${mod.name}" (index ${moduleIndex}).`
						: `Successfully set case list filter (kind: ${filter.kind}) on module "${mod.name}" (index ${moduleIndex}).`,
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
