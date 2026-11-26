import { z } from "zod";
import { planDetailTabGroups } from "@/lib/doc/caseDetailTabMutations";
import { detailTabRowSourceSchema } from "@/lib/domain/detailTabs";
import { conditionSchema, valueSchema } from "@/lib/domain/expression";
import { type Uuid, uuidSchema } from "@/lib/domain/uuid";
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
import type { MutationSuccess } from "../shared/toolCallSummary";
import { newUuid } from "./shared";

const inputSchema = moduleAddressSchema
	.extend({
		tabs: z
			.array(
				z.strictObject({
					tabUuid: uuidSchema
						.optional()
						.describe(
							"The existing tab to keep, from getModule. Leave out for a new tab.",
						),
					title: z.string().trim().min(1),
					displayCondition: conditionSchema
						.nullable()
						.optional()
						.describe(
							"Show the tab when this condition is true for the case the worker opens. Omit to keep its rule, or use null to show the tab for every case.",
						),
					rowSource: detailTabRowSourceSchema
						.nullable()
						.optional()
						.describe(
							"Choose open child cases or an ordered collection of records from a case roster, table or places. Omit to keep the current source, or use null to show the selected case.",
						),
					orderFields: z
						.array(uuidSchema)
						.optional()
						.describe(
							"For a tab of records, use these fields only to sort its rows as text. Their order on Details decides priority.",
						),
					addFields: z
						.array(
							z.strictObject({
								header: z.string().trim().min(1),
								expression: valueSchema,
							}),
						)
						.optional()
						.describe(
							"Add fields to the end of this tab in the same edit as its source. Each expression reads one row, such as a column from the chosen table.",
						),
					columnUuids: z
						.array(uuidSchema)
						.describe(
							"The visible Details fields in this tab, in the order workers should see them.",
						),
				}),
			)
			.describe(
				"Each visible Details field appears once across all tabs. An empty list shows all fields together, in their existing order.",
			),
	})
	.strict();

type Result = (MutationSuccess & { tabUuids: Uuid[] }) | { error: string };
export const setCaseDetailTabsTool = {
	description:
		"Group a menu's case Details fields into named tabs. Move a whole tab by moving it with its ordered fields. Use getModule for the current field and tab identities.",
	inputSchema,
	async execute(
		input: z.infer<typeof inputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<Result>> {
		const refuse = (error: string): MutatingToolResult<Result> => ({
			kind: "mutate",
			mutations: [],
			result: { error },
		});
		try {
			const address = resolveModuleAddress(ctx.snapshot.doc, input);
			if (!address.ok) return refuse(address.error);
			const config = address.module.caseListConfig;
			if (!config)
				return refuse(
					"This menu needs a case list with fields shown in Details before you can add a tab.",
				);
			const existing = new Set(config.detailTabs?.map((tab) => tab.uuid));
			const missing = input.tabs.find(
				(tab) => tab.tabUuid !== undefined && !existing.has(tab.tabUuid),
			);
			if (missing)
				return refuse(
					"This tab has changed. Read the menu again to find its current tabs.",
				);
			const groups = input.tabs.map((tab) => ({
				uuid: tab.tabUuid ?? newUuid(),
				title: tab.title,
				fields: tab.columnUuids,
				newFields: tab.addFields?.map((field) => ({
					...field,
					uuid: newUuid(),
				})),
				rowSource: tab.rowSource,
				orderFields: tab.orderFields,
				displayCondition: tab.displayCondition,
			}));
			const plan = planDetailTabGroups(address.moduleUuid, config, groups);
			if ("error" in plan) return refuse(plan.error);
			const commit = await guardedMutate(
				ctx,
				plan.mutations,
				`module:${address.moduleUuid}:caseList:detailTabs`,
			);
			if (!commit.ok) return refuse(commit.error);
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					ok: true,
					tabUuids:
						commit.newDoc.modules[
							address.moduleUuid
						]?.caseListConfig?.detailTabs?.map((tab) => tab.uuid) ?? [],
					summary: { location: address.module.name, count: groups.length },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
