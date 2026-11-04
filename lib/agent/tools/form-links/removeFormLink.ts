import type { z } from "zod";
import { planFormLinkRemove } from "@/lib/doc/formLinkMutations";
import { asUuid, uuidSchema } from "@/lib/domain";
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
	linkCommitMessage,
	linkCommitSentences,
	linkLabel,
	linkRefusalMessage,
	linkSubject,
	resolveLinkAddress,
	sentence,
} from "./shared";

export const removeFormLinkInputSchema = linkAddressSchema.extend({
	linkUuid: uuidSchema.describe("Stable UUID of the link to remove."),
});

export type RemoveFormLinkInput = z.infer<typeof removeFormLinkInputSchema>;

export interface RemoveFormLinkSuccess extends MutationSuccess {
	/** What the commit changed beyond the destination it names: the
	 *  otherwise becoming the form's after-submit or its only destination,
	 *  or the otherwise removed. */
	readonly message?: string;
}

export type RemoveFormLinkResult =
	| RemoveFormLinkSuccess
	| { readonly error: string };

export const removeFormLinkTool = {
	description:
		"Remove an after-submit destination. Removing the last one makes the form's otherwise its after-submit destination; removing the last one with a condition or a carried case removes the otherwise.",
	inputSchema: removeFormLinkInputSchema,
	async execute(
		input: RemoveFormLinkInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<RemoveFormLinkResult>> {
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
			const plan = planFormLinkRemove(doc, address.formUuid, link.uuid);
			if (!plan.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: `${sentence(label)} on form "${name}" was not removed: ${linkRefusalMessage(plan.reason, doc, address.formUuid)}`,
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
					...linkCommitMessage(linkCommitSentences(plan)),
					summary: {
						location: name,
						subject: linkSubject(doc, address.formUuid, link.uuid),
					},
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
