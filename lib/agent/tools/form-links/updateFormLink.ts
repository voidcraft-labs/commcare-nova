import type { z } from "zod";
import { planFormLinkUpdate } from "@/lib/doc/formLinkMutations";
import { asUuid, type Uuid, uuidSchema } from "@/lib/domain";
import type { ToolInvocationContext } from "../../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	formLinkInputSchema,
	formName,
	HIDDEN_TARGET_NOTE,
	linkAddressSchema,
	linkByUuid,
	linkCommitMessage,
	linkCommitSentences,
	linkLabel,
	linkRefusalMessage,
	linkSubject,
	resolveFormLinkInput,
	resolveLinkAddress,
	sentence,
} from "./shared";

export const updateFormLinkInputSchema = linkAddressSchema.extend({
	linkUuid: uuidSchema.describe("Stable UUID of the link to update."),
	link: formLinkInputSchema.describe(
		"The link's complete desired shape. An omitted condition or datums slot clears it; unchanged slots emit no mutation.",
	),
});

export type UpdateFormLinkInput = z.infer<typeof updateFormLinkInputSchema>;

export interface UpdateFormLinkSuccess extends MutationSuccess {
	readonly linkUuid: Uuid;
	/** Carried values the new target does not read, which the edit dropped. */
	readonly droppedDatums?: readonly string[];
	/** What the commit changed beyond the destination it names: the
	 *  otherwise removed when no destination may not run any more. */
	readonly message?: string;
}

export type UpdateFormLinkResult =
	| UpdateFormLinkSuccess
	| { readonly error: string };

export const updateFormLinkTool = {
	description: `Replace one after-submit destination, keeping its place in the order. ${HIDDEN_TARGET_NOTE}`,
	inputSchema: updateFormLinkInputSchema,
	async execute(
		input: UpdateFormLinkInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<UpdateFormLinkResult>> {
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
			const existing = linkByUuid(
				doc,
				address.formUuid,
				asUuid(input.linkUuid),
			);
			if (existing === undefined) {
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
			const label = linkLabel(doc, address.formUuid, existing.uuid);
			const next = resolveFormLinkInput(input.link, existing.uuid);
			const plan = planFormLinkUpdate(doc, address.formUuid, next, existing);
			if (!plan.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: `${sentence(label)} on form "${name}" was not updated: ${linkRefusalMessage(plan.reason, doc, address.formUuid)}`,
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
			const dropped = plan.droppedDatums ?? [];
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					ok: true,
					linkUuid: existing.uuid,
					...(dropped.length > 0 && { droppedDatums: dropped }),
					...linkCommitMessage(linkCommitSentences(plan)),
					summary: {
						location: name,
						subject: linkSubject(
							commit.newDoc,
							address.formUuid,
							existing.uuid,
						),
					},
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
