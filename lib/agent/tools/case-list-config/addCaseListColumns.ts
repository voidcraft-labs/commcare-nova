/**
 * SA tool: `addCaseListColumns` — add one or more columns to a module's
 * case list in a single call.
 *
 * Atomic op — appends the columns to `caseListConfig.columns` (in order)
 * and preserves every other slot of the config. The tool mints a fresh
 * `uuid` for each new column and surfaces them in both the success message
 * and a structured `result.uuids` field so the SA can target subsequent
 * edits (sort, visibility toggles, removal) without a separate read.
 *
 * There is no singular `addCaseListColumn` — one column is just a length-1
 * `columns` array, so the plural tool covers both cases with one entry on
 * the SA's tool surface (a case list is almost always configured with
 * several columns at once; the singular forced a call per column).
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Two exit branches:
 *
 *   1. Module UUID address does not resolve → `{ error }`, no mutations.
 *   2. Success → `{ message, uuids }` plus the persisted mutation,
 *      tagged `module:M:caseList:column:add`.
 */

import { z } from "zod";
import {
	asUuid,
	type BlueprintDoc,
	findAuthoredBlueprintIdentity,
	type Uuid,
} from "@/lib/domain";
import { addColumnsMutation } from "../../blueprintHelpers";
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
import { columnInputSchema, newUuid, stampColumnUuid } from "./shared";

export const addCaseListColumnsInputSchema = moduleAddressSchema
	.extend({
		columns: z
			.array(columnInputSchema)
			.min(1)
			.describe(
				"The columns to append, in display order. Supply columnUuid when another item in this call references the column; otherwise Nova mints it.",
			),
	})
	.strict();

export type AddCaseListColumnsInput = z.infer<
	typeof addCaseListColumnsInputSchema
>;

/**
 * Success result — the new columns' uuids surfaced both as a structured
 * field and in the human-readable message so the SA can reference any of
 * them on a subsequent atomic op without re-reading the module. `uuids` is
 * positionally aligned with the input `columns`.
 */
export interface AddCaseListColumnsSuccess extends MutationSuccess {
	uuids: Uuid[];
}

export type AddCaseListColumnsResult =
	| AddCaseListColumnsSuccess
	| { error: string };

export const addCaseListColumnsTool = {
	description:
		"Add columns to a module's case list. Returns the minted uuids (input order) for later update/remove/reorder calls.",
	inputSchema: addCaseListColumnsInputSchema,
	async execute(
		input: AddCaseListColumnsInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddCaseListColumnsResult>> {
		const { columns } = input;
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

			const uuids = columns.map((column) =>
				column.columnUuid === undefined ? newUuid() : asUuid(column.columnUuid),
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
						error: `Column UUID "${collision}" is duplicated in this call or already belongs to an authored object.`,
					},
				};
			}
			const stamped = columns.map((c, i) => stampColumnUuid(c, uuids[i]));
			// `addColumnsMutation` can't fail on a resolved module — it returns
			// `CaseListMutationOk` (no error arm), so there's no error branch here.
			const result = addColumnsMutation(mod, stamped);

			const commit = await guardedMutate(
				ctx,
				doc,
				result.mutations,
				`module:${moduleUuid}:caseList:column:add`,
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

			const headers = columns.map((c) => `"${c.header}"`).join(", ");
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				newDoc,
				result: {
					message: `Added ${columns.length} column${columns.length === 1 ? "" : "s"} to module "${mod.name}": ${headers}.`,
					uuids,
					summary: { location: mod.name, count: columns.length },
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
