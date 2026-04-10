/**
 * Module-level validation rules.
 * Each rule receives a module, its index, and the full blueprint.
 */

import type {
	AppBlueprint,
	BlueprintModule,
	Question,
} from "@/lib/schemas/blueprint";
import {
	CASE_TYPE_REGEX,
	MAX_CASE_TYPE_LENGTH,
	STANDARD_CASE_LIST_PROPERTIES,
} from "../../constants";
import { type ValidationError, validationError } from "../errors";

export function caseFormsNoCaseType(
	mod: BlueprintModule,
	index: number,
	_bp: AppBlueprint,
): ValidationError[] {
	const hasCaseForms = mod.forms?.some((f) => f.type !== "survey");
	if (hasCaseForms && !mod.case_type) {
		return [
			validationError(
				"NO_CASE_TYPE",
				"module",
				`Module "${mod.name}" has registration or followup forms but no case_type. These form types create and update cases, so the module needs to know which case type to work with. Set case_type to the type of case this module manages (e.g. "patient", "household").`,
				{ moduleIndex: index, moduleName: mod.name },
			),
		];
	}
	return [];
}

export function caseListOnlyHasForms(
	mod: BlueprintModule,
	index: number,
	_bp: AppBlueprint,
): ValidationError[] {
	if (mod.case_list_only && mod.forms.length > 0) {
		return [
			validationError(
				"CASE_LIST_ONLY_HAS_FORMS",
				"module",
				`Module "${mod.name}" is marked as case_list_only (a viewer for existing cases) but also has forms. A case_list_only module just shows a list — it can't contain forms. Either remove the forms or remove the case_list_only flag.`,
				{ moduleIndex: index, moduleName: mod.name },
			),
		];
	}
	return [];
}

export function caseListOnlyNoCaseType(
	mod: BlueprintModule,
	index: number,
	_bp: AppBlueprint,
): ValidationError[] {
	if (mod.case_list_only && !mod.case_type) {
		return [
			validationError(
				"CASE_LIST_ONLY_NO_CASE_TYPE",
				"module",
				`Module "${mod.name}" is marked as case_list_only but has no case_type. A case list viewer needs to know which type of cases to display. Set case_type to the case type this module should list.`,
				{ moduleIndex: index, moduleName: mod.name },
			),
		];
	}
	return [];
}

export function noFormsOrCaseList(
	mod: BlueprintModule,
	index: number,
	_bp: AppBlueprint,
): ValidationError[] {
	if (!mod.case_list_only && mod.case_type && mod.forms.length === 0) {
		return [
			validationError(
				"NO_FORMS_OR_CASE_LIST",
				"module",
				`Module "${mod.name}" has a case_type ("${mod.case_type}") but no forms. CommCare needs either forms to interact with cases, or a visible case list. If this module is just for viewing cases, set case_list_only: true. Otherwise, add forms.`,
				{ moduleIndex: index, moduleName: mod.name },
			),
		];
	}
	return [];
}

export function invalidCaseTypeFormat(
	mod: BlueprintModule,
	index: number,
	_bp: AppBlueprint,
): ValidationError[] {
	if (mod.case_type && !CASE_TYPE_REGEX.test(mod.case_type)) {
		return [
			validationError(
				"INVALID_CASE_TYPE_FORMAT",
				"module",
				`Module "${mod.name}" has case_type "${mod.case_type}" which isn't a valid identifier. Case type names must start with a letter and can only contain letters, digits, underscores, or hyphens (e.g. "patient", "home_visit", "health-check").`,
				{ moduleIndex: index, moduleName: mod.name },
				{ caseType: mod.case_type },
			),
		];
	}
	return [];
}

export function caseTypeTooLong(
	mod: BlueprintModule,
	index: number,
	_bp: AppBlueprint,
): ValidationError[] {
	if (mod.case_type && mod.case_type.length > MAX_CASE_TYPE_LENGTH) {
		return [
			validationError(
				"CASE_TYPE_TOO_LONG",
				"module",
				`Module "${mod.name}" has a case_type that is ${mod.case_type.length} characters long. CommCare limits case type names to ${MAX_CASE_TYPE_LENGTH} characters. Use a shorter, more descriptive name.`,
				{ moduleIndex: index, moduleName: mod.name },
				{ caseType: mod.case_type },
			),
		];
	}
	return [];
}

export function missingCaseListColumns(
	mod: BlueprintModule,
	index: number,
	_bp: AppBlueprint,
): ValidationError[] {
	if (
		mod.case_type &&
		!mod.case_list_only &&
		mod.forms.length > 0 &&
		(!mod.case_list_columns || mod.case_list_columns.length === 0)
	) {
		return [
			validationError(
				"MISSING_CASE_LIST_COLUMNS",
				"module",
				`Module "${mod.name}" manages "${mod.case_type}" cases but has no case_list_columns. The case list screen needs at least one column (like "name") so users can identify which case to select. Add case_list_columns with the properties you want displayed.`,
				{ moduleIndex: index, moduleName: mod.name },
			),
		];
	}
	return [];
}

/**
 * Collect all case property names saved to a given case type across the app.
 *
 * Walks modules with the target case type AND parent modules that create
 * children of this type — child case creation means a form in a parent
 * module (e.g. "measles_case") can save properties to a child case type
 * (e.g. "contact") via `case_property_on`. The per-question filter
 * (`q.case_property_on === caseType`) ensures only properties targeting
 * the requested type are collected, even when walking a parent module
 * whose own questions save to its primary type.
 */
function collectKnownCaseProperties(
	bp: AppBlueprint,
	caseType: string,
): Set<string> {
	const props = new Set<string>();
	function walk(questions: Question[]) {
		for (const q of questions) {
			if (q.case_property_on === caseType) props.add(q.id);
			if (q.children) walk(q.children);
		}
	}

	const moduleTypes = new Set([caseType]);
	const ct = bp.case_types?.find((c) => c.name === caseType);
	if (ct?.parent_type) moduleTypes.add(ct.parent_type);

	for (const mod of bp.modules) {
		if (!mod.case_type || !moduleTypes.has(mod.case_type)) continue;
		for (const form of mod.forms) {
			walk(form.questions || []);
		}
	}
	return props;
}

/** Case list column fields must reference known case properties or standard properties. */
export function invalidColumnField(
	mod: BlueprintModule,
	index: number,
	bp: AppBlueprint,
): ValidationError[] {
	if (
		!mod.case_type ||
		!mod.case_list_columns ||
		mod.case_list_columns.length === 0
	)
		return [];
	const errors: ValidationError[] = [];
	const knownProps = collectKnownCaseProperties(bp, mod.case_type);

	for (const col of mod.case_list_columns) {
		if (STANDARD_CASE_LIST_PROPERTIES.has(col.field)) continue;
		if (knownProps.has(col.field)) continue;
		errors.push(
			validationError(
				"INVALID_COLUMN_FIELD",
				"module",
				`Module "${mod.name}" has a case list column with field "${col.field}" (header: "${col.header}"), but no question saves to a case property with that name. The case list won't be able to display this column. Either add a question with id "${col.field}" and case_property_on: "${mod.case_type}", or use a standard property like "case_name" or "date_opened".`,
				{ moduleIndex: index, moduleName: mod.name },
				{ field: col.field },
			),
		);
	}
	return errors;
}

export const MODULE_RULES = [
	caseFormsNoCaseType,
	caseListOnlyHasForms,
	caseListOnlyNoCaseType,
	noFormsOrCaseList,
	invalidCaseTypeFormat,
	caseTypeTooLong,
	missingCaseListColumns,
	invalidColumnField,
];
