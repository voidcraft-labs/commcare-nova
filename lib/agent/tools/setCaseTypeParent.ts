import { z } from "zod";
import {
	editCaseRelation,
	removeCaseRelations,
	setDefaultCaseParent,
} from "@/lib/doc/caseRelationEdit";
import type { Mutation } from "@/lib/doc/types";
import {
	type CaseRelation,
	caseRelationSchema,
	declaredCaseRelations,
} from "@/lib/domain/caseRelations";
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
		.describe(
			"Defaults to child. An extension shares its parent's lifecycle. When removing a link, give it to remove only the link of that kind; leave it out to remove the link of either kind.",
		),
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
				const name = input.link.name;
				const target = input.parentType;
				let mutations: Mutation[];
				if (input.link.change === "add")
					mutations = editCaseRelation(current, "add", {
						identifier: name,
						targetType: target,
						relationship: input.relationship ?? "child",
					});
				else {
					const declared = declaredCaseRelations(current);
					const matching = declared.filter(
						(edge) =>
							edge.identifier === name &&
							edge.targetType === target &&
							(input.relationship === undefined ||
								edge.relationship === input.relationship),
					);
					if (matching.length === 0)
						return {
							kind: "mutate",
							mutations: [],
							result: { error: missingLinkError(current.name, declared) },
						};
					mutations = removeCaseRelations(current, matching);
				}
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
			const mutations = setDefaultCaseParent(
				current,
				input.parentType === null
					? null
					: {
							identifier: "parent",
							targetType: input.parentType,
							relationship: input.relationship ?? "child",
						},
			);
			if (mutations.length === 0)
				return {
					kind: "mutate",
					mutations: [],
					result: { ok: true, summary: { noop: true } },
				};
			const commit = await guardedMutate(ctx, mutations, "case-type:parent");
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

/** The refusal for a link removal that names no link the type holds. */
function missingLinkError(
	caseType: string,
	declared: readonly CaseRelation[],
): string {
	const held = declared.map(
		(edge) =>
			`${edge.identifier} to ${edge.targetType}${edge.relationship ? ` (${edge.relationship})` : ""}`,
	);
	return held.length === 0
		? `The record type ${caseType} has no links to remove.`
		: `The record type ${caseType} has no such link. Its links are: ${held.join(", ")}. You can name one of those to remove it.`;
}
