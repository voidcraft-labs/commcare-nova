import { z } from "zod";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import { moveCaseOperationMutation } from "@/lib/doc/caseOperationMutations";
import { type BlueprintDoc, orderedCaseOperations } from "@/lib/domain";
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

export const moveCaseOperationInputSchema = operationAddressSchema.extend({
	operationId: z.string().min(1),
	index: z.number().int().nonnegative().describe("0-based destination index"),
});

export type MoveCaseOperationInput = z.infer<
	typeof moveCaseOperationInputSchema
>;

export interface MoveCaseOperationSuccess extends MutationSuccess {
	readonly index: number;
}

export type MoveCaseOperationResult =
	| MoveCaseOperationSuccess
	| { readonly error: string };

export const moveCaseOperationTool = {
	description:
		"Move one case operation to a 0-based execution index. Refuses dependency-breaking or non-portable wire order and names the involved operations.",
	inputSchema: moveCaseOperationInputSchema,
	async execute(
		input: MoveCaseOperationInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<MoveCaseOperationResult>> {
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
			const actualIndex = Math.max(
				0,
				Math.min(
					input.index,
					orderedCaseOperations(doc.forms[address.formUuid] ?? {}).length - 1,
				),
			);
			const plan = moveCaseOperationMutation(
				doc,
				address.formUuid,
				operation.uuid,
				actualIndex,
			);
			if (!plan.ok) {
				const involved = dependentOperationNames(
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
							plan.reason === "execution-order"
								? `Cannot move "${input.operationId}" there because the submitted form cannot preserve that execution order${involved ? ` (${involved})` : ""}.`
								: `Cannot move "${input.operationId}" there because it would break dependencies${involved ? ` involving ${involved}` : ""}.`,
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
			const committedIndex = orderedCaseOperations(
				commit.newDoc.forms[address.formUuid] ?? {},
			).findIndex((candidate) => candidate.uuid === operation.uuid);
			if (committedIndex < 0) {
				throw new BlueprintCommitRejectedError(
					`Case operation "${input.operationId}" changed while it was moving. Reload the form and try again.`,
				);
			}
			return {
				kind: "mutate",
				mutations,
				newDoc: commit.newDoc,
				result: {
					message: `Moved case operation "${input.operationId}" to index ${committedIndex}.`,
					index: committedIndex,
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
