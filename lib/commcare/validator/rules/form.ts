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
} from "@/lib/commcare";
import {
	type DerivedCaseConfig,
	deriveCaseConfig,
} from "@/lib/commcare/deriveCaseConfig";
import { detectUnquotedStringLiteral } from "@/lib/commcare/xpath";
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

export function emptyForm(
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

export function noCaseNameField(
	form: Form,
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (form.type === "registration" && !caseConfig.case_name_field) {
		return [
			validationError(
				"NO_CASE_NAME_FIELD",
				"form",
				`"${ctx.formName}" is a registration form but none of its fields has id "case_name". Every new case needs a name — add a text field with id "case_name" and \`case_property\` set to the module's case type.`,
				baseLocation(ctx),
			),
		];
	}
	return [];
}

export function caseNameFieldMissing(
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

export function reservedCaseProperty(
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

export function casePropertyMissingField(
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

export function mediaCaseProperty(
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
					`"${ctx.formName}" tries to save the ${field.kind} field "${qId}" as case property "${prop}". Media files (images, audio, video, signatures) can't be stored as case properties — they're handled separately by CommCare's attachment system. Clear \`case_property\` on this field.`,
					baseLocation(ctx),
					{ property: prop, questionId: qId },
				),
			);
		}
	}
	return errors;
}

export function casePreloadMissingField(
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

export function casePreloadReserved(
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

export function duplicateCasePropertyMapping(
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

export function registrationNoCaseProperties(
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
				`"${ctx.formName}" is a registration form but none of its fields save data to the "${mod.caseType}" case. A registration form should capture information about the new case. Set \`case_property\` to "${mod.caseType}" on fields whose answers should be saved to the case.`,
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
export function closeConditionValidation(
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
export function postSubmitValidation(
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
export function formLinkValidation(
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

export function connectValidation(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormContext,
): ValidationError[] {
	if (!doc.connectType || !form.connect) return [];
	const errors: ValidationError[] = [];
	const loc = baseLocation(ctx);

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

	const connectXPaths: Array<[string, string]> = [];
	if (form.connect.assessment?.user_score) {
		connectXPaths.push([
			"Connect assessment user_score",
			form.connect.assessment.user_score,
		]);
	}
	if (form.connect.deliver_unit?.entity_id) {
		connectXPaths.push([
			"Connect deliver entity_id",
			form.connect.deliver_unit.entity_id,
		]);
	}
	if (form.connect.deliver_unit?.entity_name) {
		connectXPaths.push([
			"Connect deliver entity_name",
			form.connect.deliver_unit.entity_name,
		]);
	}
	for (const [label, expr] of connectXPaths) {
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
export function duplicateFieldIds(
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

export function casePropertyBadFormat(
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

export function casePropertyTooLong(
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

	return errors;
}
