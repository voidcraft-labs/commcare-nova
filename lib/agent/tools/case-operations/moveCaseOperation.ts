import type { z } from "zod";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import {
	type CaseOperationMutationPlan,
	moveCaseOperationAfterMutation,
} from "@/lib/doc/caseOperationMutations";
import {
	asUuid,
	type BlueprintDoc,
	orderedCaseOperations,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
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
	operationByUuid,
	resolveOperationAddress,
} from "./shared";

export const moveCaseOperationInputSchema = operationAddressSchema.extend({
	operationUuid: uuidSchema,
	afterOperationUuid: uuidSchema
		.nullable()
		.describe(
			"UUID of the operation this one should follow, or null to make it first.",
		),
});

export type MoveCaseOperationInput = z.infer<
	typeof moveCaseOperationInputSchema
>;

export interface MoveCaseOperationSuccess extends MutationSuccess {
	readonly afterOperationUuid: Uuid | null;
	readonly operationOrder: readonly Uuid[];
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
		"Move one case operation after another operation identified by UUID, or to the beginning. Refuses dependency-breaking or non-portable wire order and names the involved operations.",
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
			const operation = operationByUuid(
				doc,
				address.formUuid,
				asUuid(input.operationUuid),
			);
			if (operation === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error: `Case operation UUID "${input.operationUuid}" not found in form "${doc.forms[address.formUuid]?.name ?? input.formUuid}".`,
					},
				};
			}
			const afterOperationUuid =
				input.afterOperationUuid === null
					? null
					: asUuid(input.afterOperationUuid);
			if (afterOperationUuid === operation.uuid) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error: `Case operation "${operation.id}" cannot follow itself.`,
					},
				};
			}
			if (
				afterOperationUuid !== null &&
				!orderedCaseOperations(doc.forms[address.formUuid] ?? {}).some(
					(candidate) => candidate.uuid === afterOperationUuid,
				)
			) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error: `Case operation UUID "${afterOperationUuid}" not found in form "${doc.forms[address.formUuid]?.name ?? input.formUuid}".`,
					},
				};
			}
			const plan = moveCaseOperationAfterMutation(
				doc,
				address.formUuid,
				operation.uuid,
				afterOperationUuid,
			);
			if (!plan.ok) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error: moveRefusal(
							operation.id,
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
			const committedOrder = orderedCaseOperations(
				commit.newDoc.forms[address.formUuid] ?? {},
			).map((candidate) => candidate.uuid);
			const committedIndex = committedOrder.indexOf(operation.uuid);
			if (committedIndex < 0) {
				throw new BlueprintCommitRejectedError(
					`Case operation "${operation.id}" changed while it was moving. Reload the form and try again.`,
				);
			}
			const committedAfter =
				committedIndex > 0
					? (committedOrder[committedIndex - 1] ?? null)
					: null;
			return {
				kind: "mutate",
				mutations,
				newDoc: commit.newDoc,
				result: {
					message:
						committedAfter === null
							? `Moved case operation "${operation.id}" to the beginning.`
							: `Moved case operation "${operation.id}" after operation UUID "${committedAfter}".`,
					afterOperationUuid: committedAfter,
					operationOrder: committedOrder,
					summary: {
						location: doc.forms[address.formUuid]?.name ?? input.formUuid,
						subject: operation.id,
					},
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};
