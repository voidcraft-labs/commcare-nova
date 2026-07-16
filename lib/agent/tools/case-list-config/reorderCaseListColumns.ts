/**
 * SA tool: `reorderCaseListColumns` — reorder a module's visible fields on
 * either Results or Details.
 *
 * Atomic op — writes only the selected screen's fractional keys while
 * preserving the generic order, the other screen, and every content slot.
 * The supplied uuid array is the new full VISIBLE order for that screen and
 * must contain every field shown there exactly once.
 *
 * Three exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. The supplied order doesn't permute the screen's visible uuids — length
 *      mismatch, duplicates, unknown uuids, or missing uuids → `{ error }`,
 *      no mutations.
 *   3. Success → `{ message, order }` plus the persisted mutation,
 *      tagged `module:M:caseList:column:reorder`.
 */

import { z } from "zod";
import { asUuid, type BlueprintDoc, type Uuid } from "@/lib/domain";
import {
	reorderColumnsMutation,
	resolveModuleUuid,
} from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import type { ToolCallSummary } from "../shared/toolCallSummary";
import { moduleNotFoundResult, uuidInputSchema } from "./shared";

export const reorderCaseListColumnsInputSchema = z
	.object({
		moduleIndex: z
			.number()
			.describe("0-based module index whose case list columns to reorder"),
		surface: z
			.enum(["results", "details"])
			.describe("The screen whose visible fields should be rearranged"),
		columnUuids: z
			.array(uuidInputSchema)
			.describe(
				"The new full visible-field order for the selected screen. Must contain every field currently shown on that screen exactly once. Use getModule's results_column_order or details_column_order for the current uuid set.",
			),
	})
	.strict();

export type ReorderCaseListColumnsInput = z.infer<
	typeof reorderCaseListColumnsInputSchema
>;

export interface ReorderCaseListColumnsSuccess {
	message: string;
	surface: "results" | "details";
	order: Uuid[];
	summary: ToolCallSummary;
}

export type ReorderCaseListColumnsResult =
	| ReorderCaseListColumnsSuccess
	| { error: string };

export const reorderCaseListColumnsTool = {
	description:
		"Reorder the visible fields on either Results or Details. The two screens have independent arrangements. Pass the selected screen and its full visible uuid order from getModule.",
	inputSchema: reorderCaseListColumnsInputSchema,
	async execute(
		input: ReorderCaseListColumnsInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<ReorderCaseListColumnsResult>> {
		const { moduleIndex, surface, columnUuids: rawColumnUuids } = input;
		const columnUuids = rawColumnUuids.map(asUuid);
		try {
			const moduleUuid = resolveModuleUuid(doc, moduleIndex);
			if (!moduleUuid)
				return moduleNotFoundResult<ReorderCaseListColumnsSuccess>(
					doc,
					moduleIndex,
					"reorder case list columns",
				);
			const mod = doc.modules[moduleUuid];
			if (!mod)
				return moduleNotFoundResult<ReorderCaseListColumnsSuccess>(
					doc,
					moduleIndex,
					"reorder case list columns",
				);

			const result = reorderColumnsMutation(
				mod,
				columnUuids,
				surface === "results" ? "list" : "detail",
			);
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
				`module:${moduleIndex}:caseList:column:reorder`,
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
				mutations: result.mutations,
				newDoc,
				result: {
					message: `Reordered ${columnUuids.length} field${columnUuids.length === 1 ? "" : "s"} on ${surface === "results" ? "Results" : "Details"} for module "${mod.name}".`,
					surface,
					order: [...columnUuids],
					summary: { location: mod.name, count: columnUuids.length },
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
