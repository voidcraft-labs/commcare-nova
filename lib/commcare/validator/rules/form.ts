/**
 * Form-level validation rules.
 *
 * Each rule receives the normalized `BlueprintDoc`, the form entity, and its
 * `formUuid` (plus the owning module for rules that need sibling context).
 * Case configuration is derived once per form and threaded through to rules
 * that depend on it — `deriveCaseConfig` operates directly on the doc, so
 * there's no wire-shape adapter in this file.
 */

import {
	CASE_PROPERTY_REGEX,
	MAX_CASE_PROPERTY_LENGTH,
	MAX_FORM_ATTACHMENTS,
	MEDIA_FIELD_KINDS,
	RESERVED_CASE_PROPERTIES,
	XML_ELEMENT_NAME_REGEX,
} from "@/lib/commcare";
import { connectIdError } from "@/lib/commcare/connectSlugs";
import {
	type DerivedCaseConfig,
	deriveCaseConfig,
} from "@/lib/commcare/deriveCaseConfig";
import { readFieldString } from "@/lib/commcare/fieldProps";
import { detectUnquotedStringLiteral } from "@/lib/commcare/xpath";
import {
	type BlueprintDoc,
	type Field,
	FORM_REFERENCE_SLOTS,
	type Form,
	fieldReferenceSlotsFor,
	formExpressionValue,
	type Module,
	POST_SUBMIT_DESTINATIONS,
	type ProseTemplate,
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

function collectFieldIds(doc: BlueprintDoc, parentUuid: Uuid): string[] {
	const ids: string[] = [];
	const walk = (uuid: Uuid) => {
		for (const childUuid of doc.fieldOrder[uuid] ?? []) {
			const field = doc.fields[childUuid];
			if (!field) continue;
			ids.push(field.id);
			if (doc.fieldOrder[childUuid] !== undefined) walk(childUuid);
		}
	};
	walk(parentUuid);
	return ids;
}

/**
 * Find a field anywhere under `parentUuid` (recurses through containers)
 * whose `id` matches. Returns the first match or `undefined`.
 */
function findFieldById(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	id: string,
): Field | undefined {
	const stack: Uuid[] = [...(doc.fieldOrder[parentUuid] ?? [])];
	while (stack.length > 0) {
		const uuid = stack.pop();
		if (!uuid) break;
		const field = doc.fields[uuid];
		if (!field) continue;
		if (field.id === id) return field;
		const children = doc.fieldOrder[uuid];
		if (children) stack.push(...children);
	}
	return undefined;
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
	if (order.length > 0) return [];
	return [
		validationError(
			"EMPTY_FORM",
			"form",
			`"${ctx.formName}" in "${ctx.moduleName}" has no fields. CommCare can't build an empty form — add at least one field.`,
			baseLocation(ctx),
		),
	];
}

function noCaseNameField(
	form: Form,
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (form.type === "registration" && !caseConfig.case_name_field) {
		return [
			validationError(
				"NO_CASE_NAME_FIELD",
				"form",
				`"${ctx.formName}" is a registration form but none of its fields has id "case_name". Every new case needs a name — add a text field with id "case_name" and \`case_property_on\` set to the module's case type.`,
				baseLocation(ctx),
			),
		];
	}
	return [];
}

function caseNameFieldMissing(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (form.type !== "registration" || !caseConfig.case_name_field) return [];
	const ids = collectFieldIds(doc, ctx.formUuid);
	if (ids.includes(caseConfig.case_name_field)) return [];
	return [
		validationError(
			"CASE_NAME_FIELD_MISSING",
			"form",
			`"${ctx.formName}" expects a field with id "${caseConfig.case_name_field}" for the case name, but no such field exists. Either add this field or rename an existing one.`,
			baseLocation(ctx),
		),
	];
}

function reservedCaseProperty(
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (!caseConfig.case_properties) return [];
	const errors: ValidationError[] = [];
	for (const { case_property: prop } of caseConfig.case_properties) {
		if (RESERVED_CASE_PROPERTIES.has(prop) && prop !== "case_name") {
			errors.push(
				validationError(
					"RESERVED_CASE_PROPERTY",
					"form",
					`"${ctx.formName}" saves to case property "${prop}", which is a reserved name in CommCare (used internally for case tracking). Rename the field to something like "${prop}_value" or "case_${prop}" instead.`,
					baseLocation(ctx),
					{ reservedName: prop },
				),
			);
		}
	}
	return errors;
}

function casePropertyMissingField(
	doc: BlueprintDoc,
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (!caseConfig.case_properties) return [];
	const errors: ValidationError[] = [];
	const ids = collectFieldIds(doc, ctx.formUuid);
	for (const {
		case_property: prop,
		question_id: qId,
	} of caseConfig.case_properties) {
		if (!ids.includes(qId)) {
			errors.push(
				validationError(
					"CASE_PROPERTY_MISSING_FIELD",
					"form",
					`"${ctx.formName}" maps case property "${prop}" to field "${qId}", but that field doesn't exist in this form. Either add the field or remove the case property mapping.`,
					baseLocation(ctx),
				),
			);
		}
	}
	return errors;
}

function mediaCaseProperty(
	doc: BlueprintDoc,
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (!caseConfig.case_properties) return [];
	const errors: ValidationError[] = [];
	for (const {
		case_property: prop,
		question_id: qId,
	} of caseConfig.case_properties) {
		const field = findFieldById(doc, ctx.formUuid, qId);
		if (field && MEDIA_FIELD_KINDS.has(field.kind)) {
			errors.push(
				validationError(
					"MEDIA_CASE_PROPERTY",
					"form",
					`"${ctx.formName}" tries to save the ${field.kind} field "${qId}" as case property "${prop}". Attachments (photos, audio, video, signatures, files) can't be stored as case properties — CommCare carries them through its attachment system instead. Clear \`case_property_on\` on this field.`,
					baseLocation(ctx),
					{ property: prop, questionId: qId },
				),
			);
		}
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

function casePreloadMissingField(
	doc: BlueprintDoc,
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (!caseConfig.case_preload) return [];
	const errors: ValidationError[] = [];
	const ids = collectFieldIds(doc, ctx.formUuid);
	for (const {
		question_id: qId,
		case_property: prop,
	} of caseConfig.case_preload) {
		if (!ids.includes(qId)) {
			errors.push(
				validationError(
					"CASE_PRELOAD_MISSING_FIELD",
					"form",
					`"${ctx.formName}" tries to preload case property "${prop}" into field "${qId}", but that field doesn't exist. The preload needs a matching field to receive the data.`,
					baseLocation(ctx),
				),
			);
		}
	}
	return errors;
}

function casePreloadReserved(
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (!caseConfig.case_preload) return [];
	const errors: ValidationError[] = [];
	for (const { case_property: prop } of caseConfig.case_preload) {
		if (RESERVED_CASE_PROPERTIES.has(prop)) {
			errors.push(
				validationError(
					"CASE_PRELOAD_RESERVED",
					"form",
					`"${ctx.formName}" tries to preload reserved property "${prop}". CommCare reserves this name for internal use. Use a custom property name instead.`,
					baseLocation(ctx),
				),
			);
		}
	}
	return errors;
}

function duplicateCasePropertyMapping(
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (!caseConfig.case_properties) return [];
	const errors: ValidationError[] = [];
	const seen = new Map<string, string>();
	for (const {
		case_property: prop,
		question_id: qId,
	} of caseConfig.case_properties) {
		const prev = seen.get(prop);
		if (prev && prev !== qId) {
			errors.push(
				validationError(
					"DUPLICATE_CASE_PROPERTY",
					"form",
					`"${ctx.formName}" has two fields ("${prev}" and "${qId}") both saving to case property "${prop}". Each case property can only be updated by one field — rename one of the field IDs so they map to different properties.`,
					baseLocation(ctx),
					{ property: prop, questionId1: prev, questionId2: qId },
				),
			);
		} else {
			seen.set(prop, qId);
		}
	}
	return errors;
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
				`"${ctx.formName}" is a close form but "${ctx.moduleName}" has no case type. Close forms need a case to close — add a case_type to the module or change the form type.`,
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
				`"${ctx.formName}" has post_submit set to "${dest}", which isn't a recognized destination. Use one of: "app_home", "root", "module", "parent_module", "previous".`,
				loc,
				{ value: String(dest) },
			),
		);
		return errors;
	}

	// parent_module: Nova doesn't model root_module yet, so this is always
	// an error. When root_module is added, verify: (1) mod.rootModule exists,
	// (2) the parent module isn't put_in_root.
	if (dest === "parent_module") {
		errors.push(
			validationError(
				"POST_SUBMIT_PARENT_MODULE_UNSUPPORTED",
				"form",
				`"${ctx.formName}" has post_submit set to "parent_module", but "${ctx.moduleName}" has no parent module (parent modules aren't modeled yet). Use "module", "previous", or "app_home" instead.`,
				loc,
			),
		);
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
 * Form-link validation (per-form). Checks empty-link-array, target
 * existence, self-reference, and missing post_submit fallback. Cycle
 * detection across forms runs at app scope in `circularFormLinks`.
 */
function formLinkValidation(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormContext,
): ValidationError[] {
	if (!form.formLinks) return [];
	const errors: ValidationError[] = [];
	const loc = baseLocation(ctx);

	if (form.formLinks.length === 0) {
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

	const hasAnyCondition = form.formLinks.some((l) => l.condition);
	if (hasAnyCondition && !form.postSubmit) {
		errors.push(
			validationError(
				"FORM_LINK_NO_FALLBACK",
				"form",
				`"${ctx.formName}" has conditional form links but no post_submit fallback for when none match. Set post_submit to a destination like "module" or "app_home".`,
				loc,
			),
		);
	}

	for (let lIdx = 0; lIdx < form.formLinks.length; lIdx++) {
		const link = form.formLinks[lIdx];
		const conditionText = link.condition
			? projectXPath(link.condition, xpathPrintContext(doc)).text
			: undefined;
		const linkLabel = conditionText
			? `form link ${lIdx + 1} (condition: "${conditionText.slice(0, 40)}${conditionText.length > 40 ? "..." : ""}")`
			: `form link ${lIdx + 1}`;

		if (link.target.type === "form") {
			const targetMod = doc.modules[link.target.moduleUuid];
			const targetForm = doc.forms[link.target.formUuid];
			if (!targetMod) {
				errors.push(
					validationError(
						"FORM_LINK_TARGET_NOT_FOUND",
						"form",
						`"${ctx.formName}" ${linkLabel} targets module ${link.target.moduleUuid}, which doesn't exist.\n\n` +
							`Update the target to reference an existing module.`,
						loc,
					),
				);
			} else if (!targetForm) {
				errors.push(
					validationError(
						"FORM_LINK_TARGET_NOT_FOUND",
						"form",
						`"${ctx.formName}" ${linkLabel} targets form ${link.target.formUuid} in "${targetMod.name}", which doesn't exist.\n\n` +
							`Update the target to reference an existing form.`,
						loc,
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
						`"${ctx.formName}" ${linkLabel} links back to itself, which would loop the user straight back into this form. Point it at the module menu or another form instead.`,
						loc,
					),
				);
			}
		} else {
			const targetMod = doc.modules[link.target.moduleUuid];
			if (!targetMod) {
				errors.push(
					validationError(
						"FORM_LINK_TARGET_NOT_FOUND",
						"form",
						`"${ctx.formName}" ${linkLabel} targets module ${link.target.moduleUuid}, which doesn't exist.\n\n` +
							`Update the target to reference an existing module.`,
						loc,
					),
				);
			}
		}
	}

	return errors;
}

function connectValidation(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormContext,
): ValidationError[] {
	if (!doc.connectType) return [];
	const errors: ValidationError[] = [];
	const loc = baseLocation(ctx);

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

	// A Connect id becomes an XML element name in the emitted form (the
	// wrapper `<id vellum:role=...>` and the Connect-namespaced `id=`
	// attribute) and lands in a Connect DB slug column (tightest is
	// `varchar(50)`). `connectIdError` is the single authority on what makes
	// an id valid (legal element name AND within length) — the same helper
	// the field-level commit guard uses, so the field and the server never
	// disagree. We reject a bad id here rather than silently fixing it.
	//
	// Every source path leaves the id SET: the SA tools autofill or reject
	// (`enforceConnectIds`), the UI seed/restore paths derive
	// (`dedupeRestoredConnectIds`). Nothing downstream supplies a default —
	// the emit resolver (`buildConnectSlugMap`) THROWS on a missing id — so
	// a block that reaches validation id-less is a doc that skipped that
	// enforcement, and the unset id is its own finding (CONNECT_ID_MISSING)
	// rather than a 500 at export. Only the app mode's live kinds are
	// checked for absence, mirroring the resolver (a cross-mode stray never
	// emits, so its missing id breaks nothing).
	//
	// For a SET id, `connectIdError` returns one reason; we pick the
	// structured code from the cheap element-name check (a char failure →
	// INVALID_FORMAT, otherwise the only remaining failure is length →
	// TOO_LONG) and wrap the reason with the form/kind context.
	const liveKindLabels: ReadonlySet<string> =
		doc.connectType === "learn"
			? new Set(["learn-module", "assessment"])
			: new Set(["deliver-unit", "task"]);
	const connectIds: ReadonlyArray<{
		label: string;
		present: boolean;
		id: string | undefined;
	}> = [
		{
			label: "learn-module",
			present: form.connect.learn_module !== undefined,
			id: form.connect.learn_module?.id,
		},
		{
			label: "assessment",
			present: form.connect.assessment !== undefined,
			id: form.connect.assessment?.id,
		},
		{
			label: "deliver-unit",
			present: form.connect.deliver_unit !== undefined,
			id: form.connect.deliver_unit?.id,
		},
		{
			label: "task",
			present: form.connect.task !== undefined,
			id: form.connect.task?.id,
		},
	];
	for (const { label, present, id } of connectIds) {
		if (!id) {
			if (present && liveKindLabels.has(label)) {
				errors.push(
					validationError(
						"CONNECT_ID_MISSING",
						"form",
						`The Connect ${label} block in "${ctx.formName}" has no id. Set one — letters, numbers, and underscores, 50 characters or fewer, unique across the app — via update_form or the form's Connect settings.`,
						loc,
						{ connectKind: label },
					),
				);
			}
			continue;
		}
		const reason = connectIdError(id);
		if (!reason) continue;
		const code = XML_ELEMENT_NAME_REGEX.test(id)
			? "CONNECT_ID_TOO_LONG"
			: "CONNECT_ID_INVALID_FORMAT";
		errors.push(
			validationError(
				code,
				"form",
				`Connect ${label} id in "${ctx.formName}" — ${reason}`,
				loc,
				{ connectId: id },
			),
		);
	}

	if (
		doc.connectType === "learn" &&
		!form.connect.learn_module &&
		!form.connect.assessment
	) {
		errors.push(
			validationError(
				"CONNECT_MISSING_LEARN",
				"form",
				`"${ctx.formName}" is opted into Connect but has neither a learn module nor an assessment. Enable at least one.`,
				loc,
			),
		);
	}
	if (
		doc.connectType === "deliver" &&
		!form.connect.deliver_unit &&
		!form.connect.task
	) {
		errors.push(
			validationError(
				"CONNECT_MISSING_DELIVER",
				"form",
				`"${ctx.formName}" is opted into Connect but has neither a deliver unit nor a task. Enable at least one.`,
				loc,
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
	if (form.connect.assessment) {
		// `user_score` is optional in the domain — an absent value skips both
		// checks below (the wire layer substitutes the canonical default),
		// same as the deliver entity slots. AST-stored values project to
		// their printed text through the shared accessor.
		connectXPaths.push({
			label: "Connect assessment user_score",
			expr: projectConnectXPath("assessment_user_score"),
		});
	}
	if (form.connect.deliver_unit) {
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
					`"${ctx.formName}" ${label} is empty. CommCare HQ rejects builds with empty calculate expressions on Connect bindings — set a valid XPath or remove the sub-config.`,
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
					`"${ctx.formName}" ${label} has "${bare}" without quotes. This looks like a string value, not an XPath expression — wrap it in single quotes: '${bare}'.`,
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
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (!caseConfig.case_properties) return [];
	const errors: ValidationError[] = [];
	for (const { case_property: prop } of caseConfig.case_properties) {
		if (prop === "case_name") continue;
		if (!CASE_PROPERTY_REGEX.test(prop)) {
			errors.push(
				validationError(
					"CASE_PROPERTY_BAD_FORMAT",
					"form",
					`"${ctx.formName}" has case property "${prop}" which isn't a valid identifier. Property names must start with a letter and can only contain letters, digits, underscores, or hyphens. Try renaming it to something like "${prop.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^[^a-zA-Z]/, "q_")}".`,
					baseLocation(ctx),
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
					`"${ctx.formName}" references "${hashtag}" in ${surface}${where ? ` of ${where}` : ""}. On a registration form the case being created doesn't exist yet, so case-property references can't resolve. Reference the form question instead. The only valid case reference is the created case type's "case_id" — it points to the newly allocated case id.`,
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

/**
 * A primary case field — one whose `case_property_on` equals the
 * module's own case type — placed inside a repeat is structurally
 * invalid. A form creates or updates exactly ONE primary case, but a
 * repeat iterates zero or more independent values per iteration —
 * there's no rule to decide which iteration's value "wins" for the
 * primary case property.
 *
 * Both Vellum and CCHQ enforce this invariant upstream. Vellum's
 * per-field case-management section is hidden when any ancestor is a
 * Repeat (`Vellum/src/caseManagement.js::getSectionDisplay`); CCHQ's
 * case-config UI rejects with "Inside the wrong repeat!" when the
 * property's `repeat_context` doesn't match the transaction's (and a
 * primary transaction's `repeat_context` is always empty —
 * `commcare-hq/.../case_config_ui.js::caseProperty.validate`). Nova's
 * authoring layer matches: the error lands in the editor at edit time,
 * not at compile time.
 *
 * Cross-case-type fields (`case_property_on != mod.caseType`) inside a
 * repeat are the supported subcase-creation shape (one new child case
 * per iteration); they're handled by the splice algorithm in
 * `xform/caseBlocks.ts::addCaseBlocks` and never reach this rule.
 *
 * Survey forms carry no case actions — `deriveCaseConfig` returns `{}`
 * for them, so their `case_property_on` annotations never become case
 * properties on the wire. Flagging one would be a false positive (the
 * field has no case effect to conflict with), so survey forms are
 * skipped entirely.
 */
function primaryCaseFieldInRepeat(
	doc: BlueprintDoc,
	ctx: FormContext,
	mod: Module,
): ValidationError[] {
	if (!mod.caseType) return [];
	if (doc.forms[ctx.formUuid].type === "survey") return [];
	const errors: ValidationError[] = [];
	const walk = (parentUuid: Uuid, repeatAncestor: string | undefined): void => {
		for (const uuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[uuid];
			if (!field) continue;
			const casePropertyOn = readFieldString(field, "case_property_on", doc);
			if (repeatAncestor && casePropertyOn === mod.caseType) {
				errors.push(
					validationError(
						"PRIMARY_CASE_FIELD_IN_REPEAT",
						"form",
						`"${ctx.formName}" has field "${field.id}" inside repeat "${repeatAncestor}" saving to the module's own case type "${mod.caseType}". A form creates or updates one primary case, but a repeat captures zero or more independent values per iteration — they can't coexist. Either move "${field.id}" out of the repeat (so its value applies to the parent case), or change \`case_property_on\` to a child case type (so each iteration creates a child case).`,
						baseLocation(ctx),
						{ fieldId: field.id, repeatId: repeatAncestor },
					),
				);
			}
			if (doc.fieldOrder[uuid] !== undefined) {
				walk(uuid, field.kind === "repeat" ? field.id : repeatAncestor);
			}
		}
	};
	walk(ctx.formUuid, undefined);
	return errors;
}

/**
 * Mirror of the primary case's `NO_CASE_NAME_FIELD` rule for child
 * cases. Every child-case bucket — derived by
 * `deriveCaseConfig::deriveChildCases` from `(case_property_on,
 * repeat_ancestor_path)` — needs a field with id `case_name` in that
 * scope so the new case has a display name. Without this rule, a
 * missing `case_name` would either ship a nameless case to CommCare
 * or silently re-purpose an unrelated field; the message names the
 * case type AND (when applicable) the repeat the bucket lives inside.
 */
function childCaseNoNameField(
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (!caseConfig.child_cases || caseConfig.child_cases.length === 0) return [];
	const errors: ValidationError[] = [];
	for (const child of caseConfig.child_cases) {
		if (child.case_name_field) continue;
		// Author-facing scope label uses the bare repeat id (`kids`), not the
		// wire XPath (`/data/group_a/kids/item`). The wire path is correct
		// emission data but the wrong vocabulary for an authoring error: the
		// user named the repeat `kids` in the editor and that's what should
		// appear in quotes. The bare id travels alongside `repeat_context`
		// on `DerivedChildCase` for exactly this reason.
		const scope = child.repeat_ancestor_id
			? ` inside repeat "${child.repeat_ancestor_id}"`
			: "";
		errors.push(
			validationError(
				"CHILD_CASE_NO_NAME_FIELD",
				"form",
				`"${ctx.formName}" creates a child case of type "${child.case_type}"${scope} but no field at that scope has id "case_name". Every new case needs a name — add a text field with id "case_name" and \`case_property_on: "${child.case_type}"\`${scope}.`,
				baseLocation(ctx),
				{
					caseType: child.case_type,
					...(child.repeat_ancestor_id
						? { repeatId: child.repeat_ancestor_id }
						: {}),
				},
			),
		);
	}
	return errors;
}

function casePropertyTooLong(
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (!caseConfig.case_properties) return [];
	const errors: ValidationError[] = [];
	for (const { case_property: prop } of caseConfig.case_properties) {
		if (prop.length > MAX_CASE_PROPERTY_LENGTH) {
			errors.push(
				validationError(
					"CASE_PROPERTY_TOO_LONG",
					"form",
					`"${ctx.formName}" has case property "${prop.slice(0, 40)}..." which is ${prop.length} characters long. CommCare limits property names to ${MAX_CASE_PROPERTY_LENGTH} characters. Use a shorter, more concise name.`,
					baseLocation(ctx),
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

	// `primaryCaseFieldInRepeat` runs BEFORE `deriveCaseConfig`-derived
	// rules so a primary-case field misplaced inside a repeat shows up as
	// its own error rather than silently propagating through the
	// derivation. The derivation itself can't tell the misplacement from
	// an intentional non-repeat primary-case field (the walker just bucks
	// based on `(case_property_on, repeatAncestor)`), so the rule fires
	// against the offending field independently.
	const primaryInRepeatErrors = primaryCaseFieldInRepeat(doc, ctx, mod);

	const caseConfig = deriveCaseConfig(doc, formUuid, mod.caseType, form.type);

	const errors: ValidationError[] = [];
	errors.push(...emptyForm(doc, form, ctx));
	errors.push(...formDisplayCondition(doc, formUuid, moduleUuid, lookupTables));
	if (lookupTables !== undefined) {
		errors.push(
			...validateLookupOptionsSources(doc, formUuid, moduleUuid, lookupTables),
		);
	}
	errors.push(...closeConditionValidation(doc, form, ctx, mod));
	errors.push(...duplicateFieldIds(doc, ctx));
	errors.push(...primaryInRepeatErrors);
	errors.push(...noCaseNameField(form, ctx, caseConfig));
	errors.push(...caseNameFieldMissing(doc, form, ctx, caseConfig));
	errors.push(...reservedCaseProperty(ctx, caseConfig));
	errors.push(...casePropertyMissingField(doc, ctx, caseConfig));
	errors.push(...mediaCaseProperty(doc, ctx, caseConfig));
	errors.push(...tooManyAttachments(doc, ctx));
	errors.push(...casePreloadMissingField(doc, ctx, caseConfig));
	errors.push(...casePreloadReserved(ctx, caseConfig));
	errors.push(...duplicateCasePropertyMapping(ctx, caseConfig));
	errors.push(...casePropertyBadFormat(ctx, caseConfig));
	errors.push(...casePropertyTooLong(ctx, caseConfig));
	errors.push(...postSubmitValidation(form, ctx, mod));
	errors.push(...formLinkValidation(doc, form, ctx));
	errors.push(...connectValidation(doc, form, ctx));
	errors.push(...caseHashtagOnCreateForm(doc, form, ctx));
	errors.push(...childCaseNoNameField(ctx, caseConfig));
	errors.push(
		...validateCaseOperations(doc, formUuid, moduleUuid, lookupTables),
	);

	return errors;
}
