import { z } from "zod";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import {
	type CaseOperationMutationPlan,
	moveCaseOperationMutation,
} from "@/lib/doc/caseOperationMutations";
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

/**
 * Why the destination was refused, in words that fit the constraint that
 * refused it — the SA half of the same three-way split the builder makes
 * in `components/builder/case-operations/refusalCopy.ts`.
 *
 * A `reference` blocker holds an `id-of` edge that the order would put
 * on the wrong side of its producer. A `target-type` blocker holds no
 * reference at all: the order would change which kind of case it acts
 * on, so "retarget those references" names an edge that does not exist.
 * `execution-order` is not about the author's changes at all — the
 * SUBMITTED FORM cannot carry that sequence.
 */
function moveRefusal(
	operationId: string,
	plan: Extract<CaseOperationMutationPlan, { ok: false }>,
	involved: string,
): string {
	switch (plan.reason) {
		case "operation-not-found":
			return `Case operation "${operationId}" is no longer part of this form.`;
		case "execution-order":
			return `Cannot move "${operationId}" there because the submitted form cannot preserve that execution order${involved ? ` (${involved})` : ""}.`;
		case "dependent-reference":
			return plan.dependencyKind === "target-type"
				? `Cannot move "${operationId}" there because that order would change which kind of case ${involved || "a later operation"} acts on.`
				: `Cannot move "${operationId}" there because it would break the reference ${involved || "another operation"} has to a case an earlier operation makes.`;
	}
}

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
						error: `Case operation "${input.operationId}" not found in form "${doc.forms[address.formUuid]?.name ?? input.formUuid}".`,
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
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error: moveRefusal(
							input.operationId,
							plan,
							dependentOperationNames(
								doc,
								address.formUuid,
								plan.dependentUuids,
							),
						),
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
						location: doc.forms[address.formUuid]?.name ?? input.formUuid,
						subject: input.operationId,
					},
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};
