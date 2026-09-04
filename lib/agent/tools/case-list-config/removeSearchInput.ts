/**
 * SA tool: `removeSearchInput` — drop one search input from a module's
 * case list, keyed by `searchInputUuid`.
 *
 * Atomic op — removes ONE entry from `caseListConfig.searchInputs` and
 * preserves every other slot. Returns the removed uuid + the remaining
 * count so the SA confirms the edit landed on the right entry.
 *
 * Three exit branches:
 *
 *   1. Module UUID address does not resolve → `{ error }`, no mutations.
 *   2. Search-input uuid not present → `{ error }`, no mutations.
 *   3. Success → `{ message, uuid, remaining }` plus the persisted
 *      mutation, tagged `module:M:caseList:searchInput:remove`.
 */

import type { z } from "zod";
import { planSearchInputRemovalFieldDependents } from "@/lib/doc/searchNoMatchesDependents";
import { asUuid, type Uuid } from "@/lib/domain";
import { removeSearchInputMutation } from "../../blueprintHelpers";
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
import { uuidInputSchema } from "./shared";

export const removeSearchInputInputSchema = moduleAddressSchema
	.extend({
		searchInputUuid: uuidInputSchema.describe(
			"Uuid of the search input to remove. Look at getModule's projection or run searchBlueprint to surface the current uuids.",
		),
	})
	.strict();

export type RemoveSearchInputInput = z.infer<
	typeof removeSearchInputInputSchema
>;

export interface RemoveSearchInputSuccess {
	message: string;
	uuid: Uuid;
	remaining: number;
	summary: ToolCallSummary;
}

export type RemoveSearchInputResult =
	| RemoveSearchInputSuccess
	| { error: string };

export const removeSearchInputTool = {
	description:
		"Remove one search input from a module's case list, keyed by searchInputUuid. Returns the remaining search-input count so the SA confirms the edit landed on the right entry.",
	inputSchema: removeSearchInputInputSchema,
	async execute(
		input: RemoveSearchInputInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<RemoveSearchInputResult>> {
		const doc = ctx.snapshot.doc;
		const { searchInputUuid: rawSearchInputUuid } = input;
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

			/* A no-matches registration form may read this prompt's answer
			 * (`#search/<name>`); the shared planner refuses and names every
			 * field so the repair is addressable (`searchNoMatchesDependents.ts`). */
			const dependents = planSearchInputRemovalFieldDependents(
				doc,
				moduleUuid,
				searchInputUuid,
			);
			if (dependents.kind === "blocked") {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: dependents.message },
				};
			}

			const result = removeSearchInputMutation(mod, searchInputUuid);
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
				`module:${moduleUuid}:caseList:searchInput:remove`,
			);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: commit.error },
				};
			}
			const newDoc = commit.newDoc;

			const remaining =
				newDoc.modules[moduleUuid]?.caseListConfig?.searchInputs.length ?? 0;
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					message: `Removed search input ${searchInputUuid} on module "${mod.name}". ${remaining} search input${remaining === 1 ? "" : "s"} remain.`,
					uuid: searchInputUuid,
					remaining,
					summary: { location: mod.name },
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
