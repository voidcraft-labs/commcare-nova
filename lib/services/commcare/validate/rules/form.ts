/**
 * Form-level validation rules.
 * Each rule receives a form, its indices, the parent module, and the full blueprint.
 * Case config is derived once per form and passed to rules that need it.
 */

import type {
	AppBlueprint,
	BlueprintForm,
	BlueprintModule,
	Question,
	DerivedCaseConfig,
	FormLink,
} from "@/lib/schemas/blueprint";
import {
	deriveCaseConfig,
	POST_SUBMIT_DESTINATIONS,
} from "@/lib/schemas/blueprint";
import {
	RESERVED_CASE_PROPERTIES,
	MEDIA_QUESTION_TYPES,
	CASE_PROPERTY_REGEX,
	MAX_CASE_PROPERTY_LENGTH,
} from "../../constants";
import { type ValidationError, validationError } from "../errors";
import { detectUnquotedStringLiteral } from "../../../hqJsonExpander";

// ── Helpers ────────────────────────────────────────────────────────

function collectQuestionIds(questions: Question[]): string[] {
	const ids: string[] = [];
	for (const q of questions) {
		ids.push(q.id);
		if ((q.type === "group" || q.type === "repeat") && q.children) {
			ids.push(...collectQuestionIds(q.children));
		}
	}
	return ids;
}

function findQuestionById(
	questions: Question[],
	id: string,
): Question | undefined {
	for (const q of questions) {
		if (q.id === id) return q;
		if ((q.type === "group" || q.type === "repeat") && q.children) {
			const found = findQuestionById(q.children, id);
			if (found) return found;
		}
	}
	return undefined;
}

interface FormContext {
	formIndex: number;
	modIndex: number;
	formName: string;
	moduleName: string;
}

// ── Rules ──────────────────────────────────────────────────────────

export function emptyForm(
	form: BlueprintForm,
	ctx: FormContext,
): ValidationError[] {
	if (!form.questions || form.questions.length === 0) {
		return [
			validationError(
				"EMPTY_FORM",
				"form",
				`"${ctx.formName}" in "${ctx.moduleName}" has no questions. CommCare can't build an empty form — add at least one question.`,
				{
					moduleIndex: ctx.modIndex,
					moduleName: ctx.moduleName,
					formIndex: ctx.formIndex,
					formName: ctx.formName,
				},
			),
		];
	}
	return [];
}

export function noCaseNameField(
	form: BlueprintForm,
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (form.type === "registration" && !caseConfig.case_name_field) {
		return [
			validationError(
				"NO_CASE_NAME_FIELD",
				"form",
				`"${ctx.formName}" is a registration form but none of its questions has id "case_name". Every new case needs a name — add a text question with id "case_name" and case_property_on set to the module's case type.`,
				{
					moduleIndex: ctx.modIndex,
					moduleName: ctx.moduleName,
					formIndex: ctx.formIndex,
					formName: ctx.formName,
				},
			),
		];
	}
	return [];
}

export function caseNameFieldMissing(
	form: BlueprintForm,
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (form.type === "registration" && caseConfig.case_name_field) {
		const ids = collectQuestionIds(form.questions || []);
		if (!ids.includes(caseConfig.case_name_field)) {
			return [
				validationError(
					"CASE_NAME_FIELD_MISSING",
					"form",
					`"${ctx.formName}" expects a question with id "${caseConfig.case_name_field}" for the case name, but no such question exists. Either add this question or rename an existing one.`,
					{ formIndex: ctx.formIndex, formName: ctx.formName },
				),
			];
		}
	}
	return [];
}

export function reservedCaseProperty(
	form: BlueprintForm,
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
					`"${ctx.formName}" saves to case property "${prop}", which is a reserved name in CommCare (used internally for case tracking). Rename the question to something like "${prop}_value" or "case_${prop}" instead.`,
					{ formIndex: ctx.formIndex, formName: ctx.formName },
					{ reservedName: prop },
				),
			);
		}
	}
	return errors;
}

export function casePropertyMissingQuestion(
	form: BlueprintForm,
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (!caseConfig.case_properties) return [];
	const errors: ValidationError[] = [];
	const ids = collectQuestionIds(form.questions || []);
	for (const {
		case_property: prop,
		question_id: qId,
	} of caseConfig.case_properties) {
		if (!ids.includes(qId)) {
			errors.push(
				validationError(
					"CASE_PROPERTY_MISSING_QUESTION",
					"form",
					`"${ctx.formName}" maps case property "${prop}" to question "${qId}", but that question doesn't exist in this form. Either add the question or remove the case property mapping.`,
					{ formIndex: ctx.formIndex, formName: ctx.formName },
				),
			);
		}
	}
	return errors;
}

export function mediaCaseProperty(
	form: BlueprintForm,
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (!caseConfig.case_properties) return [];
	const errors: ValidationError[] = [];
	for (const {
		case_property: prop,
		question_id: qId,
	} of caseConfig.case_properties) {
		const q = findQuestionById(form.questions || [], qId);
		if (q && MEDIA_QUESTION_TYPES.has(q.type)) {
			errors.push(
				validationError(
					"MEDIA_CASE_PROPERTY",
					"form",
					`"${ctx.formName}" tries to save the ${q.type} question "${qId}" as case property "${prop}". Media files (images, audio, video, signatures) can't be stored as case properties — they're handled separately by CommCare's attachment system. Remove the case_property_on from this question.`,
					{ formIndex: ctx.formIndex, formName: ctx.formName },
					{ property: prop, questionId: qId },
				),
			);
		}
	}
	return errors;
}

export function casePreloadMissingQuestion(
	form: BlueprintForm,
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
): ValidationError[] {
	if (!caseConfig.case_preload) return [];
	const errors: ValidationError[] = [];
	const ids = collectQuestionIds(form.questions || []);
	for (const {
		question_id: qId,
		case_property: prop,
	} of caseConfig.case_preload) {
		if (!ids.includes(qId)) {
			errors.push(
				validationError(
					"CASE_PRELOAD_MISSING_QUESTION",
					"form",
					`"${ctx.formName}" tries to preload case property "${prop}" into question "${qId}", but that question doesn't exist. The preload needs a matching question to receive the data.`,
					{ formIndex: ctx.formIndex, formName: ctx.formName },
				),
			);
		}
	}
	return errors;
}

export function casePreloadReserved(
	form: BlueprintForm,
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
					{ formIndex: ctx.formIndex, formName: ctx.formName },
				),
			);
		}
	}
	return errors;
}

export function duplicateCasePropertyMapping(
	form: BlueprintForm,
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
					`"${ctx.formName}" has two questions ("${prev}" and "${qId}") both saving to case property "${prop}". Each case property can only be updated by one question — rename one of the question IDs so they map to different properties.`,
					{ formIndex: ctx.formIndex, formName: ctx.formName },
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
	form: BlueprintForm,
	ctx: FormContext,
	caseConfig: DerivedCaseConfig,
	mod: BlueprintModule,
): ValidationError[] {
	if (form.type !== "registration" || !mod.case_type) return [];
	if (!caseConfig.case_properties || caseConfig.case_properties.length === 0) {
		return [
			validationError(
				"REGISTRATION_NO_CASE_PROPS",
				"form",
				`"${ctx.formName}" is a registration form but none of its questions save data to the "${mod.case_type}" case. A registration form should capture information about the new case. Add case_property_on: "${mod.case_type}" to questions whose answers should be saved to the case.`,
				{
					moduleIndex: ctx.modIndex,
					moduleName: ctx.moduleName,
					formIndex: ctx.formIndex,
					formName: ctx.formName,
				},
			),
		];
	}
	return [];
}

export function closeCaseValidation(
	form: BlueprintForm,
	ctx: FormContext,
): ValidationError[] {
	if (!form.close_case) return [];
	const errors: ValidationError[] = [];
	const loc = { formIndex: ctx.formIndex, formName: ctx.formName };

	if (form.type !== "followup") {
		errors.push(
			validationError(
				"CLOSE_CASE_NOT_FOLLOWUP",
				"form",
				`"${ctx.formName}" has a close_case block but isn't a followup form. Only followup forms can close cases because they're the ones that load an existing case. Change the form type to "followup" or remove the close_case block.`,
				loc,
			),
		);
		return errors;
	}

	const cc = form.close_case;
	if (cc.question && !cc.answer) {
		errors.push(
			validationError(
				"CLOSE_CASE_MISSING_ANSWER",
				"form",
				`"${ctx.formName}" has a conditional close_case with a question ("${cc.question}") but no answer to match against. Add an "answer" value so CommCare knows when to close the case (e.g. answer: "yes"), or use an empty close_case {} for unconditional close.`,
				loc,
			),
		);
	}
	if (!cc.question && cc.answer) {
		errors.push(
			validationError(
				"CLOSE_CASE_MISSING_QUESTION",
				"form",
				`"${ctx.formName}" has a conditional close_case with an answer ("${cc.answer}") but no question to check. Add a "question" ID so CommCare knows which answer to compare, or use an empty close_case {} for unconditional close.`,
				loc,
			),
		);
	}
	if (cc.question) {
		const ids = collectQuestionIds(form.questions || []);
		if (!ids.includes(cc.question)) {
			errors.push(
				validationError(
					"CLOSE_CASE_QUESTION_NOT_FOUND",
					"form",
					`"${ctx.formName}" has close_case checking question "${cc.question}", but no question with that ID exists in the form. Either add the question or update close_case to reference an existing one.`,
					loc,
				),
			);
		}
	}
	return errors;
}

/**
 * Comprehensive post-submit navigation validation.
 *
 * Validates every post_submit destination against the form's context.
 * Even destinations that "work" may produce warnings when the behavior
 * is surprising or will change when more features are added.
 *
 * CommCare HQ validates (validators.py:1054-1105):
 * - WORKFLOW_FORM with empty form_links → error
 * - WORKFLOW_MODULE when module.put_in_root → error
 * - WORKFLOW_PARENT_MODULE when no root_module → error
 * - WORKFLOW_PARENT_MODULE when parent.put_in_root → error
 * - WORKFLOW_PREVIOUS with multi_select + mismatched root → error
 * - WORKFLOW_PREVIOUS with inline_search → error
 *
 * We validate ALL of these. For features not yet modeled in Nova
 * (put_in_root, root_module, multi_select, inline_search), the
 * checks are stubs that will activate when those features are added.
 */
export function postSubmitValidation(
	form: BlueprintForm,
	ctx: FormContext,
	mod: BlueprintModule,
): ValidationError[] {
	if (!form.post_submit) return [];
	const errors: ValidationError[] = [];
	const loc = {
		moduleIndex: ctx.modIndex,
		moduleName: ctx.moduleName,
		formIndex: ctx.formIndex,
		formName: ctx.formName,
	};
	const dest = form.post_submit;

	// ── Value validity ──────────────────────────────────────────────
	const valid = (POST_SUBMIT_DESTINATIONS as readonly string[]).includes(dest);
	if (!valid) {
		errors.push(
			validationError(
				"INVALID_POST_SUBMIT",
				"form",
				`"${ctx.formName}" has post_submit set to "${dest}", which is not a recognized destination.\n\n` +
					`The valid options are:\n` +
					`  "default"        — Navigate to the app home screen\n` +
					`  "root"           — Navigate to the first menu (module select)\n` +
					`  "module"         — Navigate back to this module's form list\n` +
					`  "parent_module"  — Navigate to the parent module's menu\n` +
					`  "previous"       — Navigate to the screen before this form`,
				loc,
				{ value: String(dest) },
			),
		);
		return errors; // Don't run further checks on an invalid value
	}

	// ── parent_module: requires a parent module relationship ────────
	// CommCare HQ: invalid when module has no root_module_id.
	// Nova doesn't model root_module yet, so this is ALWAYS an error.
	// When root_module is added, this check should verify:
	//   1. mod.root_module exists
	//   2. The parent module is not put_in_root (display-only)
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
					`  "default"   — Go to the app home screen`,
				loc,
			),
		);
	}

	// ── module: invalid when module is display-only (case_list_only) ──
	// CommCare HQ: invalid when module.put_in_root (forms are at root level,
	// so "module menu" doesn't exist as a navigable screen).
	// Nova: case_list_only modules have no forms → no form list to return to.
	if (dest === "module" && mod.case_list_only) {
		errors.push(
			validationError(
				"POST_SUBMIT_MODULE_CASE_LIST_ONLY",
				"form",
				`"${ctx.formName}" has post_submit set to "module", but "${ctx.moduleName}" is a case-list-only module with no form list to navigate to.\n\n` +
					`After submitting this form, the user would land on an empty module menu. ` +
					`Consider using "previous" to return the user to where they were, or "default" to go home.`,
				loc,
			),
		);
	}

	// ── Future checks (activate when features are modeled) ──────────
	//
	// WORKFLOW_MODULE + put_in_root:
	//   When Nova adds put_in_root on modules, check:
	//   if (dest === 'module' && mod.put_in_root) → error
	//   "This module's forms are displayed at the root level, so there's
	//    no module menu to navigate to."
	//
	// WORKFLOW_PREVIOUS + multi_select:
	//   When Nova adds multi_select on modules, check:
	//   if (dest === 'previous' && mod.is_multi_select !== mod.root_module?.is_multi_select)
	//   "The previous screen used a different selection mode than this module."
	//
	// WORKFLOW_PREVIOUS + inline_search:
	//   When Nova adds inline search, check:
	//   if (dest === 'previous' && form.type === 'followup' && mod.uses_inline_search)
	//   "Inline search results can't be restored after form submission."

	return errors;
}

/**
 * Form link validation.
 *
 * Validates every aspect of form_links that CommCare HQ checks:
 * - Empty links array (present but no entries)
 * - Target form/module exists in the blueprint
 * - No self-referencing links (form links to itself)
 * - Conditional links have a fallback (post_submit must be set)
 *
 * Circular link detection (A→B→A) runs at the app level via
 * detectFormLinkCycles() in the runner.
 *
 * form_links is fully validated but NOT YET EXPOSED in the UI or SA tools.
 * Setting form_links directly on the blueprint will trigger these checks.
 */
export function formLinkValidation(
	form: BlueprintForm,
	ctx: FormContext,
	_mod: BlueprintModule,
	blueprint: AppBlueprint,
): ValidationError[] {
	if (!form.form_links) return [];
	const errors: ValidationError[] = [];
	const loc = {
		moduleIndex: ctx.modIndex,
		moduleName: ctx.moduleName,
		formIndex: ctx.formIndex,
		formName: ctx.formName,
	};

	// ── Empty form_links array ──────────────────────────────────────
	if (form.form_links.length === 0) {
		errors.push(
			validationError(
				"FORM_LINK_EMPTY",
				"form",
				`"${ctx.formName}" has form_links set to an empty array.\n\n` +
					`form_links is meant to hold one or more navigation links to other forms or modules. ` +
					`An empty array has no effect — either add links or remove the form_links field entirely.\n\n` +
					`Without form_links, the form will use its post_submit destination ("${form.post_submit ?? "default"}").`,
				loc,
			),
		);
		return errors;
	}

	const hasAnyCondition = form.form_links.some((l) => l.condition);

	// ── No fallback when links have conditions ──────────────────────
	if (hasAnyCondition && !form.post_submit) {
		errors.push(
			validationError(
				"FORM_LINK_NO_FALLBACK",
				"form",
				`"${ctx.formName}" has conditional form links but no post_submit fallback.\n\n` +
					`When form links have XPath conditions, CommCare evaluates them after submission. ` +
					`If none of the conditions match, the user needs somewhere to go — that's what post_submit provides.\n\n` +
					`Set post_submit to a destination like "module" or "default" so there's always a valid navigation path.`,
				loc,
			),
		);
	}

	// ── Validate each link ──────────────────────────────────────────
	for (let lIdx = 0; lIdx < form.form_links.length; lIdx++) {
		const link = form.form_links[lIdx];
		const linkLabel = link.condition
			? `form link ${lIdx + 1} (condition: "${link.condition.slice(0, 40)}${link.condition.length > 40 ? "..." : ""}")`
			: `form link ${lIdx + 1}`;

		// Target exists
		if (link.target.type === "form") {
			const targetMod = blueprint.modules[link.target.moduleIndex];
			const targetForm = targetMod?.forms[link.target.formIndex];
			if (!targetMod) {
				errors.push(
					validationError(
						"FORM_LINK_TARGET_NOT_FOUND",
						"form",
						`"${ctx.formName}" ${linkLabel} targets module ${link.target.moduleIndex}, which doesn't exist.\n\n` +
							`The app has ${blueprint.modules.length} module${blueprint.modules.length === 1 ? "" : "s"} (indices 0–${blueprint.modules.length - 1}). ` +
							`Update the target to reference an existing module.`,
						loc,
					),
				);
			} else if (!targetForm) {
				errors.push(
					validationError(
						"FORM_LINK_TARGET_NOT_FOUND",
						"form",
						`"${ctx.formName}" ${linkLabel} targets form ${link.target.formIndex} in "${targetMod.name}", which doesn't exist.\n\n` +
							`"${targetMod.name}" has ${targetMod.forms.length} form${targetMod.forms.length === 1 ? "" : "s"} (indices 0–${targetMod.forms.length - 1}). ` +
							`Update the target to reference an existing form.`,
						loc,
					),
				);
			}

			// Self-reference
			if (
				link.target.moduleIndex === ctx.modIndex &&
				link.target.formIndex === ctx.formIndex
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
			// Module target
			const targetMod = blueprint.modules[link.target.moduleIndex];
			if (!targetMod) {
				errors.push(
					validationError(
						"FORM_LINK_TARGET_NOT_FOUND",
						"form",
						`"${ctx.formName}" ${linkLabel} targets module ${link.target.moduleIndex}, which doesn't exist.\n\n` +
							`The app has ${blueprint.modules.length} module${blueprint.modules.length === 1 ? "" : "s"} (indices 0–${blueprint.modules.length - 1}). ` +
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
	form: BlueprintForm,
	ctx: FormContext,
	_caseConfig: DerivedCaseConfig,
	_mod: BlueprintModule,
	blueprint: AppBlueprint,
): ValidationError[] {
	if (!blueprint.connect_type || !form.connect) return [];
	const errors: ValidationError[] = [];
	const loc = { formIndex: ctx.formIndex, formName: ctx.formName };

	if (
		blueprint.connect_type === "learn" &&
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
	if (blueprint.connect_type === "deliver" && !form.connect.deliver_unit) {
		errors.push(
			validationError(
				"CONNECT_MISSING_DELIVER",
				"form",
				`"${ctx.formName}" is opted into Connect but is missing deliver_unit config. This app is a Connect Deliver app, so each Connect form needs a deliver_unit with at least a name.`,
				loc,
			),
		);
	}

	const connectXPaths: Array<[string, string]> = [];
	if (form.connect.assessment?.user_score)
		connectXPaths.push([
			"Connect assessment user_score",
			form.connect.assessment.user_score,
		]);
	if (form.connect.deliver_unit?.entity_id)
		connectXPaths.push([
			"Connect deliver entity_id",
			form.connect.deliver_unit.entity_id,
		]);
	if (form.connect.deliver_unit?.entity_name)
		connectXPaths.push([
			"Connect deliver entity_name",
			form.connect.deliver_unit.entity_name,
		]);
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
 * Question IDs must be unique among siblings (same parent scope).
 * /data/abc and /data/group/abc are fine — they have different XML paths.
 * /data/abc and /data/abc are not — they collide at the same level.
 */
export function duplicateQuestionIds(
	form: BlueprintForm,
	ctx: FormContext,
): ValidationError[] {
	const errors: ValidationError[] = [];
	checkDuplicatesInScope(form.questions || [], "/data", ctx, errors);
	return errors;
}

function checkDuplicatesInScope(
	questions: Question[],
	parentPath: string,
	ctx: FormContext,
	errors: ValidationError[],
): void {
	const counts = new Map<string, number>();
	for (const q of questions) {
		counts.set(q.id, (counts.get(q.id) ?? 0) + 1);
	}
	for (const [id, count] of counts) {
		if (count > 1) {
			errors.push(
				validationError(
					"DUPLICATE_QUESTION_ID",
					"form",
					`"${ctx.formName}" in "${ctx.moduleName}" has ${count} questions with the ID "${id}" at the same level (${parentPath}). Questions at the same level share an XML path, so they need unique IDs. Rename the duplicates.`,
					{
						moduleIndex: ctx.modIndex,
						moduleName: ctx.moduleName,
						formIndex: ctx.formIndex,
						formName: ctx.formName,
					},
				),
			);
		}
	}
	for (const q of questions) {
		if ((q.type === "group" || q.type === "repeat") && q.children) {
			checkDuplicatesInScope(q.children, `${parentPath}/${q.id}`, ctx, errors);
		}
	}
}

export function casePropertyBadFormat(
	form: BlueprintForm,
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
					{ formIndex: ctx.formIndex, formName: ctx.formName },
					{ property: prop },
				),
			);
		}
	}
	return errors;
}

export function casePropertyTooLong(
	form: BlueprintForm,
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
					{ formIndex: ctx.formIndex, formName: ctx.formName },
					{ property: prop },
				),
			);
		}
	}
	return errors;
}

// ── Rule runner ────────────────────────────────────────────────────

export function runFormRules(
	form: BlueprintForm,
	formIndex: number,
	mod: BlueprintModule,
	modIndex: number,
	blueprint: AppBlueprint,
): ValidationError[] {
	const ctx: FormContext = {
		formIndex,
		modIndex,
		formName: form.name,
		moduleName: mod.name,
	};
	const caseConfig = deriveCaseConfig(
		form.questions || [],
		form.type,
		mod.case_type ?? undefined,
		blueprint.case_types,
	);
	const errors: ValidationError[] = [];

	errors.push(...emptyForm(form, ctx));
	errors.push(...closeCaseValidation(form, ctx));
	errors.push(...duplicateQuestionIds(form, ctx));
	errors.push(...noCaseNameField(form, ctx, caseConfig));
	errors.push(...caseNameFieldMissing(form, ctx, caseConfig));
	errors.push(...reservedCaseProperty(form, ctx, caseConfig));
	errors.push(...casePropertyMissingQuestion(form, ctx, caseConfig));
	errors.push(...mediaCaseProperty(form, ctx, caseConfig));
	errors.push(...casePreloadMissingQuestion(form, ctx, caseConfig));
	errors.push(...casePreloadReserved(form, ctx, caseConfig));
	errors.push(...duplicateCasePropertyMapping(form, ctx, caseConfig));
	errors.push(...registrationNoCaseProperties(form, ctx, caseConfig, mod));
	errors.push(...casePropertyBadFormat(form, ctx, caseConfig));
	errors.push(...casePropertyTooLong(form, ctx, caseConfig));
	errors.push(...postSubmitValidation(form, ctx, mod));
	errors.push(...formLinkValidation(form, ctx, mod, blueprint));
	errors.push(...connectValidation(form, ctx, caseConfig, mod, blueprint));

	return errors;
}
