/** Create a module in the private candidate; forms and list refinements are separate operations. */

import { z } from "zod";
import {
	declareCaseTypeMutations,
	listedFormMenuMutations,
} from "@/lib/doc/scaffolds";
import { withListedMenuHierarchy } from "@/lib/doc/sharedMenuHierarchy";
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
import {
	caseListMenuItemFromInput,
	caseListMenuItemInputSchema,
} from "./shared/caseListMenuItem";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const createModuleInputSchema = z
	.strictObject({
		forms_from_menu: z
			.strictObject({
				menuUuid: uuidSchema.describe(
					"The menu that owns the forms to list here.",
				),
				excludedFormUuids: z
					.array(uuidSchema)
					.optional()
					.describe(
						"Forms to leave off this menu. New forms in the source appear here automatically.",
					),
			})
			.optional()
			.describe(
				"A second way to reach the same forms. The source supplies the case type; each menu keeps its own case details and deep links.",
			),
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
				"Record type this module lists. Use commcare-user for the worker’s own record, a new name to declare a business record type, or null for surveys.",
			),
		purpose: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				"Brief description of this module's role in the app. null when there's nothing to add.",
			),
		case_list_menu_item: caseListMenuItemInputSchema
			.optional()
			.describe(
				"Shows the case list as its own item in this menu, so workers can look up a case without opening a form. Needs case_type. A module created without forms needs it.",
			),
	})
	.superRefine((input, ctx) => {
		if (
			input.forms_from_menu &&
			(input.case_type != null || input.case_list_menu_item !== undefined)
		)
			ctx.addIssue({
				code: "custom",
				path: ["forms_from_menu"],
				message:
					"A menu listing another menu’s forms uses its source’s case type and opens the list through a form.",
			});
		if (input.case_list_menu_item !== undefined && input.case_type == null) {
			ctx.addIssue({
				code: "custom",
				path: ["case_type"],
				message:
					"A module with its case list in the menu must name the case_type whose records it shows.",
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
		"Create a module. Add its forms separately; record modules start with a Name column, and one created without forms shows its case list as its menu item.",
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
			case_list_menu_item,
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
			const shared =
				input.forms_from_menu &&
				listedFormMenuMutations(doc, {
					...input.forms_from_menu,
					uuid: moduleUuid,
					name,
					parentModuleUuid,
					parentCaseModuleUuid,
					purpose: purpose ?? undefined,
				});
			if (shared && !shared.ok)
				return {
					kind: "mutate",
					mutations: [],
					result: { error: shared.message },
				};
			const columns = case_type
				? [
						stampColumnUuid(
							{ kind: "plain", field: "case_name", header: "Name" },
							newUuid(),
						),
					]
				: [];
			const mutations: Mutation[] = [
				...(case_type ? declareCaseTypeMutations(doc, case_type) : []),
				...(shared?.mutations ??
					addModuleMutations(
						{
							uuid: moduleUuid,
							name,
							...(parentModuleUuid !== undefined && { parentModuleUuid }),
							...(parentCaseModuleUuid !== undefined && {
								parentCaseModuleUuid,
							}),
							...(case_type && { caseType: case_type }),
							...(case_list_menu_item !== undefined && {
								caseListMenuItem:
									caseListMenuItemFromInput(case_list_menu_item),
							}),
							...(purpose != null && { purpose }),
							...(columns.length > 0 && {
								caseListConfig: {
									columns,
									listColumnOrder: columns.map((column) => column.uuid),
									detailColumnOrder: columns.map((column) => column.uuid),
									searchInputs: [],
								},
							}),
						},
						doc,
					)),
			];

			const commit = await guardedMutate(
				ctx,
				withListedMenuHierarchy(doc, mutations),
				"module:create",
			);
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
					columns: (
						newDoc.modules[moduleUuid]?.caseListConfig?.columns ?? []
					).map((column) => ({ uuid: column.uuid })),
					summary: { subject: name } satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
