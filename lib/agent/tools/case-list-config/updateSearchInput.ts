/**
 * SA tool: `updateSearchInput` — replace one search input on a module's
 * case list, keyed by `searchInputUuid`.
 *
 * Atomic op — replaces ONE entry in `caseListConfig.searchInputs` and
 * preserves every other slot. The replacement carries the same uuid
 * (the tool stamps the existing uuid back onto the supplied shape) so
 * the input's identity survives the edit.
 *
 * The replacement is a full search-input body. Partial-patch shapes
 * don't fit the discriminated-union shape cleanly — switching between
 * `simple` and `advanced` requires a different field set, so a whole-
 * body replacement is the right shape regardless.
 *
 * Three exit branches:
 *
 *   1. Module UUID address does not resolve → `{ error }`, no mutations.
 *   2. Search-input uuid not present → `{ error }`, no mutations.
 *   3. Success → `{ message, uuid }` plus the persisted mutation,
 *      tagged `module:M:caseList:searchInput:update`.
 */

import type { z } from "zod";
import { asUuid, type Uuid } from "@/lib/domain";
import { updateSearchInputMutation } from "../../blueprintHelpers";
import type { ToolInvocationContext } from "../../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import {
	moduleAddressSchema,
	resolveModuleAddress,
} from "../shared/entityAddresses";
import type { ToolCallSummary } from "../shared/toolCallSummary";
import {
	searchInputUpdateInputSchema,
	stampSearchInputUuid,
	uuidInputSchema,
} from "./shared";

export const updateSearchInputInputSchema = moduleAddressSchema
	.extend({
		searchInputUuid: uuidInputSchema.describe(
			"Uuid of the existing search input to replace. Look at getModule's projection or run searchBlueprint to surface the current uuids.",
		),
		searchInput: searchInputUpdateInputSchema.describe(
			"Replacement search-input body (full shape, `simple` or `advanced`). The uuid carries over — never supply one.",
		),
	})
	.strict();

export type UpdateSearchInputInput = z.infer<
	typeof updateSearchInputInputSchema
>;

export interface UpdateSearchInputSuccess {
	message: string;
	uuid: Uuid;
	summary: ToolCallSummary;
}

export type UpdateSearchInputResult =
	| UpdateSearchInputSuccess
	| { error: string };

export const updateSearchInputTool = {
	description:
		"Replace one search input on a module's case list, keyed by searchInputUuid. The replacement is a full search-input body; switching among kind:simple, kind:advanced, and kind:hidden is permitted. The existing uuid is preserved. The body takes the same hint / required / validation / options / hidden value slots as addSearchInputs.",
	inputSchema: updateSearchInputInputSchema,
	async execute(
		input: UpdateSearchInputInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<UpdateSearchInputResult>> {
		const doc = ctx.snapshot.doc;
		const { searchInputUuid: rawSearchInputUuid, searchInput } = input;
		const searchInputUuid = asUuid(rawSearchInputUuid);
		try {
			const address = resolveModuleAddress(doc, input);
			if (!address.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: address.error },
				};
			}
			const { moduleUuid, module: mod } = address;

			const replacement = stampSearchInputUuid(searchInput, searchInputUuid);
			const result = updateSearchInputMutation(
				mod,
				searchInputUuid,
				replacement,
			);
			if ("error" in result) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: result.error },
				};
			}

			const commit = await guardedMutate(
				ctx,
				result.mutations,
				`module:${moduleUuid}:caseList:searchInput:update`,
			);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: commit.error },
				};
			}

			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					message: `Updated search input ${searchInputUuid} on module "${mod.name}". New kind: ${searchInput.kind}, label "${searchInput.label}".`,
					uuid: searchInputUuid,
					summary: { location: mod.name, subject: searchInput.label },
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
