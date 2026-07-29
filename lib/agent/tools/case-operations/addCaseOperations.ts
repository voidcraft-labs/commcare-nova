import { z } from "zod";
import { addCaseOperationMutations } from "@/lib/doc/caseOperationMutations";
import {
	asUuid,
	type BlueprintDoc,
	findAuthoredBlueprintIdentity,
	type Uuid,
} from "@/lib/domain";
import type { ToolExecutionContext } from "../../toolExecutionContext";
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
					operationUuid: z
						.uuid()
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
		// The batch duplicate-id check rides the FIELD, not the object.
		// `lib/mcp/adapters/sharedToolAdapter.ts` rebuilds the wire schema
		// from `inputSchema.shape` and hands the SDK-parsed args straight
		// to `execute`, so an object-level refinement never runs on the
		// MCP path — an MCP client could add two operations sharing one
		// id in a call the chat path refuses. A field-level refinement
		// travels with the field.
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
	index: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Insertion index for the first item; defaults to the end"),
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
		"Add one or more complete case operations to a form. Operations create, update, or close cases when the form is submitted.",
	inputSchema: addCaseOperationsInputSchema,
	async execute(
		input: AddCaseOperationsInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddCaseOperationsResult>> {
		try {
			const address = resolveOperationAddress(doc, input);
			if (!address.ok) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
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
					newDoc: doc,
					result: {
						error: `Operation UUID "${duplicateOperationUuid}" is already in use.`,
					},
				};
			}
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
						newDoc: doc,
						result: {
							error: `Operation "${authorOperation.id}" was not added: ${idError}`,
						},
					};
				}
				const operation = resolveCaseOperationInput(
					authorOperation,
					operationUuids[offset] as Uuid,
				);
				const planned = addCaseOperationMutations(
					working,
					address.formUuid,
					operation,
					input.index === undefined ? undefined : input.index + offset,
				);
				mutations.push(...planned);
				working = applyToDoc(working, planned);
			}

			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`form:${address.formUuid}`,
			);
			if (!commit.ok) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: { error: commit.error },
				};
			}
			const operationIds = input.operations.map((item) => item.operation.id);
			return {
				kind: "mutate",
				mutations,
				newDoc: commit.newDoc,
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
			return toToolErrorResult(error, doc);
		}
	},
};
