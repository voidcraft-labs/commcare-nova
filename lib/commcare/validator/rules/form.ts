/**
 * Form-level validation rules.
 *
 * Each rule receives the normalized `BlueprintDoc`, the form entity, and its
 * `formUuid` (plus the owning module for rules that need sibling context).
 * A form writes case data only through its case operations, whose rules
 * live in `caseOperations.ts`; this file holds the form's own open and close
 * conditions beside the rest of the form's rules.
 */

import { MAX_FORM_ATTACHMENTS, MEDIA_FIELD_KINDS } from "@/lib/commcare";
import {
	connectIdError,
	connectIdProblem,
	freeConnectId,
} from "@/lib/commcare/connectSlugs";
import {
	type FormLinkProjectionContext,
	formLinkActionsBuildable,
	formLinkProjectionContext,
	formLinkTargetDatumIds,
	projectAfterSubmit,
} from "@/lib/commcare/formLinkProjection";
import { instanceScanRead } from "@/lib/commcare/hqInstanceScan";
import { identityLookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	CONNECT_SOURCE_TEXT_WORDS,
	formSourceTexts,
} from "@/lib/commcare/xform/sourceTexts";
import {
	afterEmptySearchRegistrationFormOf,
	appConnectIds,
	type BlueprintDoc,
	connectDeliverFormHoldsTask,
	type Field,
	type Form,
	type FormLinkEntry,
	fieldRegistry,
	formConnectIds,
	formLinkDestination,
	formLinkEntries,
	formOtherwiseReachable,
	formRootTakenIds,
	formTypeLabels,
	isConnectLearnConfig,
	type Module,
	menuTargetOffered,
	moduleShowsFormsInMenuAbove,
	otherwiseDestinationsOffered,
	POST_SUBMIT_DESTINATIONS,
	type PostSubmitDestination,
	type PostSubmitNotOfferedReason,
	postSubmitDestinationsOffered,
	postSubmitNotOfferedReason,
	projectProseTemplate,
	type ResolvedFormLinkTarget,
	resolveFormLinkTarget,
	type Uuid,
} from "@/lib/domain";
import { slotContext } from "@/lib/domain/expression/context";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import { datumRefKey } from "@/lib/domain/expression/types";
import { freeQuestionId } from "@/lib/domain/questionId";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
import { type ValidationError, validationError } from "../errors";
import {
	checkErrorDetails,
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../lookupTypeContext";
import { formLinkNeedsNewCaseDatum } from "./advancedModule";
import { validateCaseOperations } from "./caseOperations";
import { validateCaseOptionsSources } from "./caseOptionsSource";
import { validateCasePlacements } from "./casePlacement";
import { formDisplayCondition } from "./displayConditions";
import {
	linksSharingFirstMenuCase,
	menuAboveLinkTargets,
} from "./formsInMenuAbove";
import { hiddenMenuLinkTargets } from "./hiddenFromMenu";
import { validateLookupOptionsSources } from "./lookupOptionsSource";
import {
	formLinkSelectionCardinality,
	multiSelectFormSemantics,
} from "./multiSelect";
import { casePropertyNameFormBuilderCannotKeep } from "./sourceCaseWrites";

// ── Helpers ────────────────────────────────────────────────────────

interface FormContext {
	formUuid: Uuid;
	moduleUuid: Uuid;
	formName: string;
	moduleName: string;
}

function baseLocation(ctx: FormContext) {
	return {
		moduleUuid: ctx.moduleUuid,
		moduleName: ctx.moduleName,
		formUuid: ctx.formUuid,
		formName: ctx.formName,
	};
}

// ── Rules ──────────────────────────────────────────────────────────

function emptyForm(
	doc: BlueprintDoc,
	_form: Form,
	ctx: FormContext,
): ValidationError[] {
	const order = doc.fieldOrder[ctx.formUuid] ?? [];
	/* A form needs a field a person authored that is not a container: a
	 * question, a label or a hidden value, at any depth. HQ's build refuses
	 * a form whose questions are all groups as a blank form
	 * (`helpers/validators.py::FormBaseValidator.validate_for_build`), and
	 * Nova asks for an authored field rather than counting the leaves the
	 * emitter generates (a count node, a Save to Case leaf), so a form of
	 * empty containers and case changes is refused too. */
	const holdsQuestion = (parentUuid: Uuid): boolean =>
		(doc.fieldOrder[parentUuid] ?? []).some((uuid) => {
			const field = doc.fields[uuid];
			if (field === undefined) return false;
			if (!CONTAINER_KINDS.has(field.kind)) return true;
			return holdsQuestion(uuid);
		});
	if (holdsQuestion(ctx.formUuid)) return [];
	const onlyEmptySections =
		order.length > 0 &&
		order.every((uuid) => {
			const field = doc.fields[uuid];
			return (
				field?.kind === "section" && (doc.fieldOrder[uuid]?.length ?? 0) === 0
			);
		});
	const problem =
		order.length === 0
			? "no_fields"
			: onlyEmptySections
				? "empty_sections"
				: "no_question";
	const message =
		problem === "no_fields"
			? `"${ctx.formName}" in "${ctx.moduleName}" has no fields. CommCare can't build an empty form. Add at least one field.`
			: problem === "empty_sections"
				? `"${ctx.formName}" in "${ctx.moduleName}" has sections, but nothing on any of them. CommCare can't build an empty form. Add a question to one of its sections.`
				: `"${ctx.formName}" in "${ctx.moduleName}" has sections or groups and no question in them yet. CommCare can't build a form with no question. Add a question, a label or a hidden value.`;
	return [
		validationError("EMPTY_FORM", "form", message, baseLocation(ctx), {
			problem,
		}),
	];
}

/** The field kinds that only hold other fields. */
const CONTAINER_KINDS: ReadonlySet<Field["kind"]> = new Set([
	"group",
	"repeat",
	"section",
]);

/**
 * A section or group named the way a person knows it: its label, else its
 * id.
 */
function containerTitle(doc: BlueprintDoc, container: Field): string {
	if (
		(container.kind !== "section" && container.kind !== "group") ||
		container.label === undefined
	) {
		return container.id;
	}
	const text = projectProseTemplate(container.label, doc).text.trim();
	return text.length > 0 ? text : container.id;
}

/**
 * Sections make "a sectioned form" a closed state, and one walk of the
 * form's tree checks all three halves of it.
 *
 * A section is one page of the form, so it sits at the form's top level
 * (`FORM_SECTION_NOT_TOP_LEVEL`): nested, it would be a field-list inside a
 * field-list, which the CommCare app flattens onto the outer screen. Once a
 * form has a section, every root field belongs inside one
 * (`FORM_SECTIONS_INCOMPLETE`): a root that mixes sections and loose fields
 * pages some questions and not others. And a repeat the worker grows by
 * hand cannot live under a section (`FORM_SECTION_USER_REPEAT`): a
 * field-list is one screen, and the app adds repeat entries only from a
 * screen of its own (`FormEntryController.getQuestionPrompts` skips
 * `EVENT_PROMPT_NEW_REPEAT` while collecting a field-list host), so the repeat would
 * be unreachable on device. Count-bound and query-bound repeats are fine.
 * A group holding `fieldList` is the same one screen, so a user-controlled
 * repeat at any depth under one is refused too (`FIELD_LIST_USER_REPEAT`).
 * The walk carries the nearest such group beside the nearest section, and
 * a repeat under both raises only the section's finding.
 *
 * An empty section is legal: the app skips a page with nothing to show, and
 * so does the preview.
 */
function formSections(doc: BlueprintDoc, ctx: FormContext): ValidationError[] {
	const errors: ValidationError[] = [];
	const sections: Field[] = [];
	const loose: Field[] = [];
	for (const uuid of doc.fieldOrder[ctx.formUuid] ?? []) {
		const field = doc.fields[uuid];
		if (!field) continue;
		(field.kind === "section" ? sections : loose).push(field);
	}
	if (sections.length > 0 && loose.length > 0) {
		const n = loose.length;
		const ids = loose.map((field) => `"${field.id}"`).join(", ");
		errors.push(
			validationError(
				"FORM_SECTIONS_INCOMPLETE",
				"form",
				`"${ctx.formName}" in "${ctx.moduleName}" is split into sections, but ${n} ${n === 1 ? "field sits" : "fields sit"} outside every section: ${ids}. Once a form has sections, every field belongs inside one. Add ${n === 1 ? "it" : "them"} to a section, or remove the sections to go back to a single page.`,
				baseLocation(ctx),
				{
					looseCount: String(n),
					looseFieldUuids: loose.map((field) => field.uuid).join(","),
					looseFieldIds: loose.map((field) => field.id).join(","),
				},
			),
		);
	}
	const walk = (
		parentUuid: Uuid,
		parent: Field | undefined,
		section: Field | undefined,
		fieldListGroup: Field | undefined,
	): void => {
		for (const uuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[uuid];
			if (!field) continue;
			if (field.kind === "section" && parent !== undefined) {
				const parentKind = fieldRegistry[parent.kind].label.toLowerCase();
				errors.push(
					validationError(
						"FORM_SECTION_NOT_TOP_LEVEL",
						"field",
						`"${ctx.formName}" has section "${field.id}" inside ${parentKind} "${parent.id}". A section is a page of the form, so it sits at the form's top level. Move it out of "${parent.id}".`,
						{ ...baseLocation(ctx), fieldUuid: field.uuid, fieldId: field.id },
						{ parentUuid: parent.uuid, parentId: parent.id, parentKind },
					),
				);
			}
			if (
				field.kind === "repeat" &&
				field.repeat_mode === "user_controlled" &&
				section !== undefined
			) {
				const title = containerTitle(doc, section);
				errors.push(
					validationError(
						"FORM_SECTION_USER_REPEAT",
						"field",
						`"${ctx.formName}" has repeat "${field.id}" inside section "${title}", and that repeat lets the worker add entries. A section shows on one screen, and the CommCare app can't add repeat entries on a single-screen page. Move the repeat out of the sections, or give it a fixed count.`,
						{ ...baseLocation(ctx), fieldUuid: field.uuid, fieldId: field.id },
						{
							sectionUuid: section.uuid,
							sectionId: section.id,
							sectionTitle: title,
						},
					),
				);
			}
			if (
				field.kind === "repeat" &&
				field.repeat_mode === "user_controlled" &&
				section === undefined &&
				fieldListGroup !== undefined
			) {
				const title = containerTitle(doc, fieldListGroup);
				errors.push(
					validationError(
						"FIELD_LIST_USER_REPEAT",
						"field",
						`"${ctx.formName}" has repeat "${field.id}" inside "${title}", which shows its questions on one screen, and that repeat lets the worker add entries. The CommCare app can't add entries on a shared screen. You can let "${title}" show one question per screen, or give the repeat a fixed count.`,
						{ ...baseLocation(ctx), fieldUuid: field.uuid, fieldId: field.id },
						{
							groupUuid: fieldListGroup.uuid,
							groupId: fieldListGroup.id,
							groupTitle: title,
						},
					),
				);
			}
			if (doc.fieldOrder[uuid] !== undefined) {
				walk(
					uuid,
					field,
					section ?? (field.kind === "section" ? field : undefined),
					fieldListGroup ??
						(field.kind === "group" && field.fieldList === true
							? field
							: undefined),
				);
			}
		}
	};
	walk(ctx.formUuid, undefined, undefined, undefined);
	return errors;
}

/**
 * Every capture field in the form that is NOT inside a repeat.
 *
 * The walk stops at a repeat deliberately: a capture there produces one
 * attachment per iteration, and the worker chooses the iteration count,
 * so no authoring-time number bounds it. Counting the template once
 * would understate the real total and imply a guarantee this check
 * cannot make.
 */
function nonRepeatingCaptureFieldIds(
	doc: BlueprintDoc,
	parentUuid: Uuid,
): string[] {
	const ids: string[] = [];
	const walk = (uuid: Uuid) => {
		for (const childUuid of doc.fieldOrder[uuid] ?? []) {
			const field = doc.fields[childUuid];
			if (!field) continue;
			if (field.kind === "repeat") continue;
			if (MEDIA_FIELD_KINDS.has(field.kind)) ids.push(field.id);
			if (doc.fieldOrder[childUuid] !== undefined) walk(childUuid);
		}
	};
	walk(parentUuid);
	return ids;
}

/**
 * A form whose fixed capture questions alone exceed CommCare's
 * per-submission attachment cap can never be submitted once a worker
 * fills it in — the count runs at submit time and aborts the whole
 * submission, leaving no way to shed a file.
 */
function tooManyAttachments(
	doc: BlueprintDoc,
	ctx: FormContext,
): ValidationError[] {
	const captureIds = nonRepeatingCaptureFieldIds(doc, ctx.formUuid);
	if (captureIds.length <= MAX_FORM_ATTACHMENTS) return [];
	return [
		validationError(
			"FORM_TOO_MANY_ATTACHMENTS",
			"form",
			`"${ctx.formName}" asks for ${captureIds.length} attachments, and CommCare accepts at most ${MAX_FORM_ATTACHMENTS} per submitted form. A worker who answers every one of them would be unable to submit, and there would be no way to remove a file to get under the limit. Split this into more than one form, or remove some of the attachment questions.`,
			baseLocation(ctx),
			{ captureCount: String(captureIds.length) },
		),
	];
}

/**
 * The form's own open and close conditions.
 *
 * Only a registration creates its case on a condition (`openCondition`), and
 * only a registration or a close form closes its own case (`closeCondition`).
 * Each condition is form logic read once as the form is submitted; a finding
 * inside it is `CASE_OPERATION_EXPRESSION_TYPE` at the condition's path.
 */
function ownCaseConditionValidation(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormContext,
	mod: Module,
	lookupTables: LookupTypeIndex | undefined,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const loc = baseLocation(ctx);
	const typeName = formTypeLabels[form.type].toLowerCase();

	if (form.openCondition !== undefined && form.type !== "registration") {
		errors.push(
			validationError(
				"OPEN_CONDITION_WRONG_TYPE",
				"form",
				`Only a registration form creates its case on a condition, and “${ctx.formName}” is a ${typeName} form. You can remove the condition or make it a registration form.`,
				{ ...loc, field: "openCondition" },
				{ formType: form.type },
			),
		);
	}
	if (
		form.closeCondition !== undefined &&
		form.type !== "registration" &&
		form.type !== "close"
	) {
		errors.push(
			validationError(
				"CLOSE_CONDITION_WRONG_TYPE",
				"form",
				`Only registration and close forms close their own case, and “${ctx.formName}” is a ${typeName} form. You can remove the close condition or make it a close form.`,
				{ ...loc, field: "closeCondition" },
				{ formType: form.type },
			),
		);
	}

	if (form.type === "close" && !mod.caseType) {
		errors.push(
			validationError(
				"CLOSE_FORM_NO_CASE_TYPE",
				"form",
				`"${ctx.formName}" is a close form but "${ctx.moduleName}" has no case type. Close forms need a case to close. Add a case_type to the module or change the form type.`,
				loc,
			),
		);
	}

	const conditions = [
		{
			slot: "form_open_condition",
			path: "openCondition",
			admitted: form.type === "registration",
			condition: form.openCondition,
			subject: "the condition that creates its case",
		},
		{
			slot: "form_close_condition",
			path: "closeCondition",
			admitted: form.type === "registration" || form.type === "close",
			condition: form.closeCondition,
			subject: "the condition that closes its case",
		},
	] as const;
	for (const { slot, path, admitted, condition, subject } of conditions) {
		// A condition on a form type that holds none is refused above; its
		// slot has no context to check it in.
		if (condition === undefined || !admitted) continue;
		const typeContext = slotContext(
			doc,
			{ entity: "form", uuid: ctx.formUuid, slot },
			lookupTables ?? new Map(),
		);
		if (typeContext === undefined)
			throw new Error(
				`Nova was checking ${subject} in “${ctx.formName}” and found no place for it in the form.`,
			);
		const typeErrors = semanticCheckErrors(
			checkExpression(condition, typeContext),
		);
		const first = typeErrors[0];
		if (first === undefined) continue;
		errors.push(
			validationError(
				"CASE_OPERATION_EXPRESSION_TYPE",
				"form",
				`In “${ctx.formName}”, ${subject} isn't valid here: ${typeErrors.map((error) => error.message).join("; ")}`,
				{ ...loc, field: path },
				{ condition: path, ...checkErrorDetails(first, typeContext) },
			),
		);
	}

	return errors;
}

/** How a withheld destination reads in a reason's sentence. */
const DESTINATION_PHRASE: Readonly<
	Record<PostSubmitDestination, string | undefined>
> = {
	app_home: undefined,
	firstMenu: undefined,
	module: "its module",
	parentMenu: "the parent module",
	previous: "the previous screen",
};

/** Some module's `after-empty-search` registration names the form. */
function namedByCaseListRegistration(
	doc: BlueprintDoc,
	formUuid: Uuid,
): boolean {
	return doc.moduleOrder.some(
		(moduleUuid) =>
			afterEmptySearchRegistrationFormOf(doc, moduleUuid) === formUuid,
	);
}

/** Which slot a withheld destination sits in: a form without destinations'
 *  `postSubmit`, or a built-in otherwise beside destinations. */
type NotOfferedSlot = "post-submit" | "otherwise";

/** The sentence each reason gives, before the offered list. */
function notOfferedSentence(
	reason: PostSubmitNotOfferedReason,
	formName: string,
	moduleName: string,
	parentName: string,
	destination: PostSubmitDestination,
	slot: NotOfferedSlot = "post-submit",
): string {
	const phrase = DESTINATION_PHRASE[destination] ?? destination;
	const when =
		slot === "otherwise" ? "when no destination runs" : "after submit";
	switch (reason) {
		case "menu-selects-several":
			return `"${formName}" goes to the previous screen ${when}, but "${moduleName}" selects several cases, and CommCare has no previous screen to return to there.`;
		case "parent-selects-several":
			return `"${formName}" goes to ${phrase} ${when}, but "${moduleName}" sits under "${parentName}", which selects several cases.`;
		case "menu-forms-read-search":
			return `"${formName}" goes to the previous screen ${when}, but "${moduleName}" has its forms read the search, and CommCare can't go back to the previous screen there.`;
		case "menu-is-bare-case-list":
			return `"${formName}" goes to its module ${when}, but "${moduleName}" is a case list with no forms, so there is no form list to land on.`;
		case "no-parent-menu":
			return `"${formName}" goes to the parent module ${when}, but "${moduleName}" has no parent module.`;
		case "menu-off-the-menu":
			return `"${formName}" goes to ${phrase} ${when}, but "${moduleName}" is off the menu: on Android that screen lists nothing, and Web Apps opens another screen instead.`;
		case "parent-off-the-menu":
			return `"${formName}" goes to the parent module ${when}, but "${parentName}" is off the menu: on Android it lists none of its own forms, and Web Apps opens the app's first screen instead.`;
		case "menu-forms-in-menu-above":
			return `"${formName}" goes to its module ${when}, but "${moduleName}" shows its forms in the menu above, so it has no screen of its own to land on.`;
		case "parent-forms-in-menu-above":
			return `"${formName}" goes to the parent module ${when}, but "${parentName}" shows its forms in the menu above, so it has no screen of its own to land on.`;
		case "menu-forms-on-first-menu":
			return `"${formName}" goes to the previous screen ${when}, but "${moduleName}" shows its forms on the app's first menu, where Nova doesn't offer the previous screen.`;
	}
}

/**
 * Post-submit navigation validation for a form without destinations. A
 * stored destination outside the enum is a shape finding; a stored
 * destination the form's module does not offer
 * (`postSubmitDestinationsOffered`) is `POST_SUBMIT_NOT_OFFERED`, naming the
 * first reason that withholds it. An absent slot is never refused, since its
 * default is always offered. A `postSubmit` beside destinations is
 * `POST_SUBMIT_BESIDE_FORM_LINKS`, which `formLinkValidation` reports. A case
 * list registration form's one explicit destination is
 * `caseListRegistrationForm`'s to judge (`case-search/caseListRegistration.ts`).
 */
function postSubmitValidation(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormContext,
	mod: Module,
): ValidationError[] {
	if (!form.postSubmit) return [];
	const loc = baseLocation(ctx);
	const dest = form.postSubmit;

	const valid = (POST_SUBMIT_DESTINATIONS as readonly string[]).includes(dest);
	if (!valid) {
		return [
			validationError(
				"INVALID_POST_SUBMIT",
				"form",
				`"${ctx.formName}" has post_submit set to "${dest}", which isn't a recognized destination. Use one of: ${POST_SUBMIT_DESTINATIONS.map((value) => `"${value}"`).join(", ")}.`,
				loc,
				{ value: String(dest) },
			),
		];
	}
	if (form.formLinks !== undefined) return [];
	if (afterEmptySearchRegistrationFormOf(doc, ctx.moduleUuid) === ctx.formUuid)
		return [];

	const reason = postSubmitNotOfferedReason(doc, ctx.formUuid, dest);
	if (reason === undefined) return [];
	const parentName = parentNameOf(doc, mod);
	const offered = postSubmitDestinationsOffered(doc, ctx.formUuid);
	return [
		validationError(
			"POST_SUBMIT_NOT_OFFERED",
			"form",
			`${notOfferedSentence(reason, ctx.formName, ctx.moduleName, parentName ?? "", dest)} Choose one of: ${offered.map((value) => `"${value}"`).join(", ")}.`,
			loc,
			{
				reason,
				destination: dest,
				offered: offered.join(","),
				// The two parent reasons name it, and the builder's "Parent
				// module: <name>" label reads it wherever the module has one.
				...(parentName !== undefined && { parentName }),
			},
		),
	];
}

/** The name of `mod`'s parent menu, `""` when the parent is gone, and
 *  `undefined` when it has none. */
function parentNameOf(doc: BlueprintDoc, mod: Module): string | undefined {
	const parentUuid = mod.parentModuleUuid;
	return parentUuid === undefined
		? undefined
		: (doc.modules[parentUuid]?.name ?? "");
}

/**
 * The projection context the form-link rules read, built once per document.
 * The rules run per form, but the context (module/form sequences plus every
 * form's expanded actions, cached) is document-wide; rebuilding it per form
 * would re-expand every target form's actions for every source form.
 */
const projectionContexts = new WeakMap<
	BlueprintDoc,
	FormLinkProjectionContext
>();
/** The projection the link-datum rules read. A link's condition and datum
 * values may read a data table, which prints under a Project's naming the
 * validator does not hold; the rules compare datum ids only, so every table
 * prints under its own id (`identityLookupWireNaming`). */
function projectionContextFor(doc: BlueprintDoc): FormLinkProjectionContext {
	const held = projectionContexts.get(doc);
	if (held !== undefined) return held;
	const built = formLinkProjectionContext(doc, {
		lookupNaming: identityLookupWireNaming(),
	});
	projectionContexts.set(doc, built);
	return built;
}

/**
 * The entry plan the source-write and session-read rules read, built once
 * per validation run. It names every datum an entry declares (ids, case
 * types, selection cardinality) without compiling the selectors, whose lookup
 * reads need a Project's lookup naming the validator never holds.
 */
export function entryPlanContext(doc: BlueprintDoc): FormLinkProjectionContext {
	return formLinkProjectionContext(doc, { entryMetadataOnly: true });
}

/**
 * A link named by where it goes, the way a person finds it in the builder
 * — "the link to “Visit”" rather than "form link 3", which stops meaning
 * anything the moment links are reordered. The otherwise link is named as
 * the otherwise. Position is the fallback for a destination whose target no
 * longer exists. Every finding on a link carries its `linkUuid` and its
 * `role`, which `userFacingErrors.ts::formLinkPhrase` reads.
 */
function formLinkLabel(
	doc: BlueprintDoc,
	sourceFormUuid: Uuid,
	entry: FormLinkEntry,
) {
	const destination = formLinkDestination(
		doc,
		sourceFormUuid,
		entry.link.target,
	);
	const subject =
		entry.role === "otherwise" ? "the otherwise link" : "the link";
	const label =
		destination === undefined
			? entry.role === "otherwise"
				? "the otherwise link"
				: `form link ${entry.index + 1}`
			: destination.kind === "form"
				? `${subject} to "${destination.name}"`
				: destination.kind === "module"
					? `${subject} to the "${destination.name}" module`
					: `${subject} that starts "${destination.name}" again`;
	const details: Record<string, string> = {
		linkUuid: entry.link.uuid,
		role: entry.role,
		...(destination !== undefined && {
			destination: destination.name,
			destinationKind: destination.kind,
		}),
	};
	return { label, details };
}

/**
 * Form-link validation (per-form), over every `formLinkEntries` entry: the
 * destinations and the otherwise link alike. `formLinkProjection.ts` is the
 * ONE reading of what a link emits, and these rules read that same
 * projection, so "valid" means "lands where the author meant" on the local
 * suite and on the HQ upload alike:
 *
 *   - `FORM_LINK_EMPTY` — the schema already refuses an empty list; this is
 *     the backstop for a document that reached the rules another way.
 *   - `FORM_LINK_TARGET_NOT_FOUND` / `FORM_LINK_SELF_REFERENCE` — per link.
 *     A `form` target naming the source form is the self reference; the
 *     `this-form` target says the same and keeps meaning it when the form
 *     moves.
 *   - `FORM_LINK_TARGET_NOT_OFFERED` — a submenu CommCare HQ's form settings
 *     page does not list as a target from this form's menu
 *     (`formLinkTargets.ts::menuTargetOffered`).
 *   - `FORM_LINK_MENU_DATUMS` — carried values on a menu target, which HQ's
 *     page edits only under its retiring advanced linking mode.
 *   - `FORM_OTHERWISE_NOT_OFFERED` — a built-in otherwise the form's menu
 *     does not offer (`postSubmit.ts::otherwiseDestinationsOffered`).
 *   - `FORM_OTHERWISE_UNREACHABLE` — an otherwise where no destination may
 *     not run (`afterSubmit.ts::formOtherwiseReachable`), or beside no
 *     destinations: HQ builds its fallback frame only over a non-blank link
 *     `xpath` (`workflow.py::EndOfFormNavigationWorkflow._get_fallback_frame`).
 *   - `POST_SUBMIT_BESIDE_FORM_LINKS` — a `postSubmit` beside destinations,
 *     which only a form without destinations reads.
 *   - `FORM_LINK_DATUMS_INCOMPLETE` — a form target needs a case the link
 *     cannot supply. The runtime does NOT prompt for it: HQ's
 *     `_get_datums_matched_to_source` yields an unmatched selection datum
 *     as a self-named session ref. Core raises for an absent source node or
 *     carries an empty value without prompting for a case. Nova
 *     refuses the link instead. With explicit datums, every selection datum
 *     of the target must be named.
 * The shared expression checker owns `FORM_LINK_DATUM_UNUSED`: a carried
 * selected-record identity the target never requests is refused before wire
 * projection. HQ's manual matcher would otherwise drop its printed name.
 * Distinct identities may name the same root-aligned target selection;
 * `FORM_LINK_DATUM_TARGET_COLLISION` refuses more than one value for it.
 *
 * The remaining datum rules project the links, which is defined only for
 * session-scope expressions whose targets exist; the other findings cover
 * every document where it is not, so the rule stays total. Link cycles are
 * admitted: a worker leaves one by Back or Home.
 */
function formLinkValidation(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormContext,
	mod: Module,
	lookupTables: LookupTypeIndex = new Map(),
): ValidationError[] {
	const links = form.formLinks;
	const otherwise = form.otherwise;
	if (links === undefined && otherwise === undefined) return [];
	const errors: ValidationError[] = [];
	const loc = baseLocation(ctx);

	if (links !== undefined && links.length === 0) {
		errors.push(
			validationError(
				"FORM_LINK_EMPTY",
				"form",
				`"${ctx.formName}" has form_links set to an empty array. Add at least one link, or remove form_links entirely.`,
				loc,
			),
		);
		return errors;
	}

	if (links !== undefined && form.postSubmit !== undefined) {
		errors.push(
			validationError(
				"POST_SUBMIT_BESIDE_FORM_LINKS",
				"form",
				`"${ctx.formName}" has after-submit destinations and also sets post_submit, which only a form without destinations uses. Remove post_submit, and set where it goes when no destination runs with set_form_otherwise.`,
				loc,
				{ postSubmit: form.postSubmit },
			),
		);
	}

	errors.push(...otherwiseValidation(doc, form, ctx, mod));

	const entries = formLinkEntries(form);
	let targetsResolve = true;
	for (const entry of entries) {
		const { label, details } = formLinkLabel(doc, ctx.formUuid, entry);
		const target = entry.link.target;
		if (target.type === "this-form") continue;

		const targetMod = doc.modules[target.moduleUuid];
		if (targetMod === undefined) {
			targetsResolve = false;
			errors.push(
				validationError(
					"FORM_LINK_TARGET_NOT_FOUND",
					"form",
					`"${ctx.formName}" ${label} targets module ${target.moduleUuid}, which doesn't exist.\n\n` +
						`Update the target to reference an existing module.`,
					loc,
					details,
				),
			);
			continue;
		}
		if (target.type === "module") {
			// A menu that shows its forms above is no target at all, which
			// `FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION` says.
			if (
				!moduleShowsFormsInMenuAbove(targetMod) &&
				!menuTargetOffered(doc, ctx.moduleUuid, target.moduleUuid)
			) {
				const parentName = parentNameOf(doc, targetMod) ?? "";
				errors.push(
					validationError(
						"FORM_LINK_TARGET_NOT_OFFERED",
						"form",
						`"${ctx.formName}" ${label} opens "${targetMod.name}", a submenu CommCare HQ doesn't offer as a link target from "${ctx.moduleName}": a submenu is a target only from a submenu whose parent has the same case type as its own parent. Point the link at "${parentName}", which holds it, or at a form inside "${targetMod.name}".`,
						loc,
						{
							...details,
							targetModuleUuid: target.moduleUuid,
							menuName: targetMod.name,
							parentName,
						},
					),
				);
			}
			if (entry.link.datums !== undefined) {
				errors.push(
					validationError(
						"FORM_LINK_MENU_DATUMS",
						"form",
						`"${ctx.formName}" ${label} carries values to the module "${targetMod.name}", whose form list asks for none. Remove the link's datums, or point it at a form in "${targetMod.name}" that reads them.`,
						loc,
						{
							...details,
							targetModuleUuid: target.moduleUuid,
							menuName: targetMod.name,
						},
					),
				);
			}
			continue;
		}
		const targetForm = doc.forms[target.formUuid];
		if (
			targetForm === undefined ||
			!(doc.formOrder[target.moduleUuid] ?? []).includes(target.formUuid)
		) {
			targetsResolve = false;
			errors.push(
				validationError(
					"FORM_LINK_TARGET_NOT_FOUND",
					"form",
					`"${ctx.formName}" ${label} targets form ${target.formUuid} in "${targetMod.name}", which doesn't exist.\n\n` +
						`Update the target to reference an existing form.`,
					loc,
					details,
				),
			);
		} else if (namedByCaseListRegistration(doc, target.formUuid)) {
			// The form lives only behind the Register action on Results; the
			// wire has no menu command for it, so a link cannot open it.
			targetsResolve = false;
			errors.push(
				validationError(
					"FORM_LINK_TARGET_CASE_LIST_REGISTRATION_FORM",
					"form",
					`"${ctx.formName}" ${label} targets "${targetForm.name}" in "${targetMod.name}", which opens only when a search finds nothing and is on no menu. You can target the menu instead, so the worker searches, or another form.`,
					loc,
					details,
				),
			);
		}
		if (
			target.moduleUuid === ctx.moduleUuid &&
			target.formUuid === ctx.formUuid
		) {
			errors.push(
				validationError(
					"FORM_LINK_SELF_REFERENCE",
					"form",
					`"${ctx.formName}" ${label} names "${ctx.formName}" itself as a form target. Use the target {"type":"this-form"}, which starts this form again and keeps meaning this form if it moves.`,
					loc,
					details,
				),
			);
		}
	}

	// The datum rules read the projection of the destinations and the
	// otherwise link together; without destinations there is no projection,
	// and `FORM_OTHERWISE_UNREACHABLE` already refuses the otherwise.
	if (links === undefined) return errors;

	// Every target with `this-form` resolved to this form in its own menu,
	// the shape the projection's frame readers take.
	const resolved: { entry: FormLinkEntry; target: ResolvedFormLinkTarget }[] =
		[];
	for (const entry of entries) {
		const target = resolveFormLinkTarget(doc, ctx.formUuid, entry.link.target);
		if (target === undefined) return errors;
		resolved.push({ entry, target });
	}

	// The projection is defined only where every target exists, every
	// expression is session-scope, and every form it reads has buildable
	// actions; each "no" is a finding another rule owns.
	if (
		!targetsResolve ||
		!expressionSlotValues(doc, { entity: "form", uuid: ctx.formUuid })
			.filter(
				({ ref }) =>
					ref.slot === "form_link_condition" ||
					ref.slot === "form_link_datum_xpath",
			)
			.every(({ ref, expression }) => {
				const context = slotContext(doc, ref, lookupTables);
				return (
					context !== undefined &&
					checkExpression(expression, context).errors.length === 0
				);
			}) ||
		!formLinkActionsBuildable(
			doc,
			ctx.formUuid,
			resolved.map(({ entry, target }) => ({ ...entry.link, target })),
		)
	) {
		return errors;
	}
	// A link whose frame opens with the first menu's shared case is
	// `FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE`'s; the datum rules judge only
	// frames whose every selection follows a command.
	const sharesFirstMenuCase = new Set(
		linksSharingFirstMenuCase(doc, ctx.formUuid).map(
			({ entry }) => entry.link.uuid,
		),
	);
	const entryContext = entryPlanContext(doc);
	let hasDatumCollision = false;
	for (const { entry, target } of resolved) {
		const datums = entry.link.datums;
		if (datums === undefined || sharesFirstMenuCase.has(entry.link.uuid))
			continue;
		const { label, details } = formLinkLabel(doc, ctx.formUuid, entry);
		for (const targetDatum of formLinkTargetDatumIds(
			doc,
			entryContext,
			target,
		)) {
			const targetRefs = new Set(targetDatum.refs.map(datumRefKey));
			const assigned = datums.filter((datum) =>
				targetRefs.has(datumRefKey(datum.name)),
			);
			if (assigned.length < 2) continue;
			hasDatumCollision = true;
			errors.push(
				validationError(
					"FORM_LINK_DATUM_TARGET_COLLISION",
					"form",
					`"${ctx.formName}" ${label} carries more than one value for the same selected case. Keep one carried value for that case.`,
					loc,
					{
						...details,
						datumRefs: JSON.stringify(assigned.map(({ name }) => name)),
					},
				),
			);
		}
	}
	if (hasDatumCollision) return errors;
	const projected = projectAfterSubmit(
		doc,
		projectionContextFor(doc),
		ctx.formUuid,
	);
	// A destination's selection of a new case this form creates and cannot
	// hand on is `FORM_LINK_NEEDS_NEW_CASE_DATUM`'s, which names why; this
	// rule names every other datum the link leaves unsatisfied.
	const refusedNewCases = new Map<string, Set<string>>();
	for (const finding of formLinkNeedsNewCaseDatum(
		doc,
		ctx.formUuid,
		ctx.moduleUuid,
	)) {
		const linkUuid = finding.details?.linkUuid;
		const caseType = finding.details?.caseType;
		if (linkUuid === undefined || caseType === undefined) continue;
		const types = refusedNewCases.get(linkUuid) ?? new Set<string>();
		types.add(caseType);
		refusedNewCases.set(linkUuid, types);
	}
	const entryByUuid = new Map(
		entries.map((entry) => [entry.link.uuid, entry] as const),
	);
	for (const link of projected?.links ?? []) {
		const entry = entryByUuid.get(link.uuid);
		if (entry === undefined || sharesFirstMenuCase.has(link.uuid)) continue;
		const { label, details } = formLinkLabel(doc, ctx.formUuid, entry);
		const refused = refusedNewCases.get(link.uuid);
		const unsatisfied = [...link.unmatched, ...link.missing].filter(
			(datum) =>
				refused === undefined ||
				datum.caseType === undefined ||
				!refused.has(datum.caseType),
		);
		if (unsatisfied.length > 0) {
			const datumIds = unsatisfied.map((datum) => datum.id).join(", ");
			errors.push(
				validationError(
					"FORM_LINK_DATUMS_INCOMPLETE",
					"form",
					entry.link.datums === undefined
						? `"${ctx.formName}" ${label} cannot carry the case its destination needs (${datumIds}): nothing this form opens or creates matches it, so CommCare cannot open the destination with the case it needs. Name the value to carry on the link, point it at a form this one can hand a case to, or link to the module's form list so the person picks a case there.`
						: `"${ctx.formName}" ${label} names values to carry but leaves out one its destination needs (${datumIds}). Name every value the destination form asks for.`,
					loc,
					{ ...details, datumIds },
				),
			);
		}
		if (link.unrepresentableQueryDatums?.length) {
			errors.push(
				validationError(
					"FORM_LINK_SEARCH_CASE_UNREPRESENTABLE",
					"form",
					`"${ctx.formName}" ${label} assigns a different case to a destination whose forms read the search. CommCare would fetch the previous case before applying this assignment. Automatic case matching can carry the case this form selected or created; removing the manual assignment lets Nova check that match. Another option is a destination whose forms read their own case.`,
					loc,
					{ ...details, datumIds: link.unrepresentableQueryDatums.join(", ") },
				),
			);
		}
	}

	return errors;
}

/**
 * The otherwise's own rules: it runs only where some destination may not
 * run, and a built-in otherwise must be one the form's menu offers. A case
 * list registration form holds no destinations
 * (`CASE_LIST_REGISTRATION_HAS_NAVIGATION`), so it holds no otherwise
 * either.
 */
function otherwiseValidation(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormContext,
	mod: Module,
): ValidationError[] {
	const otherwise = form.otherwise;
	if (otherwise === undefined) return [];
	const loc = baseLocation(ctx);
	const errors: ValidationError[] = [];
	const identity: Record<string, string> = {
		role: "otherwise",
		...(otherwise.kind === "link" && { linkUuid: otherwise.uuid }),
	};

	if (form.formLinks === undefined) {
		errors.push(
			validationError(
				"FORM_OTHERWISE_UNREACHABLE",
				"form",
				`"${ctx.formName}" sets an otherwise but has no destinations. Add a destination, or remove the otherwise.`,
				loc,
				{ ...identity, arm: "no-destinations" },
			),
		);
	} else if (!formOtherwiseReachable(doc, ctx.formUuid)) {
		errors.push(
			validationError(
				"FORM_OTHERWISE_UNREACHABLE",
				"form",
				`"${ctx.formName}" sets an otherwise, but every destination runs each time, so the otherwise never runs. Give a destination a condition or a carried case, or remove the otherwise with set_form_otherwise null.`,
				loc,
				{ ...identity, arm: "every-destination-runs" },
			),
		);
	}

	if (otherwise.kind !== "destination") return errors;
	const destination = otherwise.destination;
	const offered = otherwiseDestinationsOffered(doc, ctx.formUuid);
	if (offered.includes(destination)) return errors;
	const reason = postSubmitNotOfferedReason(doc, ctx.formUuid, destination);
	if (reason === undefined) return errors;
	const parentName = parentNameOf(doc, mod);
	errors.push(
		validationError(
			"FORM_OTHERWISE_NOT_OFFERED",
			"form",
			`${notOfferedSentence(reason, ctx.formName, ctx.moduleName, parentName ?? "", destination, "otherwise")} Choose one of: ${offered.map((value) => `"${value}"`).join(", ")}, or remove the otherwise so the app home follows.`,
			loc,
			{
				...identity,
				slot: "otherwise",
				reason,
				destination,
				offered: offered.join(","),
				...(parentName !== undefined && { parentName }),
			},
		),
	);
	return errors;
}

function connectValidation(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormContext,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const loc = baseLocation(ctx);

	// Standard apps carry no dormant Connect configuration. A mode switch is
	// one app-wide target-state command that clears incompatible/unlisted
	// blocks; individual form edits are available only after a mode exists.
	if (!doc.connectType) {
		if (form.connect) {
			errors.push(
				validationError(
					"CONNECT_MODE_MISMATCH",
					"form",
					`"${ctx.formName}" carries a Connect block while Connect is off for the app. Configure the app's mode and complete participant set together with configureConnect/configure_connect, or remove this form block.`,
					loc,
				),
			);
		}
		return errors;
	}

	// A form WITHOUT a connect block is a legal, meaningful state on a
	// Connect app: the block marks that the form PARTICIPATES in Connect,
	// and omitting it makes the form auxiliary. Connect's own ingestion is
	// coverage-blind — `commcare_connect/opportunity/app_xml.py::
	// extract_modules` / `::extract_deliver_unit` / `::extract_task_unit`
	// scan each form's XML for connect-namespace blocks and silently skip
	// forms without them, and `opportunity/tasks.py::
	// create_learn_modules_and_deliver_units` upserts whatever was found
	// with no per-form coverage check. The app-wide floor (≥1 participating
	// form, without which progress/payment have nothing to key on) is the
	// app-scoped `CONNECT_NO_PARTICIPATING_FORMS` rule in `rules/app.ts`;
	// everything below adjudicates a block that IS present.
	if (!form.connect) return errors;

	const blockIsLearn = isConnectLearnConfig(form.connect);
	if ((doc.connectType === "learn") !== blockIsLearn) {
		errors.push(
			validationError(
				"CONNECT_MODE_MISMATCH",
				"form",
				`"${ctx.formName}" carries a ${blockIsLearn ? "learn" : "deliver"} Connect block, but the app is in ${doc.connectType} mode. Configure the mode and complete participant set together with configureConnect/configure_connect.`,
				loc,
			),
		);
		return errors;
	}

	// Connect reads a deliver form's deliver unit before its task and turns
	// the delivery away while the worker has a pending task
	// (commcare-connect `form_receiver/processor.py::process_deliver_form`,
	// `process_deliver_unit`), so the visit in a form that also completes a
	// task is never paid. A task goes in a form of its own.
	if (connectDeliverFormHoldsTask(form.connect)) {
		errors.push(
			validationError(
				"CONNECT_DELIVER_FORM_HOLDS_TASK",
				"form",
				`"${ctx.formName}" holds both a deliver unit and a task. CommCare Connect checks the delivery before it completes the task, so it turns away the visit in this form while the task is assigned. A task goes in a form of its own.`,
				loc,
			),
		);
	}

	// A Connect id names a node of the emitted form (the wrapper
	// `<id vellum:role=...>` and the Connect-namespaced `id=` attribute) and
	// lands in a Connect DB slug column (tightest is `varchar(50)`).
	// `connectIdProblem` is the single authority on what makes an id valid
	// (the question-id grammar without Connect's own names, then the length
	// cap), and `connectIdError` says the same sentence the builder's field
	// and the tools say, offering an id free among the app's other Connect
	// ids. We reject a bad id here rather than silently fixing it.
	const connectIds: ReadonlyArray<{
		label: string;
		id: string;
	}> = isConnectLearnConfig(form.connect)
		? [
				...(form.connect.learn_module === undefined
					? []
					: [
							{
								label: "learn-module",
								id: form.connect.learn_module.id,
							},
						]),
				...(form.connect.assessment === undefined
					? []
					: [
							{
								label: "assessment",
								id: form.connect.assessment.id,
							},
						]),
			]
		: [
				...(form.connect.deliver_unit === undefined
					? []
					: [
							{
								label: "deliver-unit",
								id: form.connect.deliver_unit.id,
							},
						]),
				...(form.connect.task === undefined
					? []
					: [{ label: "task", id: form.connect.task.id }]),
			];
	// A refused id is offered a replacement free among the app's other
	// Connect ids and this form's root questions, whose elements share the
	// wrapper's parent. Read once per form, and only once an id is refused.
	let takenBeside: ReadonlySet<string> | undefined;
	for (const { label, id } of connectIds) {
		const problem = connectIdProblem(id);
		if (problem === undefined) continue;
		takenBeside ??= new Set([
			...appConnectIds(doc),
			...formRootTakenIds(doc, ctx.formUuid),
		]);
		const taken = new Set(takenBeside);
		taken.delete(id);
		const reason = connectIdError(id, taken);
		errors.push(
			problem.kind === "format"
				? validationError(
						"CONNECT_ID_INVALID_FORMAT",
						"form",
						`Connect ${label} id in "${ctx.formName}": ${reason}`,
						loc,
						{
							connectId: id,
							problem: problem.problem,
							suggestedId: freeConnectId(id, taken),
						},
					)
				: validationError(
						"CONNECT_ID_TOO_LONG",
						"form",
						`Connect ${label} id in "${ctx.formName}": ${reason}`,
						loc,
						{ connectId: id },
					),
		);
	}

	return errors;
}

/**
 * A form's root fields and its Connect blocks' wrappers are children of the
 * one data root, so a root field named like one of the form's blocks would
 * be two elements of one name, which no reader can tell apart. The finding
 * sits on the field and offers an id free among every name at the root.
 */
function rootFieldNamesConnectBlock(
	doc: BlueprintDoc,
	ctx: FormContext,
): ValidationError[] {
	const connectIds = formConnectIds(doc, ctx.formUuid);
	if (connectIds.size === 0) return [];
	const taken = formRootTakenIds(doc, ctx.formUuid);
	const errors: ValidationError[] = [];
	for (const uuid of doc.fieldOrder[ctx.formUuid] ?? []) {
		const field = doc.fields[uuid];
		if (field === undefined || !connectIds.has(field.id)) continue;
		const suggestedId = freeQuestionId(field.id, taken);
		taken.add(suggestedId);
		errors.push(
			validationError(
				"FIELD_ID_NAMES_CONNECT_BLOCK",
				"field",
				`Field "${field.id}" in "${ctx.formName}" has the same ID as one of the form's CommCare Connect blocks. The block and a top-level field sit side by side in the form, so the form would hold two items of one name that CommCare can't tell apart. You can rename the field ("${suggestedId}" is free) or give the block another ID.`,
				{ ...baseLocation(ctx), fieldUuid: field.uuid, fieldId: field.id },
				{ fieldId: field.id, suggestedId },
			),
		);
	}
	return errors;
}

/**
 * Field IDs must be unique among siblings (same parent scope). Different
 * scopes (e.g. /data/grp/name and /data/other/name) coexist — they have
 * different XML paths.
 */
function duplicateFieldIds(
	doc: BlueprintDoc,
	ctx: FormContext,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const walk = (parentUuid: Uuid, parentPath: string): void => {
		const counts = new Map<string, number>();
		const order = doc.fieldOrder[parentUuid] ?? [];
		for (const uuid of order) {
			const field = doc.fields[uuid];
			if (!field) continue;
			counts.set(field.id, (counts.get(field.id) ?? 0) + 1);
		}
		for (const [id, count] of counts) {
			if (count > 1) {
				errors.push(
					validationError(
						"DUPLICATE_FIELD_ID",
						"form",
						`"${ctx.formName}" in "${ctx.moduleName}" has ${count} fields with the ID "${id}" at the same level (${parentPath}). Fields at the same level share an XML path, so they need unique IDs. Rename the duplicates.`,
						baseLocation(ctx),
					),
				);
			}
		}
		for (const uuid of order) {
			const field = doc.fields[uuid];
			if (!field) continue;
			if (doc.fieldOrder[uuid] !== undefined) {
				walk(uuid, `${parentPath}/${field.id}`);
			}
		}
	};
	walk(ctx.formUuid, "/data");
	return errors;
}

/** The most characters of a matched text a finding carries. */
const INSTANCE_TEXT_MATCH_MAX_LENGTH = 40;

/**
 * Plain text in the form's source that CommCare HQ's build reads as an
 * instance read. HQ renders the whole form and matches its instance pattern
 * over it (`xform.py::XForm.add_missing_instances`,
 * `suite_xml/post_process/instances.py::get_instance_names`), so a name it
 * has no source for stops the build and one it has a source for adds a
 * declaration no formula reads. A label's text is written so the pattern
 * cannot match it (`xform/builder.ts::literalLabelNodes`); a form's name and
 * a Connect block's text are plain text that CommCare Connect and HQ's form
 * builder read as the element's own, where no spelling keeps the pattern
 * out, so the text is refused and a space before the bracket keeps it as
 * text.
 */
function formTextReadAsInstance(
	doc: BlueprintDoc,
	ctx: FormContext,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const { site, text } of formSourceTexts(doc, ctx.formUuid)) {
		const read = instanceScanRead(text);
		if (read === undefined) continue;
		const match = Array.from(read)
			.slice(0, INSTANCE_TEXT_MATCH_MAX_LENGTH)
			.join("");
		const reading =
			"CommCare HQ reads instance( followed by a quoted name and a closing bracket as a data source wherever it appears in a form";
		const outcome =
			"so CommCare HQ would add that data source to the form or stop its build. A space before the bracket keeps it as text: instance ('...').";
		const message =
			site === "form-name"
				? `The name of the form "${ctx.formName}" in the app's default language holds ${match}. ${reading}, and a form's name is written there as plain text, ${outcome}`
				: `The ${CONNECT_SOURCE_TEXT_WORDS[site]} in "${ctx.formName}" holds ${match}. ${reading}, and CommCare Connect reads this text exactly as the form holds it, ${outcome}`;
		errors.push(
			validationError(
				"FORM_TEXT_READ_AS_INSTANCE",
				"form",
				message,
				baseLocation(ctx),
				{ site, match },
			),
		);
	}
	return errors;
}

// ── Rule runner ────────────────────────────────────────────────────

export function runFormRules(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleUuid: Uuid,
	entryPlan: FormLinkProjectionContext,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	const form = doc.forms[formUuid];
	const mod = doc.modules[moduleUuid];
	const ctx: FormContext = {
		formUuid,
		moduleUuid,
		formName: form.name,
		moduleName: mod.name,
	};

	const errors: ValidationError[] = [];
	errors.push(...emptyForm(doc, form, ctx));
	errors.push(...formSections(doc, ctx));
	errors.push(...formDisplayCondition(doc, formUuid, moduleUuid, lookupTables));
	if (lookupTables !== undefined) {
		errors.push(
			...validateLookupOptionsSources(doc, formUuid, moduleUuid, lookupTables),
			...validateCaseOptionsSources(doc, formUuid, moduleUuid, lookupTables),
		);
	}
	errors.push(...ownCaseConditionValidation(doc, form, ctx, mod, lookupTables));
	errors.push(...duplicateFieldIds(doc, ctx));
	errors.push(...rootFieldNamesConnectBlock(doc, ctx));
	errors.push(...tooManyAttachments(doc, ctx));
	errors.push(...postSubmitValidation(doc, form, ctx, mod));
	errors.push(...formLinkSelectionCardinality(doc, form, mod, ctx));
	errors.push(...formLinkValidation(doc, form, ctx, mod, lookupTables));
	errors.push(...hiddenMenuLinkTargets(doc, form, baseLocation(ctx)));
	errors.push(...menuAboveLinkTargets(doc, form, baseLocation(ctx)));
	errors.push(...connectValidation(doc, form, ctx));
	errors.push(...formTextReadAsInstance(doc, ctx));
	errors.push(
		...validateCaseOperations(doc, formUuid, moduleUuid, lookupTables),
	);
	errors.push(...validateCasePlacements(doc, formUuid, moduleUuid));
	errors.push(...formLinkNeedsNewCaseDatum(doc, formUuid, moduleUuid));
	errors.push(
		...casePropertyNameFormBuilderCannotKeep(
			doc,
			formUuid,
			moduleUuid,
			entryPlan,
		),
	);
	errors.push(...multiSelectFormSemantics(doc, form, mod, ctx));

	return errors;
}
