/**
 * Module-level validation rules.
 *
 * Each rule receives the `BlueprintDoc`, the module entity, and the module's
 * uuid so errors carry stable provenance. The runner invokes every rule on
 * every module.
 */

import { CASE_TYPE_REGEX, MAX_CASE_TYPE_LENGTH } from "@/lib/commcare";
import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../errors";
import { ancestorExistsCannotNestSubcase } from "./case-list/ancestorExistsCannotNestSubcase";
import { calculatedColumnTypeCheck } from "./case-list/calculatedColumnTypeCheck";
import { columnReferences } from "./case-list/columnReferences";
import { filterTypeCheck } from "./case-list/filterTypeCheck";
import { idMappingValueRequired } from "./case-list/idMappingValueRequired";
import { matchModeWhitespaceInValue } from "./case-list/matchModeWhitespaceInValue";
import { searchInputDefaultTypeCheck } from "./case-list/searchInputDefaultTypeCheck";
import { searchInputModeMatchesPropertyType } from "./case-list/searchInputModeMatchesPropertyType";
import { searchInputNameUniqueness } from "./case-list/searchInputNameUniqueness";
import { searchInputPredicateTypeCheck } from "./case-list/searchInputPredicateTypeCheck";
import { searchInputRefUsesWhenInputPresent } from "./case-list/searchInputRefUsesWhenInputPresent";
import { searchInputTypeMatchesPropertyType } from "./case-list/searchInputTypeMatchesPropertyType";
import { searchInputViaModeCompatibility } from "./case-list/searchInputViaModeCompatibility";
import { sortPriorityUniqueness } from "./case-list/sortPriorityUniqueness";
import { caseSearchConfigRequiresSearchableSurface } from "./case-search/caseSearchConfigRequiresSearchableSurface";
import { excludedOwnerIdsTypeCheck } from "./case-search/excludedOwnerIdsTypeCheck";
import { filterSearchInputConflict } from "./case-search/filterSearchInputConflict";
import { searchButtonDisplayConditionTypeCheck } from "./case-search/searchButtonDisplayConditionTypeCheck";

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
 * Modules with cases but no case-list columns are unusable — the case
 * list screen has no row content to render. The columns array is the
 * single display source: every entry in it is a column the runtime
 * may render (visibility flags gate per-surface display, not the
 * "is this a column" check), so non-emptiness of the array is the
 * condition.
 */
function missingCaseListColumns(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const forms = formsOf(doc, moduleUuid);
	const columns = mod.caseListConfig?.columns ?? [];
	const needsColumns =
		!!mod.caseType &&
		!mod.caseListOnly &&
		forms.length > 0 &&
		columns.length === 0;
	if (!needsColumns) return [];
	return [
		validationError(
			"MISSING_CASE_LIST_COLUMNS",
			"module",
			`Module "${mod.name}" manages "${mod.caseType}" cases but its case list has no columns. The case list screen needs at least one column so users can tell rows apart and pick which case to open. Add a column to \`caseListConfig.columns\` — usually something identifying like "name" — so the list has something to render.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}

export const MODULE_RULES = [
	caseFormsNoCaseType,
	caseListOnlyHasForms,
	caseListOnlyNoCaseType,
	noFormsOrCaseList,
	invalidCaseTypeFormat,
	caseTypeTooLong,
	missingCaseListColumns,
	// Case-list-config rules (sit at module scope; the cross-form
	// kind-vs-property-type rule lives at app scope in `app.ts`).
	columnReferences,
	filterTypeCheck,
	calculatedColumnTypeCheck,
	idMappingValueRequired,
	matchModeWhitespaceInValue,
	ancestorExistsCannotNestSubcase,
	sortPriorityUniqueness,
	searchInputNameUniqueness,
	searchInputModeMatchesPropertyType,
	searchInputTypeMatchesPropertyType,
	searchInputDefaultTypeCheck,
	searchInputPredicateTypeCheck,
	searchInputRefUsesWhenInputPresent,
	searchInputViaModeCompatibility,
	// Case-search-config rules — fire only when `caseSearchConfig`
	// is present on the module; otherwise the module emits no
	// `<remote-request>` and these rules have no authoring concern
	// to gate.
	searchButtonDisplayConditionTypeCheck,
	excludedOwnerIdsTypeCheck,
	filterSearchInputConflict,
	caseSearchConfigRequiresSearchableSurface,
];
