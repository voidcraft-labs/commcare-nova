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
	XML_ELEMENT_NAME_REGEX,
} from "@/lib/commcare";
import { caseWriteAdmissionIssues } from "@/lib/commcare/caseWriteAdmission";
import { connectIdError } from "@/lib/commcare/connectSlugs";
import {
	type FormLinkProjectionContext,
	formLinkActionsBuildable,
	formLinkIsConditional,
	formLinkProjectionContext,
	formLinksProjectable,
	projectFormLinks,
} from "@/lib/commcare/formLinkProjection";
import { detectUnquotedStringLiteral } from "@/lib/commcare/xpath";
import {
	type BlueprintDoc,
	type CaseWriteInventory,
	deriveCaseWriteInventory,
	type Field,
	FORM_REFERENCE_SLOTS,
	type Form,
	type FormLink,
	fieldReferenceSlotsFor,
	fieldRegistry,
	formExpressionValue,
	formLinkDestination,
	isConnectLearnConfig,
	type Module,
	POST_SUBMIT_DESTINATIONS,
	type ProseTemplate,
	projectProseTemplate,
	projectXPath,
	readSlotValues,
	type Uuid,
	type XPathExpression,
	xpathPrintContext,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../errors";
import type { LookupTypeIndex } from "../lookupTypeContext";
import { validateCaseOperations } from "./caseOperations";
import { formDisplayCondition } from "./displayConditions";
import { validateLookupOptionsSources } from "./lookupOptionsSource";
import {
	formLinkSelectionCardinality,
	multiSelectFormSemantics,
} from "./multiSelect";

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Domain field-tree walker: collect every field.id under `parentUuid`,
 * including descendants in containers. Used by rules that need to check
 * membership — "does a field with this id exist in this form?"
 */
/** Every field uuid under `parentUuid`, containers included. */
function collectFieldUuids(doc: BlueprintDoc, parentUuid: Uuid): Set<string> {
	const uuids = new Set<string>();
	const walk = (uuid: Uuid) => {
		for (const childUuid of doc.fieldOrder[uuid] ?? []) {
			if (doc.fields[childUuid] === undefined) continue;
			uuids.add(childUuid);
			if (doc.fieldOrder[childUuid] !== undefined) walk(childUuid);
		}
	};
	walk(parentUuid);
	return uuids;
}

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
	/* A section keeps the root non-empty while holding nothing, so the
	 * honest question is whether the form holds anything at all: a
	 * non-section root field, or a section with something on it. */
	const holdsAnything = order.some((uuid) => {
		const field = doc.fields[uuid];
		if (field === undefined) return false;
		if (field.kind !== "section") return true;
		return (doc.fieldOrder[uuid]?.length ?? 0) > 0;
	});
	if (holdsAnything) return [];
	const message =
		order.length === 0
			? `"${ctx.formName}" in "${ctx.moduleName}" has no fields. CommCare can't build an empty form. Add at least one field.`
			: `"${ctx.formName}" in "${ctx.moduleName}" has sections, but nothing on any of them. CommCare can't build an empty form. Add a question to one of its sections.`;
	return [validationError("EMPTY_FORM", "form", message, baseLocation(ctx))];
}

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
 * screen of its own (`FormEntryController` never raises
 * `EVENT_PROMPT_NEW_REPEAT` inside a field-list host), so the repeat would
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

function caseWriteAdmission(
	ctx: FormContext,
	inventory: CaseWriteInventory,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const bucketScope = (
		bucket: CaseWriteInventory["buckets"][number],
	): string =>
		bucket.kind === "primary"
			? `the primary ${bucket.caseType} case`
			: bucket.repeatId
				? `the ${bucket.caseType} child case inside repeat "${bucket.repeatId}"`
				: `the ${bucket.caseType} child case`;

	for (const issue of caseWriteAdmissionIssues(inventory)) {
		if (issue.kind === "no-case-action") {
			const { writer } = issue;
			errors.push(
				validationError(
					"CASE_WRITE_NO_CASE_ACTION",
					"form",
					`"${ctx.formName}" gives field "${writer.fieldId}" a case destination (${writer.caseType}.${writer.property}), but this form emits no case action. Remove the case destination, or move the field to a registration, followup, or close form in a module with a case type.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{ caseType: writer.caseType, property: writer.property },
				),
			);
			continue;
		}
		if (
			issue.kind === "destination-type-unknown" ||
			issue.kind === "destination-not-direct-child"
		) {
			const { writer } = issue;
			const unknown = issue.kind === "destination-type-unknown";
			errors.push(
				validationError(
					unknown ? "CASE_WRITE_UNKNOWN_TYPE" : "CASE_WRITE_NOT_DIRECT_CHILD",
					"form",
					unknown
						? `"${ctx.formName}" gives field "${writer.fieldId}" a case destination on unknown type "${writer.caseType}". Add that case type, or point the field at the module's own case type or one of its exact direct child types.`
						: `"${ctx.formName}" gives field "${writer.fieldId}" a case destination on "${writer.caseType}", but a field can save only to the module's own case type or one of its exact direct child types. Choose an eligible destination or clear the case destination.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{ caseType: writer.caseType, property: writer.property },
				),
			);
			continue;
		}
		if (
			issue.kind === "usercase-property-undeclared" ||
			issue.kind === "usercase-property-managed"
		) {
			const { writer } = issue;
			const undeclared = issue.kind === "usercase-property-undeclared";
			errors.push(
				validationError(
					undeclared
						? "USERCASE_WRITE_UNDECLARED_PROPERTY"
						: "USERCASE_WRITE_MANAGED_PROPERTY",
					"form",
					undeclared
						? `"${ctx.formName}" saves field "${writer.fieldId}" to "${writer.property}" on the worker's own record, but no worker detail by that name exists. Add it under Worker information in App setup, or point the field at one that is already there.`
						: `"${ctx.formName}" saves field "${writer.fieldId}" to "${writer.property}" on the worker's own record. Nova keeps that one in step with the worker's profile, so an answer saved there is replaced the next time that worker changes. Save to a worker detail you added under Worker information instead.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{ caseType: writer.caseType, property: writer.property },
				),
			);
			continue;
		}
		if (issue.kind === "usercase-writer-in-repeat") {
			const { writer } = issue;
			errors.push(
				validationError(
					"USERCASE_FIELD_IN_REPEAT",
					"form",
					`"${ctx.formName}" has field "${writer.fieldId}" inside repeat "${writer.repeatId}" saving to the worker's own record. One form writes one worker record, so every iteration would compete for the same slot. Move the field out of the repeat.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{ property: writer.property, repeatId: writer.repeatId ?? "" },
				),
			);
			continue;
		}
		if (issue.kind === "reserved-property") {
			const { writer } = issue;
			errors.push(
				validationError(
					"RESERVED_CASE_PROPERTY",
					"form",
					`"${ctx.formName}" saves field "${writer.fieldId}" to case property "${writer.property}", which is reserved for case mechanics. Use Nova's "case_name" for the display name, or choose a custom property.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{ reservedName: writer.property },
				),
			);
			continue;
		}
		if (issue.kind === "capture-standard-property") {
			const { writer } = issue;
			errors.push(
				validationError(
					"CAPTURE_CASE_WRITE_STANDARD_PROPERTY",
					"form",
					`"${ctx.formName}" saves the ${writer.fieldKind} field "${writer.fieldId}" to "${writer.property}", which CommCare keeps as the case's own ${writer.property === "case_name" ? "name" : "external id"}. Save the attachment to a property of its own instead.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{ property: writer.property, questionId: writer.fieldId },
				),
			);
			continue;
		}
		if (issue.kind === "primary-writer-in-repeat") {
			const { writer, bucket } = issue;
			errors.push(
				validationError(
					"PRIMARY_CASE_FIELD_IN_REPEAT",
					"form",
					`"${ctx.formName}" has field "${writer.fieldId}" inside repeat "${writer.repeatId}" saving to the module's own case type "${bucket.caseType}". A form creates or updates one primary case, so move the field out of the repeat or save it to an exact direct child case type.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{
						fieldId: writer.fieldId,
						repeatId: writer.repeatId ?? "",
						caseType: bucket.caseType,
					},
				),
			);
			continue;
		}
		if (issue.kind === "duplicate-property") {
			const fieldIds = issue.writers.map((writer) => writer.fieldId);
			errors.push(
				validationError(
					"CASE_WRITE_DUPLICATE_PROPERTY",
					"form",
					`"${ctx.formName}" has ${fieldIds.length} fields (${fieldIds.map((id) => `"${id}"`).join(", ")}) all saving property "${issue.property}" on ${bucketScope(issue.bucket)}. One emitted case action can have exactly one ordinary field writer per property. Change or clear the extra case destinations.`,
					{
						...baseLocation(ctx),
						fieldUuid: issue.writers[1]?.fieldUuid,
						fieldId: issue.writers[1]?.fieldId,
					},
					{
						caseType: issue.bucket.caseType,
						property: issue.property,
						fieldIds: fieldIds.join(","),
						...(issue.bucket.repeatId
							? { repeatId: issue.bucket.repeatId }
							: {}),
					},
				),
			);
			continue;
		}
		const duplicate = issue.kind === "create-name-duplicate";
		const names = duplicate ? issue.writers : [];
		errors.push(
			validationError(
				duplicate ? "CASE_CREATE_NAME_DUPLICATE" : "CASE_CREATE_NAME_MISSING",
				"form",
				duplicate
					? `"${ctx.formName}" creates ${bucketScope(issue.bucket)}, but ${names.length} fields (${names.map((writer) => `"${writer.fieldId}"`).join(", ")}) write its "case_name". Every case-create action needs exactly one name writer. Keep one destination and change or clear the others.`
					: `"${ctx.formName}" creates ${bucketScope(issue.bucket)}, but no field writes its "case_name". Every case-create action needs exactly one name writer. Set one field's case destination to type "${issue.bucket.caseType}", property "case_name".`,
				{
					...baseLocation(ctx),
					fieldUuid: names[1]?.fieldUuid,
					fieldId: names[1]?.fieldId,
				},
				{
					caseType: issue.bucket.caseType,
					writerCount: String(names.length),
					...(issue.bucket.repeatId ? { repeatId: issue.bucket.repeatId } : {}),
				},
			),
		);
	}

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
			const formFieldUuids = collectFieldUuids(doc, ctx.formUuid);
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

/**
 * Comprehensive post-submit navigation validation.
 *
 * Validates every post_submit destination against the form's context.
 */
function postSubmitValidation(
	form: Form,
	ctx: FormContext,
	mod: Module,
): ValidationError[] {
	if (!form.postSubmit) return [];
	const errors: ValidationError[] = [];
	const loc = baseLocation(ctx);
	const dest = form.postSubmit;

	const valid = (POST_SUBMIT_DESTINATIONS as readonly string[]).includes(dest);
	if (!valid) {
		errors.push(
			validationError(
				"INVALID_POST_SUBMIT",
				"form",
				`"${ctx.formName}" has post_submit set to "${dest}", which isn't a recognized destination. Use one of: "app_home", "module", "previous".`,
				loc,
				{ value: String(dest) },
			),
		);
		return errors;
	}

	// module: invalid when module is display-only (no form list to return to).
	if (dest === "module" && mod.caseListOnly) {
		errors.push(
			validationError(
				"POST_SUBMIT_MODULE_CASE_LIST_ONLY",
				"form",
				`"${ctx.formName}" has post_submit set to "module", but "${ctx.moduleName}" is case-list-only and has no form list to return to. Use "previous" or "app_home" instead.`,
				loc,
			),
		);
	}

	return errors;
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
function projectionContextFor(doc: BlueprintDoc): FormLinkProjectionContext {
	const held = projectionContexts.get(doc);
	if (held !== undefined) return held;
	const built = formLinkProjectionContext(doc);
	projectionContexts.set(doc, built);
	return built;
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
 *     projection gives it the exclusive guard `not(<earlier>)`, which an
 *     unconditional earlier link makes `not(true)`: it can never fire, so
 *     the author meant something else.
 *   - `FORM_LINK_NO_FALLBACK` — the last link is conditional and the form
 *     has no EXPLICIT `postSubmit`. The form-type default is what a form
 *     does with no links at all, not a destination the author chose for
 *     "none of these matched"; a terminal unconditional link is the
 *     exhaustive else and satisfies the rule by itself.
 *   - `FORM_LINK_DATUMS_INCOMPLETE` — a form target needs a case the link
 *     cannot supply. The runtime does NOT prompt for it: HQ's
 *     `_get_datums_matched_to_source` yields an unmatched selection datum
 *     as a self-named session ref, Core evaluates that to "" at push, and
 *     the person lands in the target form with an empty case id. Nova
 *     refuses the link instead. With explicit datums, every selection datum
 *     of the target must be named.
 *   - `FORM_LINK_DATUM_UNUSED` — an explicit datum the target never reads
 *     (HQ's manual matcher iterates the TARGET's datums, so the name is
 *     dropped silently on upload).
 *
 * The datum rules project the links, which is defined only for session-scope
 * expressions whose targets exist; the other findings cover every document
 * where it is not, so the rule stays total. Cycle detection across forms
 * runs at app scope in `circularFormLinks`.
 */
function formLinkValidation(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormContext,
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

	// Conditional = prints to non-empty XPath. The friendly projection answers
	// that without lowering to the wire (which is undefined for a form-local
	// read the deep validator reports separately).
	const printContext = xpathPrintContext(doc);
	const isConditional = (link: FormLink): boolean =>
		formLinkIsConditional(link, (expression) =>
			projectXPath(expression, printContext).text.trim(),
		);

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
				`"${ctx.formName}"'s form links all have conditions and the form sets no post_submit, so nothing says where people go when no condition matches. Set post_submit to "app_home", "module", or "previous", or end the list with an unconditional link.`,
				loc,
			),
		);
	}

	// The projection is defined only where every target exists, every
	// expression is session-scope, and every form it reads has buildable
	// actions; each "no" is a finding another rule owns.
	if (
		!targetsResolve ||
		!formLinksProjectable(doc, links) ||
		!formLinkActionsBuildable(doc, ctx.formUuid, links)
	) {
		return errors;
	}
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
						? `"${ctx.formName}" ${label} cannot carry the case its destination needs (${datumIds}): nothing this form opens or creates matches it, so the destination would open with no case selected and no way to pick one. Name the value to carry on the link, point it at a form this one can hand a case to, or link to the module's form list so the person picks a case there.`
						: `"${ctx.formName}" ${label} names values to carry but leaves out one its destination needs (${datumIds}). Name every value the destination form asks for.`,
					loc,
					{ ...details, datumIds },
				),
			);
		}
		for (const datumName of link.unused) {
			errors.push(
				validationError(
					"FORM_LINK_DATUM_UNUSED",
					"form",
					`"${ctx.formName}" ${label} carries a value named "${datumName}" that its destination never reads, so CommCare drops it. Remove it, or rename it to a value the destination needs.`,
					loc,
					{ ...details, datumName },
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

	// A Connect id becomes an XML element name in the emitted form (the
	// wrapper `<id vellum:role=...>` and the Connect-namespaced `id=`
	// attribute) and lands in a Connect DB slug column (tightest is
	// `varchar(50)`). `connectIdError` is the single authority on what makes
	// an id valid (legal element name AND within length) — the same helper
	// the field-level commit guard uses, so the field and the server never
	// disagree. We reject a bad id here rather than silently fixing it.
	//
	// Stored blocks always carry ids. `connectIdError` returns one reason; we pick the
	// structured code from the cheap element-name check (a char failure →
	// INVALID_FORMAT, otherwise the only remaining failure is length →
	// TOO_LONG) and wrap the reason with the form/kind context.
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
	for (const { label, id } of connectIds) {
		const reason = connectIdError(id);
		if (!reason) continue;
		const code = XML_ELEMENT_NAME_REGEX.test(id)
			? "CONNECT_ID_TOO_LONG"
			: "CONNECT_ID_INVALID_FORMAT";
		errors.push(
			validationError(
				code,
				"form",
				`Connect ${label} id in "${ctx.formName}": ${reason}`,
				loc,
				{ connectId: id },
			),
		);
	}

	// Per-XPath checks for the Connect expressions the bind emitter
	// renders as `calculate="…"`. Each value gets two checks:
	//   1. Explicit empty string → `CONNECT_EMPTY_XPATH`. CCHQ's build
	//      pipeline rejects `<bind … calculate=""/>` outright. `undefined`
	//      is NOT an error — the wire layer
	//      (`lib/commcare/xform/builder.ts`) substitutes the canonical
	//      defaults for missing `entity_id` / `entity_name` / `user_score`.
	//      Only the explicit-empty-string state is a smell, indicating
	//      something wrote a deliberate blank.
	//   2. Unquoted string literal → `CONNECT_UNQUOTED_XPATH`. Same shape
	//      as the existing field-level rule: a bare word without quotes
	//      parses as an XPath identifier, not a literal value.
	type ConnectXPath = { label: string; expr: string | undefined };
	const connectXPaths: ConnectXPath[] = [];
	const projectConnectXPath = (
		slot: "assessment_user_score" | "deliver_entity_id" | "deliver_entity_name",
	): string | undefined => {
		const expression = formExpressionValue(form, slot);
		return expression === undefined
			? undefined
			: projectXPath(expression, xpathPrintContext(doc)).text;
	};
	if (isConnectLearnConfig(form.connect) && form.connect.assessment) {
		// `user_score` is optional in the domain — an absent value skips both
		// checks below (the wire layer substitutes the canonical default),
		// same as the deliver entity slots. AST-stored values project to
		// their printed text through the shared accessor.
		connectXPaths.push({
			label: "Connect assessment user_score",
			expr: projectConnectXPath("assessment_user_score"),
		});
	}
	if (!isConnectLearnConfig(form.connect) && form.connect.deliver_unit) {
		connectXPaths.push(
			{
				label: "Connect deliver entity_id",
				expr: projectConnectXPath("deliver_entity_id"),
			},
			{
				label: "Connect deliver entity_name",
				expr: projectConnectXPath("deliver_entity_name"),
			},
		);
	}
	for (const { label, expr } of connectXPaths) {
		if (expr === undefined) continue; // wire layer fills the default
		if (expr.trim().length === 0) {
			errors.push(
				validationError(
					"CONNECT_EMPTY_XPATH",
					"form",
					`"${ctx.formName}" ${label} is empty. CommCare HQ rejects builds with empty calculate expressions on Connect bindings. Set a valid XPath or remove the sub-config.`,
					loc,
				),
			);
			continue;
		}
		const bare = detectUnquotedStringLiteral(expr);
		if (bare) {
			errors.push(
				validationError(
					"CONNECT_UNQUOTED_XPATH",
					"form",
					`"${ctx.formName}" ${label} has "${bare}" without quotes. This looks like a string value, not an XPath expression. Wrap it in single quotes: '${bare}'.`,
					loc,
				),
			);
		}
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

/** Find typed case-property atoms a registration form cannot read. */
function invalidRegistrationCaseRefs(
	value: XPathExpression | ProseTemplate,
	createdCaseType: string | undefined,
): string[] {
	const invalid: string[] = [];
	// The general schema validator reports malformed carriers separately. Keep
	// this semantic rule total when it receives a damaged or pre-schema doc.
	if (
		typeof value !== "object" ||
		value === null ||
		!Array.isArray(value.parts)
	) {
		return invalid;
	}
	for (const part of value.parts) {
		if (typeof part !== "object" || part === null) continue;
		if (part.kind !== "case-ref") continue;
		if (part.caseType === createdCaseType && part.property === "case_id") {
			continue;
		}
		invalid.push(`#${part.caseType}/${part.property}`);
	}
	return invalid;
}

/**
 * On a registration form, the case the form creates does not exist in
 * `casedb` at form-init — `casedb` only sees it after the
 * post-submission case transaction lands. A case-create entry declares no
 * loaded-case session datum, so reading a property from the new case during
 * form initialization cannot resolve.
 *
 * One exception: the typed `case-ref` for the created case type's `case_id`
 * points to the newly allocated id populated at `xforms-ready`.
 *
 * Every other case-property atom is invalid: the property is being set now,
 * not read from a pre-existing case. The fix is a typed form-field reference.
 *
 * The reference-slot registry supplies every field/form XPath or prose
 * carrier, including repeat cardinality and Connect bindings.
 */
function caseHashtagOnCreateForm(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormContext,
): ValidationError[] {
	if (form.type !== "registration") return [];
	const errors: ValidationError[] = [];
	const loc = baseLocation(ctx);
	const createdCaseType = doc.modules[ctx.moduleUuid]?.caseType;

	/**
	 * Emit one error per offending typed case atom. The friendly projection
	 * names the exact reference the author sees.
	 */
	const flag = (
		surface: string,
		where: string,
		value: XPathExpression | ProseTemplate,
	) => {
		for (const hashtag of invalidRegistrationCaseRefs(value, createdCaseType)) {
			errors.push(
				validationError(
					"CASE_HASHTAG_ON_CREATE_FORM",
					"form",
					`"${ctx.formName}" references "${hashtag}" in ${surface}${where ? ` of ${where}` : ""}. On a registration form the case being created doesn't exist yet, so case-property references can't resolve. Reference the form question instead. The only valid case reference is the created case type's "case_id", it points to the newly allocated case id.`,
					loc,
					{ hashtag, surface },
				),
			);
		}
	};

	const walkFields = (parentUuid: Uuid): void => {
		for (const uuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[uuid];
			if (!field) continue;
			const fieldRef = `field "${field.id}"`;
			for (const slot of fieldReferenceSlotsFor(
				field.kind,
				field.kind === "repeat" ? field.repeat_mode : undefined,
			)) {
				if (slot.kind !== "xpath-ast" && slot.kind !== "prose") continue;
				for (const entry of readSlotValues(field, slot.path)) {
					flag(
						slot.slot,
						fieldRef,
						entry.value as XPathExpression | ProseTemplate,
					);
				}
			}
			if (doc.fieldOrder[uuid] !== undefined) walkFields(uuid);
		}
	};
	walkFields(ctx.formUuid);

	for (const slot of FORM_REFERENCE_SLOTS) {
		if (slot.kind !== "xpath-ast") continue;
		for (const entry of readSlotValues(form, slot.path)) {
			flag(slot.slot, "", entry.value as XPathExpression);
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
		);
	}
	errors.push(...closeConditionValidation(doc, form, ctx, mod));
	errors.push(...duplicateFieldIds(doc, ctx));
	errors.push(...caseWriteAdmission(ctx, caseWriteInventory));
	errors.push(...tooManyAttachments(doc, ctx));
	errors.push(...casePropertyBadFormat(ctx, caseWriteInventory));
	errors.push(...casePropertyTooLong(ctx, caseWriteInventory));
	errors.push(...postSubmitValidation(form, ctx, mod));
	errors.push(
		...formLinkSelectionCardinality(doc, form, mod, ctx, caseWriteInventory),
	);
	errors.push(...formLinkValidation(doc, form, ctx));
	errors.push(...connectValidation(doc, form, ctx));
	errors.push(...caseHashtagOnCreateForm(doc, form, ctx));
	errors.push(
		...validateCaseOperations(doc, formUuid, moduleUuid, lookupTables),
	);
	errors.push(
		...multiSelectFormSemantics(doc, form, mod, ctx, caseWriteInventory),
	);

	return errors;
}
