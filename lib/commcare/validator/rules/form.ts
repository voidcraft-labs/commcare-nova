/**
 * Form-level validation rules.
 *
 * Each rule receives the normalized `BlueprintDoc`, the form entity, and its
 * `formUuid` (plus the owning module for rules that need sibling context).
 * Case-write action assignment, path resolution, repeat scope, and admission
 * are derived once per form through `deriveCaseWriteInventory`; every
 * case-write finding below consumes that one inventory.
 */

import {
	CASE_PROPERTY_REGEX,
	MAX_CASE_PROPERTY_LENGTH,
	MAX_FORM_ATTACHMENTS,
	MEDIA_FIELD_KINDS,
} from "@/lib/commcare";
import { caseWriteAdmissionFindings } from "@/lib/commcare/caseWriteFindings";
import {
	connectIdError,
	connectIdProblem,
	freeConnectId,
} from "@/lib/commcare/connectSlugs";
import {
	type FormLinkProjectionContext,
	formLinkActionsBuildable,
	formLinkIsConditional,
	formLinkProjectionContext,
	formLinkTargetDatumIds,
	projectFormLinks,
} from "@/lib/commcare/formLinkProjection";
import { identityLookupWireNaming } from "@/lib/commcare/lookup/naming";
import { descendantFieldUuids } from "@/lib/doc/fieldWalk";
import {
	appConnectIds,
	type BlueprintDoc,
	type CaseWriteInventory,
	connectDeliverFormHoldsTask,
	deriveCaseWriteInventory,
	type Field,
	type Form,
	type FormLink,
	fieldRegistry,
	formConnectIds,
	formLinkDestination,
	formRootTakenIds,
	isConnectLearnConfig,
	isNoMatchesForm,
	type Module,
	POST_SUBMIT_DESTINATIONS,
	type PostSubmitDestination,
	type PostSubmitNotOfferedReason,
	postSubmitDestinationsAdmitted,
	postSubmitDestinationsOffered,
	postSubmitNotOfferedReason,
	projectProseTemplate,
	type Uuid,
} from "@/lib/domain";
import { slotContext } from "@/lib/domain/expression/context";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import { datumRefKey } from "@/lib/domain/expression/types";
import { freeQuestionId } from "@/lib/domain/questionId";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
import { type ValidationError, validationError } from "../errors";
import type { LookupTypeIndex } from "../lookupTypeContext";
import { searchNoMatchesEntry } from "./case-search/searchNoMatches";
import { validateCaseOperations } from "./caseOperations";
import { validateCaseOptionsSources } from "./caseOptionsSource";
import { formDisplayCondition } from "./displayConditions";
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

/** A section named the way a person knows it: its title, else its id. */
function sectionTitle(doc: BlueprintDoc, section: Field): string {
	if (section.kind !== "section" || section.label === undefined) {
		return section.id;
	}
	const text = projectProseTemplate(section.label, doc).text.trim();
	return text.length > 0 ? text : section.id;
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
				const title = sectionTitle(doc, section);
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
			if (doc.fieldOrder[uuid] !== undefined) {
				walk(
					uuid,
					field,
					section ?? (field.kind === "section" ? field : undefined),
				);
			}
		}
	};
	walk(ctx.formUuid, undefined, undefined);
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
 * Validate `closeCondition` on close forms.
 *
 * `closeCondition` is only valid on forms with type "close". When present,
 * both field and answer must be specified, and the referenced field must
 * exist in the form.
 */
function closeConditionValidation(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormContext,
	mod: Module,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const loc = baseLocation(ctx);

	if (form.closeCondition && form.type !== "close") {
		errors.push(
			validationError(
				"CLOSE_CONDITION_WRONG_TYPE",
				"form",
				`"${ctx.formName}" has a close_condition but isn't a close form. close_condition is only valid on forms with type "close". Either change the form type to "close" or remove the close_condition.`,
				loc,
			),
		);
		return errors;
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

	if (form.closeCondition) {
		const cc = form.closeCondition;
		if (!cc.field || !cc.answer) {
			errors.push(
				validationError(
					"CLOSE_CONDITION_INCOMPLETE",
					"form",
					`"${ctx.formName}" has a close_condition but is missing the ${!cc.field ? "field" : "answer"}. Both field and answer are required for conditional close. To close unconditionally, remove the close_condition entirely.`,
					loc,
				),
			);
		}
		if (cc.field) {
			// The ref is the checked field's stable uuid; it must land on a
			// field of THIS form. A legacy dangler (unresolvable id text)
			// fails the same membership test and reports its text verbatim.
			const formFieldUuids = descendantFieldUuids(doc, ctx.formUuid);
			if (!formFieldUuids.has(cc.field)) {
				const shown = doc.fields[cc.field]?.id ?? cc.field;
				errors.push(
					validationError(
						"CLOSE_CONDITION_FIELD_NOT_FOUND",
						"form",
						`"${ctx.formName}" has close_condition checking field "${shown}", but no field like that exists in the form. Either add the field or update close_condition to reference an existing one.`,
						loc,
					),
				);
			}
		}
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

/** The sentence each reason gives, before the offered list. */
function notOfferedSentence(
	reason: PostSubmitNotOfferedReason,
	formName: string,
	moduleName: string,
	parentName: string,
	destination: PostSubmitDestination,
): string {
	const phrase = DESTINATION_PHRASE[destination] ?? destination;
	switch (reason) {
		case "menu-selects-several":
			return `"${formName}" goes to the previous screen after submit, but "${moduleName}" selects several cases, and CommCare has no previous screen to return to there.`;
		case "parent-selects-several":
			return `"${formName}" goes to ${phrase} after submit, but "${moduleName}" sits under "${parentName}", which selects several cases.`;
		case "menu-opens-on-search":
			return `"${formName}" goes to the previous screen after submit, but "${moduleName}" opens on Search, and CommCare can't go back to the previous screen there.`;
		case "menu-is-case-list-only":
			return `"${formName}" goes to its module after submit, but "${moduleName}" is a case list with no forms, so there is no form list to land on.`;
		case "no-parent-menu":
			return `"${formName}" goes to the parent module after submit, but "${moduleName}" has no parent module.`;
		case "menu-off-the-menu":
			return `"${formName}" goes to ${phrase} after submit, but "${moduleName}" is off the menu: on Android that screen lists nothing, and Web Apps opens another screen instead.`;
		case "parent-off-the-menu":
			return `"${formName}" goes to the parent module after submit, but "${parentName}" is off the menu: on Android it lists none of its own forms, and Web Apps opens the app's first screen instead.`;
	}
}

/**
 * Post-submit navigation validation. A stored destination outside the
 * enum is a shape finding; a stored destination the form's module does not
 * offer (`postSubmitDestinationsAdmitted`) is `POST_SUBMIT_NOT_OFFERED`,
 * naming the first reason that withholds it. An absent slot is never
 * refused, since its default is always offered. A no-matches form's one
 * explicit destination is `searchNoMatchesEntry`'s to judge.
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
	if (isNoMatchesForm(form)) return [];

	const reason = postSubmitNotOfferedReason(doc, ctx.formUuid, dest);
	if (reason === undefined) return [];
	const parentUuid = mod.parentModuleUuid;
	const parentName =
		parentUuid === undefined ? "" : (doc.modules[parentUuid]?.name ?? "");
	const offered = postSubmitDestinationsOffered(doc, ctx.formUuid);
	return [
		validationError(
			"POST_SUBMIT_NOT_OFFERED",
			"form",
			`${notOfferedSentence(reason, ctx.formName, ctx.moduleName, parentName, dest)} Choose one of: ${offered.map((value) => `"${value}"`).join(", ")}.`,
			loc,
			{
				reason,
				destination: dest,
				offered: offered.join(","),
				// The two parent reasons name it, and the builder's "Parent
				// module: <name>" label reads it wherever the module has one.
				...(parentUuid !== undefined && { parentName }),
			},
		),
	];
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
 * anything the moment links are reordered. Position is the fallback for a
 * target that no longer exists.
 */
function formLinkLabel(doc: BlueprintDoc, link: FormLink, index: number) {
	const destination = formLinkDestination(doc, link.target);
	const label =
		destination === undefined
			? `form link ${index + 1}`
			: destination.kind === "form"
				? `the link to "${destination.name}"`
				: `the link to the "${destination.name}" module`;
	const details: Record<string, string> = {
		linkUuid: link.uuid,
		...(destination !== undefined && {
			destination: destination.name,
			destinationKind: destination.kind,
		}),
	};
	return { label, details };
}

/**
 * Form-link validation (per-form). `formLinkProjection.ts` is the ONE
 * reading of what a link emits, and these rules read that same projection,
 * so "valid" means "lands where the author meant" on the local suite and on
 * the HQ upload alike:
 *
 *   - `FORM_LINK_EMPTY` — the schema already refuses an empty list; this is
 *     the backstop for a document that reached the rules another way.
 *   - `FORM_LINK_TARGET_NOT_FOUND` / `FORM_LINK_SELF_REFERENCE` — per link.
 *   - `FORM_LINK_UNREACHABLE` — a link after an unconditional one. The
 *     authoring contract chooses the first matching link, so later links
 *     cannot run. The low-level projector stays total over this refused input.
 *   - `FORM_LINK_NO_FALLBACK` — the last link is conditional and the form
 *     has no EXPLICIT `postSubmit`. The form-type default is what a form
 *     does with no links at all, not a destination the author chose for
 *     "none of these matched"; a terminal unconditional link is the
 *     exhaustive else and satisfies the rule by itself.
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
 * The remaining datum rules project the links, which is defined only for session-scope
 * expressions whose targets exist; the other findings cover every document
 * where it is not, so the rule stays total. Cycle detection across forms
 * runs at app scope in `circularFormLinks`.
 */
function formLinkValidation(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormContext,
	lookupTables: LookupTypeIndex = new Map(),
): ValidationError[] {
	const links = form.formLinks;
	if (links === undefined) return [];
	const errors: ValidationError[] = [];
	const loc = baseLocation(ctx);

	if (links.length === 0) {
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

	const isConditional = formLinkIsConditional;

	let targetsResolve = true;
	let earlierUnconditional: { label: string } | undefined;
	links.forEach((link, index) => {
		const { label, details } = formLinkLabel(doc, link, index);

		if (earlierUnconditional !== undefined) {
			errors.push(
				validationError(
					"FORM_LINK_UNREACHABLE",
					"form",
					`"${ctx.formName}" can never use ${label}: ${earlierUnconditional.label} comes before it and has no condition, so it always wins. Move ${label} above it, or give ${earlierUnconditional.label} a condition.`,
					loc,
					details,
				),
			);
		} else if (!isConditional(link)) {
			earlierUnconditional = { label };
		}

		const targetMod = doc.modules[link.target.moduleUuid];
		if (targetMod === undefined) {
			targetsResolve = false;
			errors.push(
				validationError(
					"FORM_LINK_TARGET_NOT_FOUND",
					"form",
					`"${ctx.formName}" ${label} targets module ${link.target.moduleUuid}, which doesn't exist.\n\n` +
						`Update the target to reference an existing module.`,
					loc,
					details,
				),
			);
			return;
		}
		if (link.target.type !== "form") return;
		const targetForm = doc.forms[link.target.formUuid];
		if (
			targetForm === undefined ||
			!(doc.formOrder[link.target.moduleUuid] ?? []).includes(
				link.target.formUuid,
			)
		) {
			targetsResolve = false;
			errors.push(
				validationError(
					"FORM_LINK_TARGET_NOT_FOUND",
					"form",
					`"${ctx.formName}" ${label} targets form ${link.target.formUuid} in "${targetMod.name}", which doesn't exist.\n\n` +
						`Update the target to reference an existing form.`,
					loc,
					details,
				),
			);
		} else if (isNoMatchesForm(targetForm)) {
			// The form lives only behind the Register action on Results; the
			// wire has no menu command for it, so a link cannot open it.
			targetsResolve = false;
			errors.push(
				validationError(
					"FORM_LINK_TARGET_NO_MATCHES_FORM",
					"form",
					`"${ctx.formName}" ${label} targets "${targetForm.name}" in "${targetMod.name}", which opens only after a search finds no matches and is on no menu. Target the module instead so the worker searches, or another form.`,
					loc,
					details,
				),
			);
		}
		if (
			link.target.moduleUuid === ctx.moduleUuid &&
			link.target.formUuid === ctx.formUuid
		) {
			errors.push(
				validationError(
					"FORM_LINK_SELF_REFERENCE",
					"form",
					`"${ctx.formName}" ${label} links back to itself, which would loop the user straight back into this form. Point it at the module menu or another form instead.`,
					loc,
					details,
				),
			);
		}
	});

	// An unconditional link anywhere is the exhaustive else (when it is not
	// last, FORM_LINK_UNREACHABLE already owns that defect); with none, the
	// form must say explicitly where people go when no condition matches.
	if (links.every(isConditional) && !form.postSubmit) {
		errors.push(
			validationError(
				"FORM_LINK_NO_FALLBACK",
				"form",
				`"${ctx.formName}"'s form links all have conditions and the form sets no post_submit, so nothing says where people go when no condition matches. Set post_submit to one of ${postSubmitDestinationsAdmitted(
					doc,
					ctx.formUuid,
				)
					.map((value) => `"${value}"`)
					.join(", ")}, or end the list with an unconditional link.`,
				loc,
			),
		);
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
		!formLinkActionsBuildable(doc, ctx.formUuid, links)
	) {
		return errors;
	}
	const entryContext = entryPlanContext(doc);
	let hasDatumCollision = false;
	for (const [index, link] of links.entries()) {
		if (link.datums === undefined) continue;
		const { label, details } = formLinkLabel(doc, link, index);
		for (const target of formLinkTargetDatumIds(
			doc,
			entryContext,
			link.target,
		)) {
			const targetRefs = new Set(target.refs.map(datumRefKey));
			const assigned = link.datums.filter((datum) =>
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
	const projected = projectFormLinks(
		doc,
		projectionContextFor(doc),
		ctx.formUuid,
	);
	for (const link of projected?.links ?? []) {
		const index = links.findIndex((candidate) => candidate.uuid === link.uuid);
		const authored = links[index];
		if (authored === undefined) continue;
		const { label, details } = formLinkLabel(doc, authored, index);
		const unsatisfied = [...link.unmatched, ...link.missing];
		if (unsatisfied.length > 0) {
			const datumIds = unsatisfied.map((datum) => datum.id).join(", ");
			errors.push(
				validationError(
					"FORM_LINK_DATUMS_INCOMPLETE",
					"form",
					authored.datums === undefined
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
					`"${ctx.formName}" ${label} assigns a different case to a destination that opens on Search. CommCare would fetch the previous case before applying this assignment. Automatic case matching can carry the case this form selected or created; removing the manual assignment lets Nova check that match. Another option is a destination that opens on its case list.`,
					loc,
					{ ...details, datumIds: link.unrepresentableQueryDatums.join(", ") },
				),
			);
		}
	}

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

function casePropertyBadFormat(
	ctx: FormContext,
	inventory: CaseWriteInventory,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const writer of inventory.writers) {
		const prop = writer.property;
		if (prop === "case_name") continue;
		if (!CASE_PROPERTY_REGEX.test(prop)) {
			errors.push(
				validationError(
					"CASE_PROPERTY_BAD_FORMAT",
					"form",
					`"${ctx.formName}" has case property "${prop}" which isn't a valid identifier. Property names must start with a letter and can only contain letters, digits, underscores, or hyphens. Try renaming it to something like "${prop.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^[^a-zA-Z]/, "q_")}".`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{ property: prop },
				),
			);
		}
	}
	return errors;
}

function casePropertyTooLong(
	ctx: FormContext,
	inventory: CaseWriteInventory,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const writer of inventory.writers) {
		const prop = writer.property;
		if (prop.length > MAX_CASE_PROPERTY_LENGTH) {
			errors.push(
				validationError(
					"CASE_PROPERTY_TOO_LONG",
					"form",
					`"${ctx.formName}" has case property "${prop.slice(0, 40)}..." which is ${prop.length} characters long. CommCare limits property names to ${MAX_CASE_PROPERTY_LENGTH} characters. Use a shorter, more concise name.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{ property: prop },
				),
			);
		}
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

	const caseWriteInventory = deriveCaseWriteInventory(
		doc,
		formUuid,
		mod,
		form.type,
	);

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
	errors.push(...closeConditionValidation(doc, form, ctx, mod));
	errors.push(...duplicateFieldIds(doc, ctx));
	errors.push(...rootFieldNamesConnectBlock(doc, ctx));
	errors.push(...caseWriteAdmissionFindings(ctx, caseWriteInventory));
	errors.push(...tooManyAttachments(doc, ctx));
	errors.push(...casePropertyBadFormat(ctx, caseWriteInventory));
	errors.push(...casePropertyTooLong(ctx, caseWriteInventory));
	errors.push(...postSubmitValidation(doc, form, ctx, mod));
	errors.push(...searchNoMatchesEntry(doc, form, formUuid, moduleUuid));
	errors.push(
		...formLinkSelectionCardinality(doc, form, mod, ctx, caseWriteInventory),
	);
	errors.push(...formLinkValidation(doc, form, ctx, lookupTables));
	errors.push(...hiddenMenuLinkTargets(doc, form, baseLocation(ctx)));
	errors.push(...connectValidation(doc, form, ctx));
	errors.push(
		...validateCaseOperations(doc, formUuid, moduleUuid, lookupTables),
	);
	errors.push(
		...casePropertyNameFormBuilderCannotKeep(
			doc,
			formUuid,
			moduleUuid,
			entryPlan,
		),
	);
	errors.push(
		...multiSelectFormSemantics(doc, form, mod, ctx, caseWriteInventory),
	);

	return errors;
}
