import { z } from "zod";
import {
	type CaseOperationMutationPlan,
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

/**
 * Why the removal was refused, in words that fit the constraint that
 * refused it.
 *
 * The two `dependent-reference` kinds are genuinely different facts, and
 * the sentence that is true of one is false of the other: a `reference`
 * blocker holds an `id-of` edge that can be retargeted, while a
 * `target-type` blocker holds no reference at all — it would simply be
 * left acting on a kind of case this change is what establishes. Telling
 * the agent to "retarget those references" for a type dependency sends
 * it looking for an edge that does not exist. The builder's
 * `refusalCopy.ts` draws the same line; the two surfaces share the
 * "which kind of case … acts on" phrasing so an author and the agent
 * describe one refusal the same way.
 */
function removalRefusal(
	operationId: string,
	plan: Extract<CaseOperationMutationPlan, { ok: false }>,
	dependents: string,
): string {
	if (plan.reason !== "dependent-reference") {
		return `Case operation "${operationId}" could not be removed.`;
	}
	const named = dependents || "another operation";
	return plan.dependencyKind === "target-type"
		? `Cannot remove "${operationId}" because it establishes the kind of case ${named} acts on. Retarget or remove ${named} first.`
		: `Cannot remove "${operationId}" while ${named} uses its result. Retarget or remove those references first.`;
}

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
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error: removalRefusal(
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
