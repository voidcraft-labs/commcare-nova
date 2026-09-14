import { z } from "zod";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import type { MutationSuccess } from "./shared/toolCallSummary";

export const setCaseTypeParentInputSchema = z
	.object({
		caseType: z.string().min(1),
		parentType: z.string().min(1).nullable(),
		relationship: z
			.enum(["child", "extension"])
			.optional()
			.describe(
				"Defaults to child. An extension shares its parent's lifecycle.",
			),
	})
	.strict();

export const setCaseTypeParentTool = {
	description:
		"Set or clear a record type's parent relationship. Existing records keep their saved links. This does not change module navigation; parentCaseModuleUuid chooses a parent before showing a module's records.",
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
