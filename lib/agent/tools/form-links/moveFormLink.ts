import type { z } from "zod";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import { planFormLinkMove } from "@/lib/doc/formLinkMutations";
import { asUuid, type Uuid, uuidSchema } from "@/lib/domain";
import type { ToolInvocationContext } from "../../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	formName,
	linkAddressSchema,
	linkByUuid,
	linkLabel,
	linkOrder,
	linkRefusalMessage,
	linkSubject,
	resolveLinkAddress,
	sentence,
} from "./shared";

export const moveFormLinkInputSchema = linkAddressSchema.extend({
	linkUuid: uuidSchema.describe("Stable UUID of the link to move."),
	afterLinkUuid: uuidSchema
		.nullable()
		.describe(
			"UUID of the link this one should follow, or null to check it first.",
		),
});

export type MoveFormLinkInput = z.infer<typeof moveFormLinkInputSchema>;

export interface MoveFormLinkSuccess extends MutationSuccess {
	readonly afterLinkUuid: Uuid | null;
	/** Every link on the form after the commit, in the order it is checked. */
	readonly linkOrder: readonly Uuid[];
}

export type MoveFormLinkResult =
	| MoveFormLinkSuccess
	| { readonly error: string };

export const moveFormLinkTool = {
	description:
		"Move one after-submit link after another link identified by UUID, or to the front with null. Links are checked in order and the first true condition wins, so order is meaning. Refuses an order that puts a conditional link after the otherwise link, or the otherwise link anywhere but last, and names the links involved.",
	inputSchema: moveFormLinkInputSchema,
	async execute(
		input: MoveFormLinkInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MoveFormLinkResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const address = resolveLinkAddress(doc, input);
			if (!address.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: address.error },
				};
			}
			const name = formName(doc, address.formUuid);
			const link = linkByUuid(doc, address.formUuid, asUuid(input.linkUuid));
			if (link === undefined) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: linkRefusalMessage(
							{ kind: "link-not-found", uuid: asUuid(input.linkUuid) },
							doc,
							address.formUuid,
						),
					},
				};
			}
			const label = linkLabel(doc, address.formUuid, link.uuid);
			const afterLinkUuid =
				input.afterLinkUuid === null ? null : asUuid(input.afterLinkUuid);
			if (afterLinkUuid === link.uuid) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: `${sentence(label)} cannot follow itself. Name another link in afterLinkUuid, or null to check it first.`,
					},
				};
			}
			if (
				afterLinkUuid !== null &&
				linkByUuid(doc, address.formUuid, afterLinkUuid) === undefined
			) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: `afterLinkUuid "${afterLinkUuid}" is not a link on form "${name}". Read get_form for the form's current links and their linkUuid values.`,
					},
				};
			}

			// The planner takes the landing index; the anchor is the link it
			// then follows, which is how the reducer stores the move.
			const others = linkOrder(doc, address.formUuid).filter(
				(uuid) => uuid !== link.uuid,
			);
			const landing =
				afterLinkUuid === null ? 0 : others.indexOf(afterLinkUuid) + 1;
			const plan = planFormLinkMove(doc, address.formUuid, link.uuid, landing);
			if (!plan.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: `${sentence(label)} on form "${name}" was not moved: ${linkRefusalMessage(plan.reason, doc, address.formUuid)}`,
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
			const committedOrder = linkOrder(commit.newDoc, address.formUuid);
			const committedIndex = committedOrder.indexOf(link.uuid);
			if (committedIndex < 0) {
				throw new BlueprintCommitRejectedError(
					`${sentence(label)} on form "${name}" changed while it was moving. Read get_form and try again.`,
				);
			}
			const committedAfter =
				committedIndex > 0
					? (committedOrder[committedIndex - 1] ?? null)
					: null;
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					message:
						mutations.length === 0
							? `${sentence(label)} on form "${name}" is already in that position.`
							: committedAfter === null
								? `Moved ${linkLabel(commit.newDoc, address.formUuid, link.uuid)} to the front of form "${name}"; it is checked first.`
								: `Moved ${linkLabel(commit.newDoc, address.formUuid, link.uuid)} after ${linkLabel(commit.newDoc, address.formUuid, committedAfter)} on form "${name}".`,
					afterLinkUuid: committedAfter,
					linkOrder: committedOrder,
					summary: {
						location: name,
						subject: linkSubject(commit.newDoc, address.formUuid, link.uuid),
					},
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
