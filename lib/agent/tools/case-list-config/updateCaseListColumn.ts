/**
 * SA tool: `updateCaseListColumn` — replace one column on a module's
 * case list, keyed by `columnUuid`.
 *
 * Atomic op — replaces ONE column in `caseListConfig.columns` and
 * preserves every other slot. The replacement column carries the same
 * uuid (the tool stamps the existing uuid back onto the supplied
 * shape), so the column's identity survives the edit.
 *
 * The replacement is a full column body (kind + per-kind required
 * fields + common optional slots). Partial-patch shapes don't fit the
 * 8-optional ceiling on the discriminated union — the interval arm
 * alone has six per-kind fields, which combined with `sort`,
 * `visibleInList`, `visibleInDetail` would push the per-arm optional
 * count over the limit. A whole-column replacement keeps every per-arm
 * optional count well under 8.
 *
 * Three exit branches:
 *
 *   1. Module UUID address does not resolve → `{ error }`, no mutations.
 *   2. Column uuid not present in the module's case-list config →
 *      `{ error }`, no mutations.
 *   3. Success → `{ message, uuid }` plus the persisted mutation,
 *      tagged `module:M:caseList:column:update`.
 */

import type { z } from "zod";
import { asUuid, type Uuid } from "@/lib/domain";
import { updateColumnMutation } from "../../blueprintHelpers";
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
	CALCULATED_SEARCH_EXPRESSION_GUIDANCE,
	columnUpdateInputSchema,
	stampColumnUuid,
	uuidInputSchema,
} from "./shared";

export const updateCaseListColumnInputSchema = moduleAddressSchema
	.extend({
		columnUuid: uuidInputSchema.describe(
			"Uuid of the existing column to replace. Look at getModule's projection or run searchBlueprint to surface the current uuids.",
		),
		column: columnUpdateInputSchema.describe(
			`Replacement column body (full shape, any kind). The uuid carries over from the existing entry — never supply one, and the column keeps its place on the case tile. Use setCaseListTile to move it. ${CALCULATED_SEARCH_EXPRESSION_GUIDANCE}`,
		),
	})
	.strict();

export type UpdateCaseListColumnInput = z.infer<
	typeof updateCaseListColumnInputSchema
>;

export interface UpdateCaseListColumnSuccess {
	message: string;
	uuid: Uuid;
	summary: ToolCallSummary;
}

export type UpdateCaseListColumnResult =
	| UpdateCaseListColumnSuccess
	| { error: string };

export const updateCaseListColumnTool = {
	description:
		"Replace one column on a module's case list, keyed by columnUuid. The replacement is a full column body (kind + per-kind fields + optional sort / visibility). The existing uuid is preserved so the column's identity survives.",
	inputSchema: updateCaseListColumnInputSchema,
	async execute(
		input: UpdateCaseListColumnInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<UpdateCaseListColumnResult>> {
		const doc = ctx.snapshot.doc;
		const { columnUuid: rawColumnUuid, column } = input;
		const columnUuid = asUuid(rawColumnUuid);
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

			const replacement = stampColumnUuid(column, columnUuid);
			const result = updateColumnMutation(mod, columnUuid, replacement);
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
				`module:${moduleUuid}:caseList:column:update`,
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
					message: `Updated case list column ${columnUuid} on module "${mod.name}". New kind: ${column.kind}, header "${column.header}".`,
					uuid: columnUuid,
					summary: { location: mod.name, subject: column.header },
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
