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
 *   1. Module UUID address does not resolve → `{ error }`, no mutations.
 *   2. Success → `{ message, uuids }` plus the persisted mutation,
 *      tagged `module:M:caseList:searchInput:add`.
 */

import { z } from "zod";
import {
	asUuid,
	type BlueprintDoc,
	findAuthoredBlueprintIdentity,
	type Uuid,
} from "@/lib/domain";
import { addSearchInputsMutation } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import {
	moduleAddressSchema,
	resolveModuleAddress,
} from "../shared/entityAddresses";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	newUuid,
	searchInputDefInputSchema,
	stampSearchInputUuid,
} from "./shared";

export const addSearchInputsInputSchema = moduleAddressSchema
	.extend({
		searchInputs: z
			.array(searchInputDefInputSchema)
			.min(1)
			.describe(
				"The Search inputs to append, in order. Supply searchInputUuid when another item in this call references the input; otherwise Nova mints it.",
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
		"Add search inputs to a module's case list. Returns the minted uuids (input order) for later update/remove/reorder calls.",
	inputSchema: addSearchInputsInputSchema,
	async execute(
		input: AddSearchInputsInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddSearchInputsResult>> {
		const { searchInputs } = input;
		try {
			const address = resolveModuleAddress(doc, input);
			if (!address.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: address.error },
				};
			}
			const { moduleUuid, module: mod } = address;

			const uuids = searchInputs.map((input) =>
				input.searchInputUuid === undefined
					? newUuid()
					: asUuid(input.searchInputUuid),
			);
			const collision = uuids.find(
				(uuid, index) =>
					uuids.indexOf(uuid) !== index ||
					findAuthoredBlueprintIdentity(doc, uuid) !== undefined,
			);
			if (collision !== undefined) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `Search-input UUID "${collision}" is duplicated in this call or already belongs to an authored object.`,
					},
				};
			}
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
				`module:${moduleUuid}:caseList:searchInput:add`,
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
				mutations: commit.mutations,
				newDoc,
				result: {
					message: `Added ${searchInputs.length} search input${searchInputs.length === 1 ? "" : "s"} to module "${mod.name}": ${labels}.`,
					uuids,
					summary: { location: mod.name, count: searchInputs.length },
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
