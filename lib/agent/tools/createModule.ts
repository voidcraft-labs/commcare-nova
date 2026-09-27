/** Create a module in the private candidate; forms and list refinements are separate operations. */
import { z } from "zod";
import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	childModuleUuids,
	findAuthoredBlueprintIdentity,
	uuidSchema,
} from "@/lib/domain";
import { addModuleMutations } from "../blueprintHelpers";
import type { ToolInvocationContext } from "../workspace/types";
import { newUuid, stampColumnUuid } from "./case-list-config/shared";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const createModuleInputSchema = z
	.strictObject({
		moduleUuid: uuidSchema
			.optional()
			.describe(
				"Stable UUID for the new module. Omit when nothing in the call references it.",
			),
		parentModuleUuid: uuidSchema
			.optional()
			.describe(
				"Stable UUID of the top-level module that should contain this module. Omit to create a top-level module.",
			),
		name: z.string().min(1).describe("Module display name"),
		parentCaseModuleUuid: uuidSchema
			.optional()
			.describe(
				"Select a parent record from this module before showing this module's records. Omit for a flat list.",
			),
		case_type: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				"Record type for this module. A new name declares the type; null for surveys.",
			),
		purpose: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				"Brief description of this module's role in the app. null when there's nothing to add.",
			),
		case_list_only: z
			.boolean()
			.nullable()
			.optional()
			.describe(
				"True for case-list-only modules with no forms. Use for child case types that need to be viewable but have no follow-up workflow. null otherwise.",
			),
	})
	.superRefine((input, ctx) => {
		if (input.case_list_only === true && input.case_type == null) {
			ctx.addIssue({
				code: "custom",
				path: ["case_type"],
				message:
					"A case-list-only module must name the case_type whose records it shows.",
			});
		}
	});
export type CreateModuleInput = z.infer<typeof createModuleInputSchema>;

/** Human-readable success string or an error record. */
export type CreateModuleResult =
	| (MutationSuccess & {
			moduleUuid: string;
			parentModuleUuid: string | null;
			childModuleUuids: string[];
			moduleOrder: string[];
			columns: Array<{ uuid: string }>;
	  })
	| { error: string };

export const createModuleTool = {
	description:
		"Create a module. Add its forms separately; record modules start with a Name column.",
	inputSchema: createModuleInputSchema,
	async execute(
		input: CreateModuleInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<CreateModuleResult>> {
		const doc = ctx.snapshot.doc;
		const {
			moduleUuid: requestedModuleUuid,
			parentModuleUuid,
			parentCaseModuleUuid,
			name,
			case_type,
			purpose,
			case_list_only,
		} = input;
		try {
			// Stage tag `module:create` — a positional index isn't available
			// yet because the new module's slot only exists after the
			// mutations apply. Downstream consumers that need the index read
			// it from the post-mutation `moduleOrder`.
			const moduleUuid = requestedModuleUuid ?? asUuid(crypto.randomUUID());
			if (findAuthoredBlueprintIdentity(doc, moduleUuid) !== undefined) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error: `moduleUuid ${moduleUuid} already belongs to an authored entity in this app.`,
					},
				};
			}
			const columns = case_type
				? [
						stampColumnUuid(
							{ kind: "plain", field: "case_name", header: "Name" },
							newUuid(),
						),
					]
				: [];
			const mutations: Mutation[] = [
				...(case_type && !doc.caseTypes?.some((type) => type.name === case_type)
					? [{ kind: "declareCaseType" as const, caseType: case_type }]
					: []),
				...addModuleMutations({
					uuid: moduleUuid,
					name,
					...(parentModuleUuid !== undefined && { parentModuleUuid }),
					...(parentCaseModuleUuid !== undefined && { parentCaseModuleUuid }),
					...(case_type && { caseType: case_type }),
					...(case_list_only && { caseListOnly: case_list_only }),
					...(purpose != null && { purpose }),
					...(columns.length > 0 && {
						caseListConfig: {
							columns,
							listColumnOrder: columns.map((column) => column.uuid),
							detailColumnOrder: columns.map((column) => column.uuid),
							searchInputs: [],
						},
					}),
				}),
			];

			const commit = await guardedMutate(ctx, mutations, "module:create");
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: commit.error },
				};
			}
			const newDoc = commit.newDoc;

			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					ok: true,
					moduleUuid,
					parentModuleUuid:
						newDoc.modules[moduleUuid]?.parentModuleUuid ?? null,
					childModuleUuids: childModuleUuids(newDoc, moduleUuid),
					moduleOrder: [...newDoc.moduleOrder],
					columns: columns.map((column) => ({ uuid: column.uuid })),
					summary: { subject: name } satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
