import { z } from "zod";
import { addCaseOperationAfterMutations } from "@/lib/doc/caseOperationMutations";
import {
	asUuid,
	findAuthoredBlueprintIdentity,
	orderedCaseOperations,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import type { ToolInvocationContext } from "../../workspace/types";
import {
	applyToDoc,
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	caseOperationInputSchema,
	operationAddressSchema,
	operationIdRejection,
	resolveCaseOperationInput,
	resolveOperationAddress,
} from "./shared";

export const addCaseOperationsInputSchema = operationAddressSchema.extend({
	operations: z
		.array(
			z
				.object({
					operationUuid: uuidSchema
						.optional()
						.describe(
							"Stable UUID for the new operation. Supply it when another item in this call references the operation; otherwise Nova mints it.",
						),
					operation: caseOperationInputSchema.describe(
						"Complete operation body. References use stable UUIDs.",
					),
				})
				.strict(),
		)
		.min(1)
		// Keep the batch duplicate-id check on the operations FIELD: the rule
		// belongs to this collection and its issue path should point at the
		// duplicate item. The shared MCP adapter now registers the exact Zod
		// object (including refinements), so this same check runs on chat and
		// MCP before either handler.
		.superRefine((operations, ctx) => {
			const seen = new Set<string>();
			const seenUuids = new Set<string>();
			for (const [index, item] of operations.entries()) {
				if (seen.has(item.operation.id)) {
					ctx.addIssue({
						code: "custom",
						path: [index, "operation", "id"],
						message: `"${item.operation.id}" is repeated in this batch.`,
					});
				}
				seen.add(item.operation.id);
				if (
					item.operationUuid !== undefined &&
					seenUuids.has(item.operationUuid)
				) {
					ctx.addIssue({
						code: "custom",
						path: [index, "operationUuid"],
						message: `"${item.operationUuid}" is repeated in this batch.`,
					});
				}
				if (item.operationUuid !== undefined) {
					seenUuids.add(item.operationUuid);
				}
			}
		})
		.describe(
			"Operations in execution order. Cross-operation references use stable UUIDs; operation ids remain editable wire names.",
		),
	afterOperationUuid: uuidSchema
		.nullable()
		.optional()
		.describe(
			"UUID of the existing operation the new contiguous block should follow, null for first, or omit to append.",
		),
});

export type AddCaseOperationsInput = z.infer<
	typeof addCaseOperationsInputSchema
>;

export interface AddCaseOperationsSuccess extends MutationSuccess {
	readonly operationUuids: readonly Uuid[];
	readonly operationIds: readonly string[];
}

export type AddCaseOperationsResult =
	| AddCaseOperationsSuccess
	| { readonly error: string };

export const addCaseOperationsTool = {
	description:
		"Add one or more complete advanced case operations to a form. Operations create additional records or update/close targeted records when the form is submitted. A registration form's direct caseWrite fields already create its primary case; never add a create operation for that same record.",
	inputSchema: addCaseOperationsInputSchema,
	async execute(
		input: AddCaseOperationsInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<AddCaseOperationsResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const address = resolveOperationAddress(doc, input);
			if (!address.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: address.error },
				};
			}

			let working = doc;
			const mutations = [];
			const operationUuids = input.operations.map((item) =>
				asUuid(item.operationUuid ?? crypto.randomUUID()),
			);
			const duplicateOperationUuid = operationUuids.find(
				(uuid, index) =>
					findAuthoredBlueprintIdentity(doc, uuid) !== undefined ||
					operationUuids.indexOf(uuid) !== index,
			);
			if (duplicateOperationUuid !== undefined) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: `Operation UUID "${duplicateOperationUuid}" is already in use.`,
					},
				};
			}
			const initialAfter =
				input.afterOperationUuid === undefined ||
				input.afterOperationUuid === null
					? input.afterOperationUuid
					: asUuid(input.afterOperationUuid);
			if (
				initialAfter !== undefined &&
				initialAfter !== null &&
				!orderedCaseOperations(working.forms[address.formUuid] ?? {}).some(
					(operation) => operation.uuid === initialAfter,
				)
			) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: `Case operation UUID "${initialAfter}" is not an existing operation in form "${doc.forms[address.formUuid]?.name ?? input.formUuid}".`,
					},
				};
			}
			let afterOperationUuid = initialAfter;
			for (const [offset, item] of input.operations.entries()) {
				const authorOperation = item.operation;
				const formOperations =
					working.forms[address.formUuid]?.caseOperations ?? [];
				const idError = operationIdRejection(
					formOperations,
					authorOperation.id,
				);
				if (idError !== undefined) {
					return {
						kind: "mutate",
						mutations: [],
						result: {
							error: `Operation "${authorOperation.id}" was not added: ${idError}`,
						},
					};
				}
				const operationUuid = operationUuids[offset];
				if (operationUuid === undefined) {
					throw new Error("Case-operation UUID allocation drifted from input.");
				}
				const operation = resolveCaseOperationInput(
					authorOperation,
					operationUuid,
				);
				const planned = addCaseOperationAfterMutations(
					working,
					address.formUuid,
					operation,
					afterOperationUuid,
				);
				mutations.push(...planned);
				working = applyToDoc(working, planned);
				afterOperationUuid = operation.uuid;
			}

			const commit = await guardedMutate(
				ctx,
				mutations,
				`form:${address.formUuid}`,
			);
			if (!commit.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: commit.error },
				};
			}
			const operationIds = input.operations.map((item) => item.operation.id);
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					message: `Added ${operationIds.length} case ${operationIds.length === 1 ? "operation" : "operations"} to form "${doc.forms[address.formUuid]?.name ?? input.formUuid}": ${operationIds.join(", ")}.`,
					operationUuids,
					operationIds,
					summary: {
						location: doc.forms[address.formUuid]?.name ?? input.formUuid,
						count: operationIds.length,
					},
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
