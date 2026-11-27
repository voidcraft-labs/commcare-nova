import { z } from "zod";
import { enableCaseSearchMutation } from "@/lib/doc/caseSearchConfigMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	effectiveCaseSearchConfig,
	searchFilterOrderSchema,
	searchRecordTypeRowSchema,
	searchRelatedIdRowSchema,
	searchValueFilterSchema,
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

const fields = searchValueFilterSchema.omit({ uuid: true });
export const editSearchFilterInputSchema = moduleAddressSchema
	.extend({
		change: z.discriminatedUnion("operation", [
			fields.extend({
				operation: z.literal("add"),
				uuid: uuidSchema.optional(),
				after: uuidSchema.nullable().optional(),
			}),
			z.strictObject({
				operation: z.literal("add-order"),
				order: searchFilterOrderSchema,
				uuid: uuidSchema.optional(),
				after: uuidSchema.nullable().optional(),
			}),
			z.strictObject({
				operation: z.literal("edit-order"),
				order: searchFilterOrderSchema,
				uuid: uuidSchema,
			}),
			fields
				.partial()
				.extend({ operation: z.literal("edit"), uuid: uuidSchema }),
			z.strictObject({
				operation: z.literal("set-request-row"),
				uuid: uuidSchema.optional(),
				after: uuidSchema.nullable().optional(),
				row: z.discriminatedUnion("kind", [
					searchRecordTypeRowSchema.omit({ uuid: true }),
					searchRelatedIdRowSchema.omit({ uuid: true }),
				]),
			}),
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
		"Add, change, move or remove one online search filter. Its target chooses the information to match, and its value comes from the worker, an earlier selection, a search answer, a table or a constant. Rows on the same target send their values together. The excluded-owners target leaves records of the owners its value names (separated by spaces) out of the online matches only; give it placement search-setting for a new rule, and keep one per search. add-order and edit-order set an order among the filters that chooses which matches the server sends first, without advanced case search. The indexed-fallback comparison uses one property, ascending, and replaces all earlier order rules with number, date, then text, with missing values last. Use it once in a Search that opens on results for one record type with no search fields, related records, or separate order. Keep the placement of rules brought in from CommCare HQ. set-request-row includes a record type in the request or follows the record ID held on a match. Supply the existing row UUID to change its setting.",
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
			/* An edit changes a row of its own kind: an order's terms, or a
			 * value filter's target and value. */
			if (change.operation === "edit" || change.operation === "edit-order") {
				const row = mod.caseListConfig?.searchFilters?.find(
					(one) => one.uuid === change.uuid,
				);
				const isOrder = row !== undefined && "order" in row;
				const isRequestRow =
					row !== undefined && !("order" in row) && !("target" in row);
				if (isRequestRow)
					return {
						kind: "mutate",
						mutations: [],
						result: {
							error: "Use set-request-row to change that Search setting.",
						},
					};
				if (
					row !== undefined &&
					isOrder !== (change.operation === "edit-order")
				)
					return {
						kind: "mutate",
						mutations: [],
						result: {
							error: isOrder
								? "That filter is an order. Use edit-order to change it, or remove it and add a filter."
								: "That filter matches a value. Use edit to change it, or remove it and add an order.",
						},
					};
			}
			const edits: Mutation[] = [];
			if (!mod.caseListConfig)
				edits.push({
					kind: "updateModule",
					uuid: moduleUuid,
					patch: {},
					ensureCaseListConfig: true,
				});
			if (
				(change.operation === "add" ||
					change.operation === "add-order" ||
					change.operation === "set-request-row") &&
				!effectiveCaseSearchConfig(mod)
			)
				edits.push(enableCaseSearchMutation(moduleUuid, mod.caseSearchConfig));
			// Omitted, the row goes last; the wire carries no `undefined`.
			const after =
				(change.operation === "add" ||
					change.operation === "add-order" ||
					change.operation === "set-request-row") &&
				change.after !== undefined
					? { after: change.after }
					: {};
			const searchFilterEdit =
				change.operation === "set-request-row"
					? mod.caseListConfig?.searchFilters?.some((row) => row.uuid === uuid)
						? {
								operation: "replace" as const,
								uuid,
								filter: { ...change.row, uuid },
							}
						: {
								operation: "add" as const,
								filter: { ...change.row, uuid },
								...after,
							}
					: change.operation === "add-order"
						? {
								operation: "add" as const,
								filter: { uuid, kind: "order" as const, order: change.order },
								...after,
							}
						: change.operation === "edit-order"
							? {
									operation: "edit" as const,
									uuid,
									patch: { order: change.order },
								}
							: change.operation === "add"
								? {
										operation: "add" as const,
										filter: {
											uuid,
											target: change.target,
											value: change.value,
										},
										...after,
									}
								: change.operation === "edit"
									? {
											operation: "edit" as const,
											uuid,
											patch: {
												...(change.target !== undefined && {
													target: change.target,
												}),
												...(change.value !== undefined && {
													value: change.value,
												}),
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
