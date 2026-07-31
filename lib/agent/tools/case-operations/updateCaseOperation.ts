import type { z } from "zod";
import { planCaseOperationUpdate } from "@/lib/doc/caseOperationMutations";
import { asUuid, type BlueprintDoc, type Uuid, uuidSchema } from "@/lib/domain";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	caseOperationInputSchema,
	operationAddressSchema,
	operationByUuid,
	operationIdRejection,
	resolveCaseOperationInput,
	resolveOperationAddress,
} from "./shared";

export const updateCaseOperationInputSchema = operationAddressSchema.extend({
	operationUuid: uuidSchema.describe("Stable UUID of the operation to update"),
	operation: caseOperationInputSchema.describe(
		"Complete desired operation. Omitted optional facets are cleared; unchanged slots emit no mutation.",
	),
});

export type UpdateCaseOperationInput = z.infer<
	typeof updateCaseOperationInputSchema
>;

export interface UpdateCaseOperationSuccess extends MutationSuccess {
	readonly operationUuid: Uuid;
	readonly operationId: string;
}

export type UpdateCaseOperationResult =
	| UpdateCaseOperationSuccess
	| { readonly error: string };

export const updateCaseOperationTool = {
	description:
		"Update one case operation by stable UUID. Supply its complete desired shape; Nova emits only the identity-keyed slots that actually changed, so unrelated concurrent edits compose.",
	inputSchema: updateCaseOperationInputSchema,
	async execute(
		input: UpdateCaseOperationInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<UpdateCaseOperationResult>> {
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
			const existing = operationByUuid(
				doc,
				address.formUuid,
				asUuid(input.operationUuid),
			);
			if (existing === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error: `Case operation UUID "${input.operationUuid}" not found in form "${doc.forms[address.formUuid]?.name ?? input.formUuid}".`,
					},
				};
			}
			const formOperations = doc.forms[address.formUuid]?.caseOperations ?? [];
			const idError = operationIdRejection(
				formOperations,
				input.operation.id,
				existing.uuid,
			);
			if (idError !== undefined) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error: `Operation "${existing.id}" was not updated: ${idError}`,
					},
				};
			}
			const next = resolveCaseOperationInput(input.operation, existing.uuid);
			const plan = planCaseOperationUpdate(doc, address.formUuid, next);
			if (!plan.ok) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error: `Operation "${existing.id}" was not updated: ${plan.reason}`,
					},
				};
			}
			const mutations = [...plan.mutations];
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
			return {
				kind: "mutate",
				mutations: commit.mutations,
				newDoc: commit.newDoc,
				result: {
					message:
						mutations.length === 0
							? `Case operation "${existing.id}" was already up to date.`
							: `Updated case operation "${existing.id}"${input.operation.id === existing.id ? "" : ` as "${input.operation.id}"`}.`,
					operationUuid: existing.uuid,
					operationId: input.operation.id,
					summary: {
						location: doc.forms[address.formUuid]?.name ?? input.formUuid,
						subject: input.operation.id,
					},
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};
