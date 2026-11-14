/**
 * Shared UUID-addressed vocabulary for the after-submit link tools.
 *
 * A destination is addressed by `moduleUuid` + `formUuid` + `linkUuid`,
 * never by position or by what it points at; the form's otherwise link by
 * its form. The planners in `lib/doc/formLinkMutations.ts` decide what a
 * change becomes; this module owns the author-facing input shape, the one
 * place a planner's refusal turns into a sentence that names the links
 * involved, and the sentences a commit's reports append to the result.
 */

import { z } from "zod";
import type {
	FormLinkCommitPlan,
	FormLinkRefusal,
} from "@/lib/doc/formLinkMutations";
import {
	type BlueprintDoc,
	type FormLink,
	formLinkDatumNameSchema,
	formLinkDestination,
	formLinkEntries,
	formLinkSchema,
	formLinkTargetSchema,
	formLogicSchema,
	moduleUuidOfForm,
	otherwiseDestinationsOffered,
	type PostSubmitNotOfferedReason,
	type Uuid,
	uniqueFormLinkDatumNames,
} from "@/lib/domain";

/**
 * What each platform does when a link's target is hidden from the worker who
 * submits, by a display condition false for that worker. The link tools end
 * their descriptions with it, since a tool description stands under no one
 * target as the builder's link editor line does.
 */
export const HIDDEN_TARGET_NOTE =
	"When a target form's display condition is false for a worker, Android still opens it after submit, and Web Apps opens the module that holds it instead. When a target module's display condition is false for a worker, Android opens it with nothing in it, and Web Apps opens the app's first screen instead.";

export {
	formAddressSchema as linkAddressSchema,
	resolveFormAddress as resolveLinkAddress,
} from "../shared/entityAddresses";

/** One carried session value, as a destination and the otherwise link take
 *  it. */
export const formLinkDatumInputSchema = z.strictObject({
	name: formLinkDatumNameSchema.describe(
		"The session value the target reads, usually its case id datum such as case_id.",
	),
	xpath: formLogicSchema.describe(
		"Session-scope XPath that supplies the value after the form has closed, such as a case-ref or #user value. Never a form answer.",
	),
});

/** The target a destination and the otherwise link take. */
export const formLinkTargetInputSchema = formLinkTargetSchema.describe(
	'{"type":"form","moduleUuid","formUuid"} opens that form; {"type":"module","moduleUuid"} opens that module\'s list; {"type":"this-form"} starts this form again. A submenu is a target only from a submenu whose parent has the same case type as its parent.',
);

/**
 * The complete author shape of one destination. The stored link adds
 * `uuid`; the tool that admits this input mints or receives it separately.
 */
export const formLinkInputSchema = z
	.strictObject({
		condition: formLogicSchema
			.nullable()
			.optional()
			.describe(
				"Session-scope XPath; when it holds, this destination runs. Null or omitted runs it every time. It runs after the form has closed, so it reads case-ref, #user and session values, never form answers: save the answer to a case property first.",
			),
		target: formLinkTargetInputSchema,
		datums: z
			.array(formLinkDatumInputSchema)
			.min(1)
			.nullable()
			.optional()
			.describe(
				"Explicit session values carried into the target. Only for a form or this-form. Omit or null to let CommCare match the target's case from this form's session. When present, name every selection datum the target needs; a partial list is refused. The destination runs only when the worker's device holds a case of its type with each carried id.",
			),
	})
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

/** The form's destinations, in the order they run. */
export function linkOrder(doc: BlueprintDoc, formUuid: Uuid): readonly Uuid[] {
	return (doc.forms[formUuid]?.formLinks ?? []).map((link) => link.uuid);
}

export function formName(doc: BlueprintDoc, formUuid: Uuid): string {
	return doc.forms[formUuid]?.name ?? formUuid;
}

/** Where one of the form's links goes, read for a person, or `undefined`
 *  when its target no longer exists. */
function linkWhere(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
):
	| {
			readonly role: "destination" | "otherwise";
			readonly index: number;
			readonly where: string | undefined;
			readonly name: string | undefined;
	  }
	| undefined {
	const form = doc.forms[formUuid];
	if (form === undefined) return undefined;
	const entry = formLinkEntries(form).find(
		(candidate) => candidate.link.uuid === uuid,
	);
	if (entry === undefined) return undefined;
	const destination = formLinkDestination(doc, formUuid, entry.link.target);
	return {
		role: entry.role,
		index: entry.role === "destination" ? entry.index : -1,
		where:
			destination === undefined
				? undefined
				: destination.kind === "this-form"
					? "this form again"
					: `${destination.kind} "${destination.name}"`,
		name:
			destination === undefined
				? undefined
				: destination.kind === "this-form"
					? "this form again"
					: destination.name,
	};
}

/**
 * A link named for a person and for the agent at once: its position (or
 * that it is the otherwise link), its UUID (the handle the next call
 * needs), and where it goes.
 */
export function linkLabel(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
): string {
	const read = linkWhere(doc, formUuid, uuid);
	if (read === undefined) return `link ${uuid}`;
	const where = read.where ?? "a destination that no longer exists";
	return read.role === "otherwise"
		? `the otherwise link (${uuid}, to ${where})`
		: `link ${read.index + 1} (${uuid}, to ${where})`;
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
	const read = linkWhere(doc, formUuid, uuid);
	if (read === undefined) return "link";
	const named =
		read.role === "otherwise" ? "otherwise" : `link ${read.index + 1}`;
	return read.name === undefined ? named : `${named} to ${read.name}`;
}

/** A link label opening a sentence. */
export function sentence(label: string): string {
	return label.charAt(0).toUpperCase() + label.slice(1);
}

function moduleName(doc: BlueprintDoc, moduleUuid: Uuid | undefined): string {
	return moduleUuid === undefined
		? ""
		: (doc.modules[moduleUuid]?.name ?? moduleUuid);
}

/** Why the form's module withholds a built-in destination, as a clause. */
function notOfferedClause(
	doc: BlueprintDoc,
	formUuid: Uuid,
	reason: PostSubmitNotOfferedReason,
): string {
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const own = `"${moduleName(doc, moduleUuid)}"`;
	const parentUuid =
		moduleUuid === undefined
			? undefined
			: doc.modules[moduleUuid]?.parentModuleUuid;
	const parent = `"${moduleName(doc, parentUuid)}"`;
	switch (reason) {
		case "menu-selects-several":
			return `${own} selects several cases, so there is no previous screen to return to`;
		case "parent-selects-several":
			return `${own} sits under ${parent}, which selects several cases`;
		case "menu-forms-read-search":
			return `${own} has its forms read the search, so CommCare can't go back to the previous screen`;
		case "menu-is-bare-case-list":
			return `${own} is a case list with no forms, so there is no form list to land on`;
		case "no-parent-menu":
			return `${own} has no parent module`;
		case "menu-off-the-menu":
			return `${own} is off the menu`;
		case "parent-off-the-menu":
			return `${parent} is off the menu`;
		case "menu-forms-in-menu-above":
			return `${own} shows its forms in the menu above, so it has no screen of its own`;
		case "parent-forms-in-menu-above":
			return `${parent} shows its forms in the menu above, so it has no screen of its own`;
		case "menu-forms-on-first-menu":
			return `${own} shows its forms on the app's first menu, where the previous screen isn't offered`;
	}
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
			return `No destination with UUID "${reason.uuid}" is on form "${name}". Read get_form for the form's current destinations and their linkUuid values.`;
		case "duplicate-uuid":
			return `Link UUID "${reason.uuid}" is already in use in this app. Supply a different UUID, or leave linkUuid out and Nova mints one.`;
		case "target-not-found":
			return `The link's target is not in this app. A form target names the module the form belongs to and the form's own UUID; a module target names an existing module. Read get_app or get_module for current UUIDs.`;
		case "self-target":
			return `To open form "${name}" again after it is submitted, use the target {"type":"this-form"} rather than naming the form.`;
		case "target-not-offered": {
			const menu = moduleName(doc, reason.menuUuid);
			const repair =
				reason.parentUuid === undefined
					? `Target a form inside "${menu}".`
					: `Target "${moduleName(doc, reason.parentUuid)}", which holds it, or a form inside "${menu}".`;
			return `CommCare HQ doesn't offer "${menu}" as a link target from form "${name}": a submenu is a target only from a submenu whose parent has the same case type as its own parent. ${repair}`;
		}
		case "menu-carries-values":
			return "A destination that opens a module carries no values, because a module's form list asks for none. Leave datums out, or target a form in that module.";
		case "first-menu-shared-case": {
			const above = moduleName(doc, reason.aboveModuleUuid);
			return `A link from form "${name}" to that target opens through the app's first menu, where every form listed from a menu that shows its forms above opens one chosen case. CommCare HQ puts that case ahead of the target in the link, and on Android CommCare keeps it on the first menu when a worker steps back, for the next form to open on. You can give "${above}" its own screen again (forms_in_menu_above null on update_module), or choose another target.`;
		}
		case "selection-cardinality":
			return `Form "${name}" cannot hand its complete case selection directly to that form. Link to the destination module so the person can choose again, or configure both modules with the same selection mode and a destination limit that accepts the complete source selection.`;
		case "otherwise-unreachable":
			return `Form "${name}" has no destination with a condition or a carried case, so an otherwise would never run. Give a destination a condition before setting an otherwise.`;
		case "otherwise-not-offered": {
			const offered = otherwiseDestinationsOffered(doc, formUuid)
				.map((destination) => `"${destination}"`)
				.join(", ");
			return `Form "${name}"'s module doesn't offer "${reason.destination}" when no destination runs: ${notOfferedClause(doc, formUuid, reason.reason)}. Choose one of: ${offered}, or set the otherwise to null so the app home follows.`;
		}
		case "otherwise-exists":
			return `Form "${name}" already has an otherwise. Change it with set_form_otherwise, or remove it first.`;
		case "no-otherwise-link":
			return `Form "${name}"'s otherwise isn't a link, so there's no destination to make from it. Add the destination with add_form_links.`;
		case "stale-base":
			return `A destination on form "${name}" changed while this edit was being prepared. Read get_form for its current shape and send the edit again.`;
	}
}

/** What a committed plan reports beyond the mutations it names. */
export type FormLinkCommitReports = Pick<
	Extract<FormLinkCommitPlan, { ok: true }>,
	| "movedToOtherwise"
	| "droppedPostSubmit"
	| "droppedOtherwise"
	| "otherwiseToPostSubmit"
	| "otherwiseToDestination"
>;

/** The reports a committed plan carries, each the sentence a tool's result
 *  appends to its message. */
export function linkCommitSentences(
	plan: FormLinkCommitReports,
): readonly string[] {
	return [
		...(plan.movedToOtherwise === undefined
			? []
			: [
					`Where the form went after submit, "${plan.movedToOtherwise}", is now its otherwise.`,
				]),
		...(plan.droppedPostSubmit === undefined
			? []
			: [
					`Its after-submit setting, "${plan.droppedPostSubmit}", was removed, because a destination now always runs.`,
				]),
		...(plan.droppedOtherwise === undefined
			? []
			: [
					"Its otherwise was removed, because every destination now runs each time.",
				]),
		...(plan.otherwiseToPostSubmit === undefined
			? []
			: [
					`Its otherwise, "${plan.otherwiseToPostSubmit}", is now where it goes after submit.`,
				]),
		...(plan.otherwiseToDestination === undefined
			? []
			: ["Its otherwise link is now its only destination."]),
	];
}

/** The result's `message` for the reports of one call: present only when a
 *  commit changed more than the call named. */
export function linkCommitMessage(
	sentences: readonly string[],
): { readonly message: string } | Record<string, never> {
	return sentences.length === 0 ? {} : { message: sentences.join(" ") };
}
