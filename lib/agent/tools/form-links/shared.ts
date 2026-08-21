/**
 * Shared UUID-addressed vocabulary for the after-submit link tools.
 *
 * A link is addressed by `moduleUuid` + `formUuid` + `linkUuid`, never by
 * position or by what it points at. The planners in
 * `lib/doc/formLinkMutations.ts` decide what a change becomes; this module
 * owns the author-facing input shape and the one place a planner's refusal
 * turns into a sentence that names the links involved.
 */

import { z } from "zod";
import type { FormLinkRefusal } from "@/lib/doc/formLinkMutations";
import {
	type BlueprintDoc,
	type FormLink,
	formLinkDestination,
	formLinkSchema,
	formLinkTargetSchema,
	type PostSubmitDestination,
	type Uuid,
	uniqueFormLinkDatumNames,
	xpathExpressionSchema,
} from "@/lib/domain";

export {
	formAddressSchema as linkAddressSchema,
	resolveFormAddress as resolveLinkAddress,
} from "../shared/entityAddresses";

const datumInputSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.describe(
				"The session value the target reads, usually its case id datum such as case_id.",
			),
		xpath: xpathExpressionSchema.describe(
			"Session-scope XPath that supplies the value after the form has closed, such as a case-ref or #user value. Never a form answer.",
		),
	})
	.strict();

/**
 * The complete author shape of one link. The stored link adds `uuid`; the
 * tool that admits this input mints or receives it separately.
 */
export const formLinkInputSchema = z
	.object({
		condition: xpathExpressionSchema
			.nullable()
			.optional()
			.describe(
				"Session-scope XPath that must be true for this link to be followed; null or omitted makes it the unconditional otherwise link, which must be last. It runs after the form has closed, so it reads case-ref, #user, and session values, never form answers: save the answer to a case property first.",
			),
		target: formLinkTargetSchema.describe(
			'Where the link goes: {"type":"form","moduleUuid","formUuid"} opens that form; {"type":"module","moduleUuid"} opens that module\'s list. Never this form itself, and never a chain that leads back here.',
		),
		datums: z
			.array(datumInputSchema)
			.min(1)
			.nullable()
			.optional()
			.describe(
				"Explicit session values carried into the target. Omit or null to let CommCare match the target's case from this form's session. When present, name every selection datum the target needs; a partial list is refused.",
			),
	})
	.strict()
	.superRefine((link, ctx) => uniqueFormLinkDatumNames(link.datums, ctx));

export type FormLinkInput = z.infer<typeof formLinkInputSchema>;

/** The stored link for an admitted input: absent slots stay absent. */
export function resolveFormLinkInput(
	input: FormLinkInput,
	uuid: Uuid,
): FormLink {
	return formLinkSchema.parse({
		uuid,
		...(input.condition !== undefined &&
			input.condition !== null && { condition: input.condition }),
		target: input.target,
		...(input.datums !== undefined &&
			input.datums !== null && { datums: input.datums }),
	});
}

export function linkByUuid(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
): FormLink | undefined {
	return (doc.forms[formUuid]?.formLinks ?? []).find(
		(link) => link.uuid === uuid,
	);
}

export function linkOrder(doc: BlueprintDoc, formUuid: Uuid): readonly Uuid[] {
	return (doc.forms[formUuid]?.formLinks ?? []).map((link) => link.uuid);
}

export function formName(doc: BlueprintDoc, formUuid: Uuid): string {
	return doc.forms[formUuid]?.name ?? formUuid;
}

/**
 * A link named for a person and for the agent at once: its position, its
 * UUID (the handle the next call needs), and where it goes.
 */
export function linkLabel(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
): string {
	const links = doc.forms[formUuid]?.formLinks ?? [];
	const index = links.findIndex((link) => link.uuid === uuid);
	const link = links[index];
	if (link === undefined) return `link ${uuid}`;
	const destination = formLinkDestination(doc, link.target);
	const where =
		destination === undefined
			? "a destination that no longer exists"
			: `${destination.kind} "${destination.name}"`;
	return `link ${index + 1} (${uuid}, to ${where})`;
}

/**
 * A link named for a person reading the chat: its position and where it
 * goes, no uuid. The tool summary's subject; `linkLabel` stays the message
 * form, where the uuid is the handle the model edits by.
 */
export function linkSubject(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
): string {
	const links = doc.forms[formUuid]?.formLinks ?? [];
	const index = links.findIndex((link) => link.uuid === uuid);
	const link = links[index];
	if (link === undefined) return "link";
	const destination = formLinkDestination(doc, link.target);
	return destination === undefined
		? `link ${index + 1}`
		: `link ${index + 1} to ${destination.name}`;
}

/** A link label opening a sentence. */
export function sentence(label: string): string {
	return label.charAt(0).toUpperCase() + label.slice(1);
}

function listLinks(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuids: readonly Uuid[],
): string {
	return uuids.map((uuid) => linkLabel(doc, formUuid, uuid)).join(", ");
}

const DESTINATION_WORDS: Record<PostSubmitDestination, string> = {
	app_home: "app home",
	module: "the module's list",
	previous: "the previous screen",
};

/**
 * The sentence a success message carries when the batch also stored the
 * form's `post_submit` explicitly, so the person knows the form now says
 * where people go when no condition matches, and which tool changes it.
 */
export function fallbackPinSentence(
	destination: PostSubmitDestination,
): string {
	return `Every link on the form has a condition, so the form now sets post_submit explicitly to "${destination}" (${DESTINATION_WORDS[destination]}): that is where people go when no condition matches. Change it with update_form.`;
}

/**
 * Why a planner refused, as one person would tell another: what was tried,
 * what stands in the way (by link), and what to do next.
 */
export function linkRefusalMessage(
	reason: FormLinkRefusal,
	doc: BlueprintDoc,
	formUuid: Uuid,
): string {
	const name = formName(doc, formUuid);
	switch (reason.kind) {
		case "form-not-found":
			return `Form "${name}" is no longer part of this app. Read get_module or search_blueprint for current form UUIDs.`;
		case "link-not-found":
			return `No link with UUID "${reason.uuid}" is on form "${name}". Read get_form for the form's current links and their linkUuid values.`;
		case "duplicate-uuid":
			return `Link UUID "${reason.uuid}" is already a link on form "${name}". Supply a different UUID, or leave linkUuid out and Nova mints one.`;
		case "target-not-found":
			return `The link's target is not in this app. A form target names the module the form belongs to and the form's own UUID; a module target names an existing module. Read get_app or get_module for current UUIDs.`;
		case "self-target":
			return `A link cannot point back at the form it leaves, "${name}". Choose another form or a module.`;
		case "cycle": {
			const chain = reason.chain
				.map((uuid) => `"${formName(doc, uuid)}"`)
				.join(" to ");
			return `That target would send people around in a loop: ${chain}. Links are followed automatically after submit, so the loop would never end. Choose a target whose links do not lead back to "${name}".`;
		}
		case "else-exists":
			return `Form "${name}" already has an otherwise link, ${linkLabel(doc, formUuid, reason.elseUuid)}, and a form can have only one unconditional link. Change that link with update_form_link, or give the new link a condition.`;
		case "after-else":
			return `A conditional link cannot come after the otherwise link, ${linkLabel(doc, formUuid, reason.elseUuid)}. The otherwise link runs when nothing above it matched, so a link below it would never be reached. Place the link above it: set afterLinkUuid to the link before the otherwise link, or null to make it first.`;
		case "else-not-last":
			return `An unconditional link is the otherwise link and must be last, but ${reason.blockingUuids.length === 1 ? "one link" : `${reason.blockingUuids.length} links`} would come after it: ${listLinks(doc, formUuid, reason.blockingUuids)}. Put it after the last link, or give it a condition.`;
		case "stale-base":
			return `A link on form "${name}" changed while this edit was being prepared. Read get_form for its current shape and send the edit again.`;
	}
}
