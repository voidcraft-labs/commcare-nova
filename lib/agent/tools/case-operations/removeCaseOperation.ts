import { z } from "zod";
import {
	caseOperationAuthoringVerdict,
	removeCaseOperationMutation,
} from "@/lib/doc/caseOperationMutations";
import type { BlueprintDoc } from "@/lib/domain";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	dependentOperationNames,
	operationAddressSchema,
	operationById,
	resolveOperationAddress,
} from "./shared";

export const removeCaseOperationInputSchema = operationAddressSchema.extend({
	operationId: z.string().min(1),
});

export type RemoveCaseOperationInput = z.infer<
	typeof removeCaseOperationInputSchema
>;

export type RemoveCaseOperationResult =
	| MutationSuccess
	| { readonly error: string };

export const removeCaseOperationTool = {
	description:
		"Remove one case operation by id. Refuses removal while another operation still depends on it or while the operation carries preserved logic this surface cannot safely author; dependency refusals name every dependent.",
	inputSchema: removeCaseOperationInputSchema,
	async execute(
		input: RemoveCaseOperationInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<RemoveCaseOperationResult>> {
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
			const operation = operationById(doc, address.formUuid, input.operationId);
			if (operation === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error: `Case operation "${input.operationId}" not found in ${input.moduleId}/${input.formId}.`,
					},
				};
			}
			const authoringVerdict = caseOperationAuthoringVerdict(operation);
			if (!authoringVerdict.ok) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error: `Operation "${input.operationId}" was not removed: ${authoringVerdict.reason}`,
					},
				};
			}
			const plan = removeCaseOperationMutation(
				doc,
				address.formUuid,
				operation.uuid,
			);
			if (!plan.ok) {
				const dependents = dependentOperationNames(
					doc,
					address.formUuid,
					plan.dependentUuids,
				);
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error:
							plan.reason === "dependent-reference"
								? `Cannot remove "${input.operationId}" while ${dependents || "another operation"} depends on it. Retarget or remove those references first.`
								: `Case operation "${input.operationId}" could not be removed.`,
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
					message: `Removed case operation "${input.operationId}".`,
					summary: {
						location: doc.forms[address.formUuid]?.name ?? input.formId,
						subject: input.operationId,
					},
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};
