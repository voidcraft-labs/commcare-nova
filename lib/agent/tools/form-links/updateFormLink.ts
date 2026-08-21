import type { z } from "zod";
import { planFormLinkUpdate } from "@/lib/doc/formLinkMutations";
import {
	asUuid,
	type PostSubmitDestination,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import type { ToolInvocationContext } from "../../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	fallbackPinSentence,
	formLinkInputSchema,
	formName,
	linkAddressSchema,
	linkByUuid,
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
	/** Set when the change also stored `post_submit` explicitly. */
	readonly pinnedPostSubmit?: PostSubmitDestination;
}

export type UpdateFormLinkResult =
	| UpdateFormLinkSuccess
	| { readonly error: string };

export const updateFormLinkTool = {
	description:
		"Update one after-submit link by its linkUuid. Supply the link's complete desired shape; only the slots that changed are written. Removing the condition makes it the otherwise link, which must already be last; adding a condition to the otherwise link leaves the form's post_submit as the fallback, stored explicitly if it was not set.",
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
			const pinned = plan.pinsFallback;
			const dropped = plan.droppedDatums ?? [];
			const droppedSentence =
				dropped.length === 0
					? ""
					: ` The carried ${dropped.length === 1 ? "value" : "values"} the new destination never reads ${dropped.length === 1 ? "was" : "were"} removed: ${dropped.map((datum) => `"${datum}"`).join(", ")}.`;
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					message:
						mutations.length === 0
							? `${sentence(label)} on form "${name}" was already up to date.`
							: `Updated ${label} on form "${name}".${pinned === undefined ? "" : ` ${fallbackPinSentence(pinned)}`}${droppedSentence}`,
					linkUuid: existing.uuid,
					...(pinned !== undefined && { pinnedPostSubmit: pinned }),
					...(dropped.length > 0 && { droppedDatums: dropped }),
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
