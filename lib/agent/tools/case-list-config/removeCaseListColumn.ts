/**
 * SA tool: `removeCaseListColumn` — drop one column from a module's
 * case list, keyed by `columnUuid`.
 *
 * Atomic op — removes ONE column from `caseListConfig.columns` and
 * preserves every other slot. Returns the removed uuid + the remaining
 * column count so the SA confirms the edit landed on the right entry.
 *
 * Three exit branches:
 *
 *   1. Module UUID address does not resolve → `{ error }`, no mutations.
 *   2. Column uuid not present in the module's case-list config →
 *      `{ error }`, no mutations.
 *   3. Success → `{ message, uuid, remaining }` plus the persisted
 *      mutation, tagged `module:M:caseList:column:remove`.
 */

import type { z } from "zod";
import { asUuid, type BlueprintDoc, type Uuid } from "@/lib/domain";
import { removeColumnMutation } from "../../blueprintHelpers";
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
import type { ToolCallSummary } from "../shared/toolCallSummary";
import { uuidInputSchema } from "./shared";

export const removeCaseListColumnInputSchema = moduleAddressSchema
	.extend({
		columnUuid: uuidInputSchema.describe(
			"Uuid of the column to remove. Look at getModule's projection or run searchBlueprint to surface the current uuids.",
		),
	})
	.strict();

export type RemoveCaseListColumnInput = z.infer<
	typeof removeCaseListColumnInputSchema
>;

export interface RemoveCaseListColumnSuccess {
	message: string;
	uuid: Uuid;
	remaining: number;
	summary: ToolCallSummary;
}

export type RemoveCaseListColumnResult =
	| RemoveCaseListColumnSuccess
	| { error: string };

export const removeCaseListColumnTool = {
	description:
		"Remove one column from a module's case list, keyed by columnUuid. Returns the remaining column count so the SA confirms the edit landed on the right entry.",
	inputSchema: removeCaseListColumnInputSchema,
	async execute(
		input: RemoveCaseListColumnInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<RemoveCaseListColumnResult>> {
		const { columnUuid: rawColumnUuid } = input;
		const columnUuid = asUuid(rawColumnUuid);
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

			const result = removeColumnMutation(mod, columnUuid);
			if ("error" in result) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: result.error },
				};
			}

			const commit = await guardedMutate(
				ctx,
				doc,
				result.mutations,
				`module:${moduleUuid}:caseList:column:remove`,
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

			const remaining =
				newDoc.modules[moduleUuid]?.caseListConfig?.columns.length ?? 0;
			return {
				kind: "mutate" as const,
				mutations: result.mutations,
				newDoc,
				result: {
					message: `Removed case list column ${columnUuid} on module "${mod.name}". ${remaining} column${remaining === 1 ? "" : "s"} remain.`,
					uuid: columnUuid,
					remaining,
					summary: { location: mod.name },
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
