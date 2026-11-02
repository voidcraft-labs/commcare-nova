import type { z } from "zod";
import { planCaseOperationUpdate } from "@/lib/doc/caseOperationMutations";
import {
	asUuid,
	type CaseOperation,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import {
	type OperationSemantics,
	operationSemantics,
} from "../../authoring/operationSemantics";
import type { ToolInvocationContext } from "../../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	caseOperationUpdateInputSchema,
	OWN_CASE_OPERATION_REFUSAL,
	operationAddressSchema,
	operationByUuid,
	operationIdRejection,
	resolveCaseOperationInput,
	resolveOperationAddress,
	resolveOwnCaseOperationInput,
} from "./shared";

export const updateCaseOperationInputSchema = operationAddressSchema.extend({
	operationUuid: uuidSchema.describe("Stable UUID of the operation to update"),
	operation: caseOperationUpdateInputSchema.describe(
		"Complete desired operation. Omitted optional facets are cleared; unchanged slots emit no mutation.",
	),
});

export type UpdateCaseOperationInput = z.infer<
	typeof updateCaseOperationInputSchema
>;

export interface UpdateCaseOperationSuccess extends MutationSuccess {
	readonly operationUuid: Uuid;
	readonly operationId: string;
	readonly operationSemantics: OperationSemantics;
}

export type UpdateCaseOperationResult =
	| UpdateCaseOperationSuccess
	| { readonly error: string };

export const updateCaseOperationTool = {
	description:
		"Replace one case change, keeping its identity, including this form's own case. Read it with getCaseOperations before editing.",
	inputSchema: updateCaseOperationInputSchema,
	async execute(
		input: UpdateCaseOperationInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<UpdateCaseOperationResult>> {
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
			const existing = operationByUuid(
				doc,
				address.formUuid,
				asUuid(input.operationUuid),
			);
			if (existing === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: `Case operation UUID "${input.operationUuid}" not found in form "${doc.forms[address.formUuid]?.name ?? input.formUuid}".`,
					},
				};
			}
			// This form's own case is edited only as itself, and nothing else
			// becomes it: the form's type alone adds and removes it.
			if ((existing.action === "own") !== (input.operation.action === "own")) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: `Operation "${existing.id}" was not updated: ${OWN_CASE_OPERATION_REFUSAL}`,
					},
				};
			}
			let next: CaseOperation;
			if (input.operation.action === "own") {
				if (existing.action !== "own")
					throw new Error("The own arm check drifted from its operation.");
				next = resolveOwnCaseOperationInput(input.operation, existing);
			} else {
				const formOperations =
					doc.forms[address.formUuid]?.caseOperations ?? [];
				const idError = operationIdRejection(
					formOperations,
					input.operation.id,
					existing.uuid,
				);
				if (idError !== undefined) {
					return {
						kind: "mutate",
						mutations: [],
						result: {
							error: `Operation "${existing.id}" was not updated: ${idError}`,
						},
					};
				}
				next = resolveCaseOperationInput(input.operation, existing.uuid);
			}
			const plan = planCaseOperationUpdate(doc, address.formUuid, next);
			if (!plan.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: `Operation "${existing.id}" was not updated: ${plan.reason}`,
					},
				};
			}
			const mutations = [...plan.mutations];
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
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					ok: true,
					operationUuid: existing.uuid,
					operationId: next.id,
					operationSemantics: operationSemantics(
						commit.newDoc,
						address.formUuid,
					),
					summary: {
						location: doc.forms[address.formUuid]?.name ?? input.formUuid,
						subject: next.id,
					},
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
