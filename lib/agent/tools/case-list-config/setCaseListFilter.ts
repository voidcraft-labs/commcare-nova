/**
 * SA tool: `setCaseListFilter` — set or clear the always-on
 * predicate filter on a module's case list.
 *
 * Accepts the typed `Predicate` shape directly. The case list filter
 * narrows the cases that show up on the module's list at load time —
 * applied unconditionally before any search-input-driven refinement
 * runs. The wire emitter stamps it as a nodeset filter on the
 * module's `<entry>` session datum; the Postgres runtime applies it
 * as a SQL `WHERE` clause.
 *
 * The `predicate` slot is `nullable()` — `null` clears the filter
 * (case list shows every case of the module's case type), a supplied
 * predicate replaces whatever was there. The clear-via-`null`
 * convention reads as "an absence value rather than absence-via-
 * omission" — it forces the SA to spell out "remove the filter" as a
 * payload rather than relying on a missing key, which the AI SDK /
 * Anthropic schema wouldn't honor consistently across edits.
 *
 * Filter is the one wholesale-shape slot on `caseListConfig` (one
 * Predicate, no array of entries to address by uuid) — column and
 * search-input authoring decompose into the atomic add / update /
 * remove / reorder tools instead. Result shape mirrors the atomic
 * family: a structured success carrying the `kind` of the predicate
 * (or `"cleared"` on the null path) so the SA can branch on the
 * outcome without re-parsing prose.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Two exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Success → `{ message, kind }` plus the persisted mutation,
 *      tagged `module:M:filter`.
 */

import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { type Predicate, predicateSchema } from "@/lib/domain/predicate";
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

/**
 * Discriminator returned in the structured success arm. On a set call
 * it's the supplied predicate's `kind` (`"eq"`, `"and"`, `"match-all"`,
 * etc., narrowed by `Predicate["kind"]`); on a null-clears call it's
 * the literal `"cleared"`. Surfaces the outcome to the SA + any TS
 * consumer without parsing prose, with full discriminated narrowing
 * preserved.
 */
export type SetCaseListFilterKind = Predicate["kind"] | "cleared";

/**
 * Success result. `kind` carries the predicate's discriminator on a
 * set call, or the literal `"cleared"` on the null-clears path — the
 * SA reads it without reparsing the message string, mirroring the
 * structured `result.uuid` shape on the atomic-op tools.
 */
export interface SetCaseListFilterSuccess {
	message: string;
	kind: SetCaseListFilterKind;
}

export type SetCaseListFilterResult =
	| SetCaseListFilterSuccess
	| { error: string };

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
			if (!moduleUuid) return moduleNotFoundResult(doc, moduleIndex);
			const mod = doc.modules[moduleUuid];
			if (!mod) return moduleNotFoundResult(doc, moduleIndex);

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
						? {
								message: `Cleared case list filter on module "${mod.name}" (index ${moduleIndex}).`,
								kind: "cleared",
							}
						: {
								message: `Set case list filter (kind: ${filter.kind}) on module "${mod.name}" (index ${moduleIndex}).`,
								kind: filter.kind,
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

function moduleNotFoundResult(
	doc: BlueprintDoc,
	moduleIndex: number,
): MutatingToolResult<SetCaseListFilterResult> {
	return {
		kind: "mutate" as const,
		mutations: [],
		newDoc: doc,
		result: {
			error: `Tried to set the case list filter on module ${moduleIndex}. Found no module at that index. Look at getModule's projection for the available module indices.`,
		},
	};
}
