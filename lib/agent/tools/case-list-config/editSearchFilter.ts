import { z } from "zod";
import { enableCaseSearchMutation } from "@/lib/doc/caseSearchConfigMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	effectiveCaseSearchConfig,
	searchFilterSchema,
	uuidSchema,
} from "@/lib/domain";
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
import { newUuid } from "./shared";

const fields = searchFilterSchema.omit({ uuid: true });
export const editSearchFilterInputSchema = moduleAddressSchema
	.extend({
		change: z.discriminatedUnion("operation", [
			fields.extend({
				operation: z.literal("add"),
				uuid: uuidSchema.optional(),
				after: uuidSchema.nullable().optional(),
			}),
			fields
				.partial()
				.extend({ operation: z.literal("edit"), uuid: uuidSchema }),
			z.strictObject({ operation: z.literal("remove"), uuid: uuidSchema }),
			z.strictObject({
				operation: z.literal("move"),
				uuid: uuidSchema,
				after: uuidSchema.nullable(),
			}),
		]),
	})
	.strict();

type Result =
	| { ok: true; uuid: string; summary: { location: string } }
	| { error: string };

export const editSearchFilterTool = {
	description:
		"Add, change, move or remove one online search filter. Its target chooses the information to match, and its value comes from the worker, an earlier selection, a search answer, a table or a constant. Rows on the same target send their values together.",
	inputSchema: editSearchFilterInputSchema,
	async execute(
		input: z.infer<typeof editSearchFilterInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<Result>> {
		try {
			const address = resolveModuleAddress(ctx.snapshot.doc, input);
			if (!address.ok)
				return {
					kind: "mutate",
					mutations: [],
					result: { error: address.error },
				};
			const { module: mod, moduleUuid } = address;
			if (!mod.caseType)
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: "Choose a menu with a record list for this search filter.",
					},
				};
			const change = input.change;
			const uuid = change.uuid ?? newUuid();
			const edits: Mutation[] = [];
			if (!mod.caseListConfig)
				edits.push({
					kind: "updateModule",
					uuid: moduleUuid,
					patch: {},
					ensureCaseListConfig: true,
				});
			if (change.operation === "add" && !effectiveCaseSearchConfig(mod))
				edits.push(enableCaseSearchMutation(moduleUuid, mod.caseSearchConfig));
			const searchFilterEdit =
				change.operation === "add"
					? {
							operation: "add" as const,
							filter: { uuid, target: change.target, value: change.value },
							// Omitted, the row goes last; the wire carries no `undefined`.
							...(change.after !== undefined && { after: change.after }),
						}
					: change.operation === "edit"
						? {
								operation: "edit" as const,
								uuid,
								patch: {
									...(change.target !== undefined && { target: change.target }),
									...(change.value !== undefined && { value: change.value }),
								},
							}
						: change;
			edits.push({
				kind: "setCaseListMeta",
				uuid: moduleUuid,
				patch: { searchFilterEdit },
			});
			const committed = await guardedMutate(
				ctx,
				edits,
				`module:${moduleUuid}:searchFilter:${uuid}`,
			);
			if (!committed.ok)
				return {
					kind: "mutate",
					mutations: [],
					result: { error: committed.error },
				};
			return {
				kind: "mutate",
				mutations: committed.mutations,
				result: { ok: true, uuid, summary: { location: mod.name } },
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
