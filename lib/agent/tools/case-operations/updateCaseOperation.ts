import { z } from "zod";
import { planCaseOperationUpdate } from "@/lib/doc/caseOperationMutations";
import type { BlueprintDoc } from "@/lib/domain";
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
	operationById,
	operationIdRejection,
	resolveCaseOperationInput,
	resolveOperationAddress,
} from "./shared";

export const updateCaseOperationInputSchema = operationAddressSchema.extend({
	operationId: z.string().min(1).describe("Current operation id"),
	operation: caseOperationInputSchema.describe(
		"Complete desired operation. Omitted optional facets are cleared; unchanged slots emit no mutation.",
	),
});

export type UpdateCaseOperationInput = z.infer<
	typeof updateCaseOperationInputSchema
>;

export interface UpdateCaseOperationSuccess extends MutationSuccess {
	readonly operationId: string;
}

export type UpdateCaseOperationResult =
	| UpdateCaseOperationSuccess
	| { readonly error: string };

export const updateCaseOperationTool = {
	description:
		"Update one case operation by id. Supply its complete desired author shape; Nova emits only the identity-keyed slots that actually changed, so unrelated concurrent edits compose.",
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
			const existing = operationById(doc, address.formUuid, input.operationId);
			if (existing === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error: `Case operation "${input.operationId}" not found in ${input.moduleId}/${input.formId}.`,
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
						error: `Operation "${input.operationId}" was not updated: ${idError}`,
					},
				};
			}
			const next = resolveCaseOperationInput(
				doc,
				address.formUuid,
				input.operation,
				existing.uuid,
			);
			const plan = planCaseOperationUpdate(doc, address.formUuid, next);
			if (!plan.ok) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error: `Operation "${input.operationId}" was not updated: ${plan.reason}`,
					},
				};
			}
			const mutations = [...plan.mutations];
			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`form:${input.moduleId}/${input.formId}`,
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
				mutations,
				newDoc: commit.newDoc,
				result: {
					message:
						mutations.length === 0
							? `Case operation "${input.operationId}" was already up to date.`
							: `Updated case operation "${input.operationId}"${input.operation.id === input.operationId ? "" : ` as "${input.operation.id}"`}.`,
					operationId: input.operation.id,
					summary: {
						location: doc.forms[address.formUuid]?.name ?? input.formId,
						subject: input.operation.id,
					},
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};
