/**
 * Module-level validation rules.
 *
 * Each rule receives the `BlueprintDoc`, the module entity, and the module's
 * uuid so errors carry stable provenance. The runner invokes every rule on
 * every module.
 */

import {
	CASE_TYPE_REGEX,
	MAX_CASE_TYPE_LENGTH,
	STANDARD_CASE_LIST_PROPERTIES,
} from "@/lib/commcare";
import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../errors";
import { collectCaseProperties } from "../index";

function formsOf(doc: BlueprintDoc, moduleUuid: Uuid) {
	return (doc.formOrder[moduleUuid] ?? []).map((uuid) => doc.forms[uuid]);
}

function caseFormsNoCaseType(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const forms = formsOf(doc, moduleUuid);
	const hasCaseForms = forms.some((f) => f.type !== "survey");
	if (!hasCaseForms || mod.caseType) return [];
	return [
		validationError(
			"NO_CASE_TYPE",
			"module",
			`Module "${mod.name}" has registration, followup, or close forms but no case_type. These form types require cases, so the module needs to know which case type to work with. Set case_type to the type of case this module manages (e.g. "patient", "household").`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}

function caseListOnlyHasForms(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const forms = formsOf(doc, moduleUuid);
	if (!mod.caseListOnly || forms.length === 0) return [];
	return [
		validationError(
			"CASE_LIST_ONLY_HAS_FORMS",
			"module",
			`Module "${mod.name}" is marked as case_list_only (a viewer for existing cases) but also has forms. A case_list_only module just shows a list — it can't contain forms. Either remove the forms or remove the case_list_only flag.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}

function caseListOnlyNoCaseType(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	if (!mod.caseListOnly || mod.caseType) return [];
	return [
		validationError(
			"CASE_LIST_ONLY_NO_CASE_TYPE",
			"module",
			`Module "${mod.name}" is marked as case_list_only but has no case_type. A case list viewer needs to know which type of cases to display. Set case_type to the case type this module should list.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}

function noFormsOrCaseList(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const forms = formsOf(doc, moduleUuid);
	if (mod.caseListOnly || !mod.caseType || forms.length > 0) return [];
	return [
		validationError(
			"NO_FORMS_OR_CASE_LIST",
			"module",
			`Module "${mod.name}" has a case_type ("${mod.caseType}") but no forms. CommCare needs either forms to interact with cases, or a visible case list. If this module is just for viewing cases, set case_list_only: true. Otherwise, add forms.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}

function invalidCaseTypeFormat(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	if (!mod.caseType || CASE_TYPE_REGEX.test(mod.caseType)) return [];
	return [
		validationError(
			"INVALID_CASE_TYPE_FORMAT",
			"module",
			`Module "${mod.name}" has case_type "${mod.caseType}" which isn't a valid identifier. Case type names must start with a letter and can only contain letters, digits, underscores, or hyphens (e.g. "patient", "home_visit", "health-check").`,
			{ moduleUuid, moduleName: mod.name },
			{ caseType: mod.caseType },
		),
	];
}

function caseTypeTooLong(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	if (!mod.caseType || mod.caseType.length <= MAX_CASE_TYPE_LENGTH) return [];
	return [
		validationError(
			"CASE_TYPE_TOO_LONG",
			"module",
			`Module "${mod.name}" has a case_type that is ${mod.caseType.length} characters long. CommCare limits case type names to ${MAX_CASE_TYPE_LENGTH} characters. Use a shorter, more descriptive name.`,
			{ moduleUuid, moduleName: mod.name },
			{ caseType: mod.caseType },
		),
	];
}

/**
 * Modules with cases but no case-list display columns are unusable —
 * the case list screen has no row content to render. The check
 * walks `caseListConfig.columns` and counts entries with a `field`
 * binding (every column kind in the discriminated union carries
 * `field`, so the property reference is uniform across kinds).
 *
 * Search-only columns are not displayed; they don't satisfy the
 * "at least one displayed column" requirement.
 */
function missingCaseListColumns(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const forms = formsOf(doc, moduleUuid);
	const displayColumns = (mod.caseListConfig?.columns ?? []).filter(
		(col) => col.kind !== "search-only",
	);
	const needsColumns =
		!!mod.caseType &&
		!mod.caseListOnly &&
		forms.length > 0 &&
		displayColumns.length === 0;
	if (!needsColumns) return [];
	return [
		validationError(
			"MISSING_CASE_LIST_COLUMNS",
			"module",
			`Module "${mod.name}" manages "${mod.caseType}" cases but has no case-list columns. The case list screen needs at least one displayed column (like "name") so users can identify which case to select. Configure caseListConfig.columns with the properties you want displayed.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}

/**
 * Case-list column `field` references must resolve to a known
 * case property on the module's case type — either a standard
 * property (`case_name`, `date_opened`, etc.) or a property
 * declared by a field with `case_property_on === mod.caseType`.
 *
 * Walks every column on `caseListConfig.columns` regardless of
 * kind: every kind in the discriminated union carries a `field`
 * slot, and every kind's runtime renderer reads the case property
 * by that name.
 */
function invalidColumnField(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const columns = mod.caseListConfig?.columns ?? [];
	if (!mod.caseType || columns.length === 0) {
		return [];
	}
	const errors: ValidationError[] = [];
	const knownProps = collectCaseProperties(doc, mod.caseType) ?? new Set();

	for (const col of columns) {
		if (STANDARD_CASE_LIST_PROPERTIES.has(col.field)) continue;
		if (knownProps.has(col.field)) continue;
		errors.push(
			validationError(
				"INVALID_COLUMN_FIELD",
				"module",
				`Module "${mod.name}" has a case-list column with field "${col.field}" (header: "${col.header}"), but no field saves to a case property with that name. The case list won't be able to display this column. Either add a field with id "${col.field}" and \`case_property_on\`: "${mod.caseType}", or use a standard property like "case_name" or "date_opened".`,
				{ moduleUuid, moduleName: mod.name },
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
