import { z } from "zod";
import {
	afterSubmitPlan,
	planFormLinkAdd,
	planSetOtherwise,
} from "@/lib/doc/formLinkMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	findAuthoredBlueprintIdentity,
	OTHERWISE_DESTINATIONS,
	type OtherwiseDestination,
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
	type FormLinkCommitReports,
	formLinkInputSchema,
	formName,
	HIDDEN_TARGET_NOTE,
	linkAddressSchema,
	linkByUuid,
	linkCommitMessage,
	linkCommitSentences,
	linkOrder,
	linkRefusalMessage,
	resolveFormLinkInput,
	resolveLinkAddress,
} from "./shared";

export const addFormLinksInputSchema = linkAddressSchema.extend({
	links: z
		.array(
			z.strictObject({
				linkUuid: uuidSchema
					.optional()
					.describe(
						"Stable UUID for the new link. Supply it only when you need to address the link before reading it back; otherwise Nova mints it.",
					),
				link: formLinkInputSchema.describe("The complete link."),
			}),
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
		.describe("Destinations in the order they run."),
	afterLinkUuid: uuidSchema
		.nullable()
		.optional()
		.describe(
			"UUID of the existing destination the new ones should follow, null to put them first, or omit to add them at the end.",
		),
});

export type AddFormLinksInput = z.infer<typeof addFormLinksInputSchema>;

export interface AddFormLinksSuccess extends MutationSuccess {
	readonly linkUuids: readonly Uuid[];
	/** Every destination on the form after the commit, in the order they run. */
	readonly linkOrder: readonly Uuid[];
	/** What the commit changed beyond the destinations it names: the form's
	 *  after-submit becoming its otherwise, or a setting removed. */
	readonly message?: string;
}

export type AddFormLinksResult =
	| AddFormLinksSuccess
	| { readonly error: string };

const isOtherwiseDestination = (
	destination: string,
): destination is OtherwiseDestination =>
	(OTHERWISE_DESTINATIONS as readonly string[]).includes(destination);

export const addFormLinksTool = {
	description: `Add after-submit destinations. Every destination whose condition holds runs, in the order you set: the first opens after the form, and each next one when the worker finishes the one before. In Web Apps only the first that holds opens. Conditions read saved records and worker values after the form closes, so they cannot use unsaved answers. Set where the worker goes when no destination with a condition or a carried case runs with setFormOtherwise/set_form_otherwise. ${HIDDEN_TARGET_NOTE}`,
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
						error: `afterLinkUuid "${initialAfter}" is not a destination on form "${name}". Read get_form for the form's current destinations, or omit afterLinkUuid to add the new ones at the end.`,
					},
				};
			}

			/* The form's after-submit before the batch, when it has no
			 * destinations yet: a batch is judged as one shape, so where the
			 * worker went keeps its place as the otherwise when the finished
			 * batch has a destination that may not run. */
			const before = afterSubmitPlan(doc, address.formUuid)?.postSubmit;
			let working = doc;
			const mutations: Mutation[] = [];
			let reports: FormLinkCommitReports = {};
			let after: Uuid | null | undefined = initialAfter;
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
							error: `Destination ${offset + 1} of ${input.links.length} was not added to form "${name}": ${linkRefusalMessage(plan.reason, working, address.formUuid)}`,
						},
					};
				}
				mutations.push(...plan.mutations);
				reports = {
					...reports,
					...(plan.movedToOtherwise !== undefined && {
						movedToOtherwise: plan.movedToOtherwise,
					}),
					...(plan.droppedPostSubmit !== undefined && {
						droppedPostSubmit: plan.droppedPostSubmit,
					}),
				};
				working = applyToDoc(working, plan.mutations);
				// Each later destination follows the one before it; an omitted
				// anchor keeps adding at the end.
				if (after !== undefined) after = link.uuid;
			}

			/* A first destination that runs every time leaves no otherwise; a
			 * later one in the same batch that may not run makes the form's
			 * old after-submit reachable again, so it becomes the otherwise. */
			const finished = afterSubmitPlan(working, address.formUuid);
			if (
				before !== undefined &&
				finished !== undefined &&
				finished.otherwise === undefined &&
				finished.otherwiseOffered &&
				isOtherwiseDestination(before.destination)
			) {
				const moved = planSetOtherwise(working, address.formUuid, {
					kind: "destination",
					destination: before.destination,
				});
				if (moved.ok && moved.mutations.length > 0) {
					mutations.push(...moved.mutations);
					const { droppedPostSubmit: _moved, ...kept } = reports;
					reports = { ...kept, movedToOtherwise: before.destination };
				}
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
					ok: true,
					linkUuids,
					linkOrder: linkOrder(commit.newDoc, address.formUuid),
					...linkCommitMessage(linkCommitSentences(reports)),
					summary: { location: name, count },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
