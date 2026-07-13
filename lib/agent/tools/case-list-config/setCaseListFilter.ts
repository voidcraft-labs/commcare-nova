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
 * provider schema wouldn't honor consistently across edits.
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
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { type Predicate, predicateSchema } from "@/lib/domain/predicate";
import { resolveModuleUuid } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import type { ToolCallSummary } from "../shared/toolCallSummary";
import { moduleNotFoundResult } from "./shared";

export const setCaseListFilterInputSchema = z
	.object({
		moduleIndex: z
			.number()
			.describe("0-based module index whose case list filter to set"),
		filter: predicateSchema
			.nullable()
			.describe(
				"Replacement Predicate, or null to clear the filter and show every case of the module's type.",
			),
	})
	.strict();

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
	summary: ToolCallSummary;
}

export type SetCaseListFilterResult =
	| SetCaseListFilterSuccess
	| { error: string };

export const setCaseListFilterTool = {
	description:
		"Set or clear a module's always-on case-list filter (applied before any search). A Predicate sets it; null clears it — never use match-all as a clear.",
	inputSchema: setCaseListFilterInputSchema,
	async execute(
		input: SetCaseListFilterInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetCaseListFilterResult>> {
		const { moduleIndex, filter } = input;
		try {
			const moduleUuid = resolveModuleUuid(doc, moduleIndex);
			if (!moduleUuid)
				return moduleNotFoundResult<SetCaseListFilterSuccess>(
					doc,
					moduleIndex,
					"set the case list filter",
				);
			const mod = doc.modules[moduleUuid];
			if (!mod)
				return moduleNotFoundResult<SetCaseListFilterSuccess>(
					doc,
					moduleIndex,
					"set the case list filter",
				);

			// The filter rides the GRANULAR `setCaseListMeta` kind (not a
			// wholesale `updateModule{caseListConfig}` that would clobber a
			// concurrent column edit on the guarded re-apply): `null` clears the
			// slot, a Predicate sets it. The reducer maps `null → delete`, so a
			// clear crosses the JSON wire intact.
			const mutations: Mutation[] = [
				{ kind: "setCaseListMeta", uuid: mod.uuid, patch: { filter } },
			];
			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`module:${moduleIndex}:filter`,
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

			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result:
					filter === null
						? {
								message: `Cleared case list filter on module "${mod.name}" (index ${moduleIndex}).`,
								kind: "cleared",
								summary: { location: mod.name },
							}
						: {
								message: `Set case list filter (kind: ${filter.kind}) on module "${mod.name}" (index ${moduleIndex}).`,
								kind: filter.kind,
								summary: { location: mod.name },
							},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
