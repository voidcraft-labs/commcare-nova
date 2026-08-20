import { z } from "zod";
import { afterSubmitPlan, planFormLinkAdd } from "@/lib/doc/formLinkMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	findAuthoredBlueprintIdentity,
	type PostSubmitDestination,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import type { ToolInvocationContext } from "../../workspace/types";
import {
	applyToDoc,
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
	linkOrder,
	linkRefusalMessage,
	resolveFormLinkInput,
	resolveLinkAddress,
} from "./shared";

export const addFormLinksInputSchema = linkAddressSchema.extend({
	links: z
		.array(
			z
				.object({
					linkUuid: uuidSchema
						.optional()
						.describe(
							"Stable UUID for the new link. Supply it only when you need to address the link before reading it back; otherwise Nova mints it.",
						),
					link: formLinkInputSchema.describe("The complete link."),
				})
				.strict(),
		)
		.min(1)
		.superRefine((links, ctx) => {
			const seen = new Set<string>();
			for (const [index, item] of links.entries()) {
				if (item.linkUuid === undefined) continue;
				if (seen.has(item.linkUuid)) {
					ctx.addIssue({
						code: "custom",
						path: [index, "linkUuid"],
						message: `"${item.linkUuid}" is repeated in this batch.`,
					});
				}
				seen.add(item.linkUuid);
			}
		})
		.describe(
			"Links in the order they are checked. Conditional links first; at most one unconditional otherwise link, and only last.",
		),
	afterLinkUuid: uuidSchema
		.nullable()
		.optional()
		.describe(
			"UUID of the existing link the new block should follow, null to put it first, or omit to let Nova place it: conditional links land just above the otherwise link when there is one, otherwise at the end.",
		),
});

export type AddFormLinksInput = z.infer<typeof addFormLinksInputSchema>;

export interface AddFormLinksSuccess extends MutationSuccess {
	readonly linkUuids: readonly Uuid[];
	/** Every link on the form after the commit, in the order it is checked. */
	readonly linkOrder: readonly Uuid[];
	/** Set when the batch also stored `post_submit` explicitly. */
	readonly pinnedPostSubmit?: PostSubmitDestination;
}

export type AddFormLinksResult =
	| AddFormLinksSuccess
	| { readonly error: string };

const isFallbackPin = (mutation: Mutation, formUuid: Uuid): boolean =>
	mutation.kind === "updateForm" &&
	mutation.uuid === formUuid &&
	"postSubmit" in mutation.patch;

export const addFormLinksTool = {
	description:
		"Add one or more after-submit links to a form. After the form is submitted its links are checked in order and the first true condition is followed; an unconditional link is the otherwise and can only be last. With conditional links and no otherwise link, the form's post_submit is where people go when nothing matches, and Nova stores it explicitly if it was not set. Conditions and datums run after the form has closed: they read case-ref, #user, and session values, never form answers, so save an answer to a case property first. When a link names datums it must name every selection datum the target needs.",
	inputSchema: addFormLinksInputSchema,
	async execute(
		input: AddFormLinksInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<AddFormLinksResult>> {
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

			const linkUuids = input.links.map((item) =>
				asUuid(item.linkUuid ?? crypto.randomUUID()),
			);
			const takenUuid = linkUuids.find(
				(uuid, index) =>
					findAuthoredBlueprintIdentity(doc, uuid) !== undefined ||
					linkUuids.indexOf(uuid) !== index,
			);
			if (takenUuid !== undefined) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: `Link UUID "${takenUuid}" is already in use in this app. Supply a different UUID, or leave linkUuid out and Nova mints one.`,
					},
				};
			}

			const initialAfter =
				input.afterLinkUuid === undefined || input.afterLinkUuid === null
					? input.afterLinkUuid
					: asUuid(input.afterLinkUuid);
			if (
				initialAfter !== undefined &&
				initialAfter !== null &&
				linkByUuid(doc, address.formUuid, initialAfter) === undefined
			) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: `afterLinkUuid "${initialAfter}" is not a link on form "${name}". Read get_form for the form's current links, or omit afterLinkUuid to let Nova place the new links.`,
					},
				};
			}

			let working = doc;
			const mutations: Mutation[] = [];
			let after: Uuid | null | undefined = initialAfter;
			let pinned: PostSubmitDestination | undefined;
			for (const [offset, item] of input.links.entries()) {
				const linkUuid = linkUuids[offset];
				if (linkUuid === undefined) {
					throw new Error("Form-link UUID allocation drifted from input.");
				}
				const link = resolveFormLinkInput(item.link, linkUuid);
				const plan = planFormLinkAdd(working, address.formUuid, link, after);
				if (!plan.ok) {
					return {
						kind: "mutate",
						mutations: [],
						result: {
							error: `Link ${offset + 1} of ${input.links.length} was not added to form "${name}": ${linkRefusalMessage(plan.reason, working, address.formUuid)}`,
						},
					};
				}
				mutations.push(...plan.mutations);
				working = applyToDoc(working, plan.mutations);
				pinned = plan.pinsFallback ?? pinned;
				after = link.uuid;
			}

			// A pin written for an earlier link of this batch is withdrawn when a
			// later link of the same batch is the otherwise link: the batch is
			// judged as one shape, and that shape names its own fallback.
			if (
				pinned !== undefined &&
				afterSubmitPlan(working, address.formUuid)?.elseLink !== undefined
			) {
				const kept = mutations.filter(
					(mutation) => !isFallbackPin(mutation, address.formUuid),
				);
				mutations.splice(0, mutations.length, ...kept);
				pinned = undefined;
			}

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
			const count = linkUuids.length;
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					message: `Added ${count} after-submit ${count === 1 ? "link" : "links"} to form "${name}".${pinned === undefined ? "" : ` ${fallbackPinSentence(pinned)}`}`,
					linkUuids,
					linkOrder: linkOrder(commit.newDoc, address.formUuid),
					...(pinned !== undefined && { pinnedPostSubmit: pinned }),
					summary: { location: name, count },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
