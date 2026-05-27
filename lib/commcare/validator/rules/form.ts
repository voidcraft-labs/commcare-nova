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
import { detectUnquotedStringLiteral, parser } from "@/lib/commcare/xpath";
import {
	type BlueprintDoc,
	type Field,
	type Form,
	type Module,
	POST_SUBMIT_DESTINATIONS,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../errors";

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Domain field-tree walker: collect every field.id under `parentUuid`,
 * including descendants in containers. Used by rules that need to check
 * membership — "does a field with this id exist in this form?"
 */
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
					`"${ctx.formName}" tries to save the ${field.kind} field "${qId}" as case property "${prop}". Media files (images, audio, video, signatures) can't be stored as case properties — they're handled separately by CommCare's attachment system. Clear \`case_property_on\` on this field.`,
					baseLocation(ctx),
					{ property: prop, questionId: qId },
				),
			);
		}
	}
	return errors;
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

function registrationNoCaseProperties(
	form: Form,
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
	mod: Module,
): ValidationError[] {
	if (form.type !== "registration" || !mod.caseType) return [];
	if (!caseConfig.case_properties || caseConfig.case_properties.length === 0) {
		return [
			validationError(
				"REGISTRATION_NO_CASE_PROPS",
				"form",
				`"${ctx.formName}" is a registration form but none of its fields save data to the "${mod.caseType}" case. A registration form should capture information about the new case. Set \`case_property_on\` to "${mod.caseType}" on fields whose answers should be saved to the case.`,
				baseLocation(ctx),
			),
		];
	}
	return [];
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
			const ids = collectFieldIds(doc, ctx.formUuid);
			if (!ids.includes(cc.field)) {
				errors.push(
					validationError(
						"CLOSE_CONDITION_FIELD_NOT_FOUND",
						"form",
						`"${ctx.formName}" has close_condition checking field "${cc.field}", but no field with that ID exists in the form. Either add the field or update close_condition to reference an existing one.`,
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
				`"${ctx.formName}" has post_submit set to "${dest}", which is not a recognized destination.\n\n` +
					`The valid options are:\n` +
					`  "app_home"       — Navigate to the app home screen\n` +
					`  "root"           — Navigate to the first menu (module select)\n` +
					`  "module"         — Navigate back to this module's form list\n` +
					`  "parent_module"  — Navigate to the parent module's menu\n` +
					`  "previous"       — Navigate to the screen before this form`,
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
				`"${ctx.formName}" has post_submit set to "parent_module", but "${ctx.moduleName}" doesn't have a parent module.\n\n` +
					`"parent_module" navigates to the parent module's menu after form submission. ` +
					`This requires the module to be nested under another module (a feature that isn't configured here). ` +
					`In the meantime, this will behave the same as "module" (navigating back to "${ctx.moduleName}").\n\n` +
					`If you intended a different destination, the options are:\n` +
					`  "module"    — Stay in "${ctx.moduleName}" (same behavior, explicit)\n` +
					`  "previous"  — Go back to where the user was before this form\n` +
					`  "app_home"  — Go to the app home screen`,
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
				`"${ctx.formName}" has post_submit set to "module", but "${ctx.moduleName}" is a case-list-only module with no form list to navigate to.\n\n` +
					`After submitting this form, the user would land on an empty module menu. ` +
					`Consider using "previous" to return the user to where they were, or "app_home" to go home.`,
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
				`"${ctx.formName}" has form_links set to an empty array.\n\n` +
					`form_links is meant to hold one or more navigation links to other forms or modules. ` +
					`An empty array has no effect — either add links or remove the form_links field entirely.\n\n` +
					`Without form_links, the form will use its post_submit destination ("${form.postSubmit ?? "form-type default"}").`,
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
				`"${ctx.formName}" has conditional form links but no post_submit fallback.\n\n` +
					`When form links have XPath conditions, CommCare evaluates them after submission. ` +
					`If none of the conditions match, the user needs somewhere to go — that's what post_submit provides.\n\n` +
					`Set post_submit to a destination like "module" or "app_home" so there's always a valid navigation path.`,
				loc,
			),
		);
	}

	for (let lIdx = 0; lIdx < form.formLinks.length; lIdx++) {
		const link = form.formLinks[lIdx];
		const linkLabel = link.condition
			? `form link ${lIdx + 1} (condition: "${link.condition.slice(0, 40)}${link.condition.length > 40 ? "..." : ""}")`
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
						`"${ctx.formName}" ${linkLabel} links back to itself.\n\n` +
							`After submitting this form, the user would immediately re-enter the same form. ` +
							`This creates a confusing loop. If you need the user to fill this form again, ` +
							`consider linking to the module menu instead so they can choose to re-enter.`,
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

	// A Connect-typed app expects every form to carry a `connect` block —
	// the per-form sub-config is what feeds `<learn:module>` / `<deliver>`
	// markers into the CCZ that Connect's sync endpoints scan. A missing
	// block silently strips the form from Connect's view; CCHQ accepts the
	// upload but the opportunity gets stuck without payment units. Flag it
	// here so the validator catches the autobuild miss at the same gate as
	// every other surface (interactive build, MCP edit, manual import).
	if (!form.connect) {
		const guidance =
			doc.connectType === "learn"
				? "Add a learn_module (educational content), an assessment (quiz/test), or both via update_form."
				: "Add a deliver_unit and/or task via update_form.";
		errors.push(
			validationError(
				"CONNECT_FORM_MISSING_BLOCK",
				"form",
				`"${ctx.formName}" is in a Connect ${doc.connectType} app but has no Connect configuration. ${guidance}`,
				loc,
			),
		);
		// Skip downstream sub-config checks — they all dereference
		// `form.connect`, and we'd just produce a redundant cascade of
		// errors that all resolve once the missing block lands.
		return errors;
	}

	// A Connect id becomes an XML element name in the emitted form (the
	// wrapper `<id vellum:role=...>` and the Connect-namespaced `id=`
	// attribute) and lands in a Connect DB slug column (tightest is
	// `varchar(50)`). `connectIdError` is the single authority on what makes
	// an id valid (legal element name AND within length) — the same helper
	// the field-level commit guard uses, so the field and the server never
	// disagree. We reject a bad id here rather than silently fixing it. Only
	// non-empty ids are checked: an absent/empty id means "use the default",
	// which `deriveConnectDefaults` mints (legal chars, capped length), so a
	// derived id never trips this — it fires only on hand-typed / SA-supplied
	// ids (the agent path sets ids as a bare string, bypassing the field).
	//
	// The helper returns one reason; we pick the structured code from the
	// cheap element-name check (a char failure → INVALID_FORMAT, otherwise
	// the only remaining failure is length → TOO_LONG) and wrap the reason
	// with the form/kind context the message needs.
	const connectIds: ReadonlyArray<{ label: string; id: string | undefined }> = [
		{ label: "learn-module", id: form.connect.learn_module?.id },
		{ label: "assessment", id: form.connect.assessment?.id },
		{ label: "deliver-unit", id: form.connect.deliver_unit?.id },
		{ label: "task", id: form.connect.task?.id },
	];
	for (const { label, id } of connectIds) {
		if (!id) continue; // unset/empty → resolver supplies a valid default
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
	//      defaults for missing `entity_id` / `entity_name`. Only the
	//      explicit-empty-string state is a smell, indicating something
	//      wrote a deliberate blank.
	//   2. Unquoted string literal → `CONNECT_UNQUOTED_XPATH`. Same shape
	//      as the existing field-level rule: a bare word without quotes
	//      parses as an XPath identifier, not a literal value.
	type ConnectXPath = { label: string; expr: string | undefined };
	const connectXPaths: ConnectXPath[] = [];
	if (form.connect.assessment) {
		// `user_score` is required in the domain — never undefined here.
		connectXPaths.push({
			label: "Connect assessment user_score",
			expr: form.connect.assessment.user_score,
		});
	}
	if (form.connect.deliver_unit) {
		connectXPaths.push(
			{
				label: "Connect deliver entity_id",
				expr: form.connect.deliver_unit.entity_id,
			},
			{
				label: "Connect deliver entity_name",
				expr: form.connect.deliver_unit.entity_name,
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

/**
 * Lezer node-type handles for the case-hashtag scan. Resolved at module
 * load (one lookup, zero string comparisons in the hot path).
 */
const HASHTAG_NODE_TYPES = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((t) => t.name === name);
		if (!found) throw new Error(`Missing parser node type: ${name}`);
		return found;
	};
	return {
		HashtagRef: one("HashtagRef"),
		HashtagType: one("HashtagType"),
		HashtagSegment: one("HashtagSegment"),
	};
})();

/**
 * Find every `#case/<X>` hashtag in an XPath EXPRESSION whose segment
 * list is NOT exactly `["case_id"]`. Walks the Lezer parse tree so the
 * match is segment-boundary aware (`#case/case_id_extension` is NOT
 * mistaken for `#case/case_id` by prefix). Use this for true XPath
 * surfaces: `relevant` / `validate` / `calculate` / `default_value` /
 * `required` and Connect bindings.
 *
 * Returns the authored span (e.g. `"#case/total_visits"`) so the error
 * message can quote the user's exact text.
 */
function findInvalidCaseHashtagsInXPath(expr: string): string[] {
	if (!expr) return [];
	const out: string[] = [];
	const tree = parser.parse(expr);
	tree.iterate({
		enter(node) {
			if (node.type !== HASHTAG_NODE_TYPES.HashtagRef) return;
			const ref = node.node;
			const type = ref.getChild(HASHTAG_NODE_TYPES.HashtagType.id);
			if (!type) return false;
			if (expr.slice(type.from, type.to) !== "case") return false;
			const segments = ref.getChildren(HASHTAG_NODE_TYPES.HashtagSegment.id);
			if (segments.length === 1) {
				const seg = expr.slice(segments[0].from, segments[0].to);
				if (seg === "case_id") return false;
			}
			out.push(expr.slice(node.from, node.to));
			return false;
		},
	});
	return out;
}

/**
 * Match the same bare-hashtag pattern the XForm builder uses to lower
 * inline label / hint / validate_msg prose to `<output value>` elements
 * (`lib/commcare/xform/builder.ts::BARE_HASHTAG_RE`). Label text is
 * natural-language prose, NOT XPath, so the Lezer XPath grammar would
 * parse a label like `"Age: #case/age"` as something other than the
 * intended hashtag reference. Use this for prose surfaces — `label` /
 * `hint` / `validate_msg` — to mirror exactly which prose hashtags the
 * emitter would lower (and therefore which ones JavaRosa would try to
 * resolve at install time).
 *
 * Filters to `#case/<X>` references where the path is not the single
 * segment `case_id`; same exception rule as the XPath scanner above.
 */
const PROSE_HASHTAG_RE = /#case((?:\/[a-zA-Z_][a-zA-Z0-9_-]*)+)/g;
function findInvalidCaseHashtagsInProse(textContent: string): string[] {
	if (!textContent) return [];
	const out: string[] = [];
	for (const match of textContent.matchAll(PROSE_HASHTAG_RE)) {
		const segments = match[1].split("/").filter((s) => s.length > 0);
		if (segments.length === 1 && segments[0] === "case_id") continue;
		out.push(match[0]);
	}
	return out;
}

/**
 * On a registration form, the case the form creates does not exist in
 * `casedb` at form-init — `casedb` only sees it after the
 * post-submission case transaction lands. The context-free hashtag
 * expander rewrites `#case/<X>` to the case-loading XPath
 * (`instance('casedb')/casedb/case[@case_id = instance('commcaresession')/
 *  session/data/case_id]/<X>`), but a case-create entry declares no
 * `case_id` session datum (only `case_id_new_<casetype>_0`), so JavaRosa
 * rejects the calculate at form-init with `XPathTypeMismatchException`,
 * surfaced on device as "A part of your application is invalid."
 *
 * One exception: `#case/case_id` refers to the form's own newly-
 * allocated case_id, populated at `xforms-ready` into
 * `/data/case/@case_id` by the case-management scaffolding the compiler
 * emits. The form-context-aware expander
 * (`lib/commcare/hashtags/formContext.ts`) rewrites that ref to the
 * form-local path.
 *
 * Every other `#case/<X>` on a registration form is semantically
 * invalid — the property is being SET by the form right now, not read
 * from a pre-existing case — and Nova rejects it at authoring time so
 * the SA / user sees the error in the editor (not at compile-time
 * after they hit "Generate App"). The fix is to reference the form
 * question directly: `#form/<question_id>` or `/data/<question_id>`.
 *
 * Scope of surfaces walked: every field's expression slots
 * (`relevant` / `validate` / `calculate` / `default_value` / `required`)
 * plus its text slots (`label` / `hint` / `validate_msg`, which can
 * carry inline hashtags that lower to `<output value>` at emit), plus
 * the form's Connect XPath bindings
 * (`deliver_unit.entity_id` / `entity_name`, `assessment.user_score`).
 */
function caseHashtagOnCreateForm(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormContext,
): ValidationError[] {
	if (form.type !== "registration") return [];
	const errors: ValidationError[] = [];
	const loc = baseLocation(ctx);

	/**
	 * Emit one error per offending hashtag occurrence. Quotes the
	 * authored text exactly so the user can find it in the editor by
	 * search. `kind` picks the scanner that matches the wire emitter's
	 * own pattern for that surface (Lezer for XPath, prose-regex for
	 * label / hint / validate_msg).
	 */
	const flag = (
		kind: "xpath" | "prose",
		surface: string,
		where: string,
		value: string | undefined,
	) => {
		if (!value) return;
		const hashtags =
			kind === "xpath"
				? findInvalidCaseHashtagsInXPath(value)
				: findInvalidCaseHashtagsInProse(value);
		for (const hashtag of hashtags) {
			errors.push(
				validationError(
					"CASE_HASHTAG_ON_CREATE_FORM",
					"form",
					`"${ctx.formName}" references "${hashtag}" in ${surface}${where ? ` of ${where}` : ""}. On a registration form the case being created doesn't exist yet, so case-property references can't resolve. Use "#form/<question_id>" to reference a form question by id, or "/data/<path>" for a fully-qualified XPath. The only valid case reference on a registration form is "#case/case_id" — it points to the newly-allocated case_id.`,
					loc,
					{ hashtag, surface },
				),
			);
		}
	};

	// Walk every field's XPath + prose surfaces. Containers count too —
	// `readFieldString` returns the configured value or undefined.
	// Expression surfaces (relevant/validate/calculate/default_value/
	// required) flow through the hashtag expander as XPath; prose
	// surfaces (label/hint/validate_msg) lower their inline hashtags to
	// `<output value="...">` at emit. Both must be screened here.
	const XPATH_FIELD_SURFACES = [
		"relevant",
		"validate",
		"calculate",
		"default_value",
		"required",
	] as const;
	const PROSE_FIELD_SURFACES = ["label", "hint", "validate_msg"] as const;
	const walkFields = (parentUuid: Uuid): void => {
		for (const uuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[uuid];
			if (!field) continue;
			const fieldRef = `field "${field.id}"`;
			for (const surface of XPATH_FIELD_SURFACES) {
				flag("xpath", surface, fieldRef, readFieldString(field, surface));
			}
			for (const surface of PROSE_FIELD_SURFACES) {
				flag("prose", surface, fieldRef, readFieldString(field, surface));
			}
			// Repeat-cardinality surfaces — XPath the wire emitter threads
			// through the hashtag expander on both count-bound and
			// query-bound repeats. Skipping these would let `#case/<X>` on
			// a registration form's `repeat_count` or `data_source.ids_query`
			// slip past authoring validation and surface as a compile-time
			// throw, the failure mode this rule exists to close.
			if (field.kind === "repeat") {
				if (field.repeat_mode === "count_bound") {
					flag("xpath", "repeat_count", fieldRef, field.repeat_count);
				} else if (field.repeat_mode === "query_bound") {
					flag(
						"xpath",
						"data_source.ids_query",
						fieldRef,
						field.data_source.ids_query,
					);
				}
			}
			if (doc.fieldOrder[uuid] !== undefined) walkFields(uuid);
		}
	};
	walkFields(ctx.formUuid);

	// Connect XPath surfaces — the bind emitter lowers them to
	// `calculate="..."` on the per-form Connect element; treat them as
	// raw XPath expressions.
	if (form.connect?.deliver_unit) {
		flag(
			"xpath",
			"connect deliver_unit.entity_id",
			"",
			form.connect.deliver_unit.entity_id,
		);
		flag(
			"xpath",
			"connect deliver_unit.entity_name",
			"",
			form.connect.deliver_unit.entity_name,
		);
	}
	if (form.connect?.assessment) {
		flag(
			"xpath",
			"connect assessment.user_score",
			"",
			form.connect.assessment.user_score,
		);
	}

	return errors;
}

/**
 * A `case_property_on` value names a case type other than the module's
 * own case type — Nova's expander treats this as a child-case
 * reference and auto-derives a subcase. The shape is fine outside a
 * repeat; the wire emitter (`xform/caseBlocks.ts::buildCaseBlocks` +
 * `xform/caseBlocks.ts::addCaseBlocks`) handles the non-repeat
 * subcase by splicing the wrapper element under the form's top-level
 * `<data>`. But when the field sits INSIDE a repeat, the wire
 * emitter builds bind nodesets with the repeat-scoped prefix
 * (`/data/<repeat_id>/subcase_<n>/case/...`) while the splice site
 * still appends the wrapper under top-level `<data>`. The two
 * disagree on the wire path, the post-injection XForm oracle
 * catches the dangling bind, and `compileCcz` throws — exactly the
 * emit-time-error UX the total-function-emitter principle forbids.
 *
 * CCHQ's emitter handles this shape (`commcare-hq/.../app_manager/
 * xform.py::XForm.add_create_block` walks the repeat-context path
 * to find the splice parent) and the canonical fixture
 * `multiple_subcase_repeat.xml` exercises it. Nova's emitter does
 * not — until it does, reject the authoring shape so the user gets
 * an actionable error in the editor instead of an opaque compile-
 * time throw.
 *
 * Alternative authoring shapes the user can reach for:
 *   - Move the child-creation off the registration form into a
 *     followup form that does one subcase per submission (the
 *     standard "one parent registration + many child followups"
 *     pattern Nova fully supports today).
 *   - Hoist the child field out of the repeat and create exactly
 *     one subcase per parent — Nova's non-repeat subcase emission
 *     is supported.
 */
function subcaseInRepeatNotModeled(
	doc: BlueprintDoc,
	ctx: FormContext,
	mod: Module,
): ValidationError[] {
	if (!mod.caseType) return [];
	const knownCaseTypes = new Set((doc.caseTypes ?? []).map((ct) => ct.name));
	if (knownCaseTypes.size === 0) return [];
	const errors: ValidationError[] = [];

	const walk = (parentUuid: Uuid, repeatAncestor: string | undefined): void => {
		for (const uuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[uuid];
			if (!field) continue;
			const fieldCaseType =
				typeof (field as Record<string, unknown>).case_property_on === "string"
					? ((field as Record<string, unknown>).case_property_on as string)
					: undefined;
			if (
				repeatAncestor &&
				fieldCaseType &&
				fieldCaseType !== mod.caseType &&
				knownCaseTypes.has(fieldCaseType)
			) {
				errors.push(
					validationError(
						"SUBCASE_IN_REPEAT_NOT_MODELED",
						"form",
						`"${ctx.formName}" has field "${field.id}" inside repeat "${repeatAncestor}" with case_property_on "${fieldCaseType}" (different from the module's case type "${mod.caseType}"). Nova doesn't yet support creating subcases inside a repeat (one parent + many children created in one submission). Move the child-creation to a separate followup form that creates one subcase per submission, or hoist this field out of the repeat to create exactly one subcase per parent.`,
						baseLocation(ctx),
						{
							fieldId: field.id,
							repeatId: repeatAncestor,
							childCaseType: fieldCaseType,
						},
					),
				);
			}
			if (doc.fieldOrder[uuid] !== undefined) {
				const nextRepeatAncestor =
					field.kind === "repeat" ? field.id : repeatAncestor;
				walk(uuid, nextRepeatAncestor);
			}
		}
	};
	walk(ctx.formUuid, undefined);

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
): ValidationError[] {
	const form = doc.forms[formUuid];
	const mod = doc.modules[moduleUuid];
	const ctx: FormContext = {
		formUuid,
		moduleUuid,
		formName: form.name,
		moduleName: mod.name,
	};

	const caseConfig = deriveCaseConfig(doc, formUuid, mod.caseType, form.type);

	const errors: ValidationError[] = [];
	errors.push(...emptyForm(doc, form, ctx));
	errors.push(...closeConditionValidation(doc, form, ctx, mod));
	errors.push(...duplicateFieldIds(doc, ctx));
	errors.push(...noCaseNameField(form, ctx, caseConfig));
	errors.push(...caseNameFieldMissing(doc, form, ctx, caseConfig));
	errors.push(...reservedCaseProperty(ctx, caseConfig));
	errors.push(...casePropertyMissingField(doc, ctx, caseConfig));
	errors.push(...mediaCaseProperty(doc, ctx, caseConfig));
	errors.push(...casePreloadMissingField(doc, ctx, caseConfig));
	errors.push(...casePreloadReserved(ctx, caseConfig));
	errors.push(...duplicateCasePropertyMapping(ctx, caseConfig));
	errors.push(...registrationNoCaseProperties(form, ctx, caseConfig, mod));
	errors.push(...casePropertyBadFormat(ctx, caseConfig));
	errors.push(...casePropertyTooLong(ctx, caseConfig));
	errors.push(...postSubmitValidation(form, ctx, mod));
	errors.push(...formLinkValidation(doc, form, ctx));
	errors.push(...connectValidation(doc, form, ctx));
	errors.push(...caseHashtagOnCreateForm(doc, form, ctx));
	errors.push(...subcaseInRepeatNotModeled(doc, ctx, mod));

	return errors;
}
