/**
 * SA tool: `addSearchInputs` — add one or more search inputs to a module's
 * case list in a single call.
 *
 * Atomic op — appends the entries to `caseListConfig.searchInputs` (in
 * order) and preserves every other slot. The tool mints a fresh `uuid` for
 * each new entry and surfaces them in both the success message and a
 * structured `result.uuids` field so the SA can target subsequent edits
 * without a separate read.
 *
 * There is no singular `addSearchInput` — one input is just a length-1
 * `searchInputs` array, so the plural tool covers both cases with one entry
 * on the SA's tool surface.
 *
 * Two exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Success → `{ message, uuids }` plus the persisted mutation,
 *      tagged `module:M:caseList:searchInput:add`.
 */

import { z } from "zod";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	addSearchInputsMutation,
	resolveModuleUuid,
} from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { guardedMutate, type MutatingToolResult } from "../common";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	moduleNotFoundResult,
	newUuid,
	searchInputDefInputSchema,
	stampSearchInputUuid,
} from "./shared";

export const addSearchInputsInputSchema = z
	.object({
		moduleIndex: z
			.number()
			.describe("0-based module index whose case list to add search inputs to"),
		searchInputs: z
			.array(searchInputDefInputSchema)
			.min(1)
			.describe(
				"The search inputs to append, in order. Each: pick a kind (`simple` for property/mode/via inputs or `advanced` for a free-form predicate) and supply the kind's required fields plus any optional `default` slot. The tool mints each input's uuid; do not supply one.",
			),
	})
	.strict();

export type AddSearchInputsInput = z.infer<typeof addSearchInputsInputSchema>;

/**
 * Success result — the new inputs' uuids surfaced both as a structured
 * field and in the human-readable message, positionally aligned with the
 * input `searchInputs`.
 */
export interface AddSearchInputsSuccess extends MutationSuccess {
	uuids: Uuid[];
}

export type AddSearchInputsResult = AddSearchInputsSuccess | { error: string };

export const addSearchInputsTool = {
	description:
		"Add one or more search inputs to a module's case list in a single call. The tool mints a fresh uuid for each and returns them (aligned with the input order); use those uuids on subsequent updateSearchInput / removeSearchInput / reorderSearchInputs calls. Simple inputs target a property + mode; advanced inputs carry a free-form predicate.",
	inputSchema: addSearchInputsInputSchema,
	async execute(
		input: AddSearchInputsInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddSearchInputsResult>> {
		const { moduleIndex, searchInputs } = input;
		try {
			const moduleUuid = resolveModuleUuid(doc, moduleIndex);
			if (!moduleUuid)
				return moduleNotFoundResult<AddSearchInputsSuccess>(
					doc,
					moduleIndex,
					"add search inputs",
				);
			const mod = doc.modules[moduleUuid];
			if (!mod)
				return moduleNotFoundResult<AddSearchInputsSuccess>(
					doc,
					moduleIndex,
					"add search inputs",
				);

			const uuids = searchInputs.map(() => newUuid());
			const stamped = searchInputs.map((s, i) =>
				stampSearchInputUuid(s, uuids[i]),
			);
			// `addSearchInputsMutation` can't fail on a resolved module — it
			// returns `CaseListMutationOk` (no error arm), so there's no error
			// branch here.
			const result = addSearchInputsMutation(mod, stamped);

			const commit = await guardedMutate(
				ctx,
				doc,
				result.mutations,
				`module:${moduleIndex}:caseList:searchInput:add`,
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

			const labels = searchInputs.map((s) => `"${s.label}"`).join(", ");
			return {
				kind: "mutate" as const,
				mutations: result.mutations,
				newDoc,
				result: {
					message: `Added ${searchInputs.length} search input${searchInputs.length === 1 ? "" : "s"} to module "${mod.name}": ${labels}.`,
					uuids,
					summary: { location: mod.name, count: searchInputs.length },
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
