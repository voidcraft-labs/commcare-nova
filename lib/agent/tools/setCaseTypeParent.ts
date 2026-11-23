import { z } from "zod";
import { editCaseRelation } from "@/lib/doc/caseRelationEdit";
import { caseRelationSchema } from "@/lib/domain/caseRelations";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import type { MutationSuccess } from "./shared/toolCallSummary";

export const setCaseTypeParentInputSchema = z.strictObject({
	caseType: z.string().min(1),
	parentType: z.string().min(1).nullable(),
	link: z
		.strictObject({
			name: caseRelationSchema.shape.identifier,
			change: z.enum(["add", "remove"]),
		})
		.optional()
		.describe(
			"Use a named link to add or remove one destination, preserving the others. The same record type can link to several parent types.",
		),
	relationship: z
		.enum(["child", "extension"])
		.optional()
		.describe("Defaults to child. An extension shares its parent's lifecycle."),
});

export const setCaseTypeParentTool = {
	description:
		"Set or clear the default parent of a record type, or add or remove one named link to another record type. Existing records keep their saved links. This does not change module navigation; parentCaseModuleUuid chooses a parent before showing a module's records.",
	inputSchema: setCaseTypeParentInputSchema,
	async execute(
		input: z.infer<typeof setCaseTypeParentInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MutationSuccess | { error: string }>> {
		try {
			const types = ctx.snapshot.doc.caseTypes ?? [];
			const current = types.find((type) => type.name === input.caseType);
			if (
				!current ||
				(input.parentType !== null &&
					!types.some((type) => type.name === input.parentType))
			)
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error:
							"Both record types must be declared before setting their relationship.",
					},
				};
			if (input.parentType === null && input.relationship !== undefined)
				return {
					kind: "mutate",
					mutations: [],
					result: { error: "A cleared parent has no relationship kind." },
				};
			if (input.link !== undefined) {
				if (input.parentType === null)
					return {
						kind: "mutate",
						mutations: [],
						result: {
							error: "Choose the destination record type for this link.",
						},
					};
				const edge = {
					identifier: input.link.name,
					targetType: input.parentType,
					relationship: input.relationship ?? "child",
				} as const;
				const mutations = editCaseRelation(current, input.link.change, edge);
				if (mutations.length === 0)
					return {
						kind: "mutate",
						mutations: [],
						result: { ok: true, summary: { noop: true } },
					};
				const change = await guardedMutate(ctx, mutations, "case-type:link");
				return change.ok
					? {
							kind: "mutate",
							mutations: change.mutations,
							result: { ok: true, summary: { subject: input.caseType } },
						}
					: { kind: "mutate", mutations: [], result: { error: change.error } };
			}
			const parent_type = input.parentType;
			const relationship =
				parent_type === null ? null : (input.relationship ?? "child");
			if (
				(current.parent_type ?? null) === parent_type &&
				(current.relationship ?? (current.parent_type ? "child" : null)) ===
					relationship
			)
				return {
					kind: "mutate",
					mutations: [],
					result: { ok: true, summary: { noop: true } },
				};
			const commit = await guardedMutate(
				ctx,
				[
					{
						kind: "setCaseTypeMeta",
						caseType: input.caseType,
						parent_type,
						relationship,
					},
				],
				"case-type:parent",
			);
			if (!commit.ok)
				return {
					kind: "mutate",
					mutations: [],
					result: { error: commit.error },
				};
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: { ok: true, summary: { subject: input.caseType } },
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
