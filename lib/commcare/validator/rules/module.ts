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
import { columnKindPropertyType } from "./case-list/columnKindPropertyType";
import { columnReferences } from "./case-list/columnReferences";
import { filterTypeCheck } from "./case-list/filterTypeCheck";
import { idMappingValueRequired } from "./case-list/idMappingValueRequired";
import { matchModeOnDeviceCompatibility } from "./case-list/matchModeOnDeviceCompatibility";
import { matchModeWhitespaceInValue } from "./case-list/matchModeWhitespaceInValue";
import { searchInputDefaultTypeCheck } from "./case-list/searchInputDefaultTypeCheck";
import { searchInputModeMatchesPropertyType } from "./case-list/searchInputModeMatchesPropertyType";
import { searchInputNameUniqueness } from "./case-list/searchInputNameUniqueness";
import { searchInputPredicateTypeCheck } from "./case-list/searchInputPredicateTypeCheck";
import { searchInputRefUsesWhenInputPresent } from "./case-list/searchInputRefUsesWhenInputPresent";
import { searchInputSelectWidgetNotSupported } from "./case-list/searchInputSelectWidgetNotSupported";
import { searchInputTypeMatchesPropertyType } from "./case-list/searchInputTypeMatchesPropertyType";
import { searchInputViaModeCompatibility } from "./case-list/searchInputViaModeCompatibility";
import { sortPriorityUniqueness } from "./case-list/sortPriorityUniqueness";
import { caseSearchConfigRequiresCaseType } from "./case-search/caseSearchConfigRequiresCaseType";
import { caseSearchConfigRequiresSearchableSurface } from "./case-search/caseSearchConfigRequiresSearchableSurface";
import { excludedOwnerIdsTypeCheck } from "./case-search/excludedOwnerIdsTypeCheck";
import { searchButtonDisplayConditionTypeCheck } from "./case-search/searchButtonDisplayConditionTypeCheck";
import { imageMapValueUnique } from "./media/imageMapValueUnique";

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
	// A `caseListOnly` viewer is the ONLY valid formless shape (it maps to
	// CommCare's case-list menu item). Every other module — case-typed OR a
	// plain survey menu — needs at least one form: CommCare rejects a menu with
	// no forms and no case list as a HARD, build-blocking error, regardless of
	// case type (`ModuleValidator.validate_with_raise` in
	// commcare-hq's app_manager/helpers/validators.py: `if not module.forms and
	// not module.case_list.show`). So the check must NOT be gated on caseType —
	// a typeless, formless menu is just as invalid, and Nova is emitting the
	// exact wire CommCare then refuses to build.
	if (mod.caseListOnly || forms.length > 0) return [];
	// One finding, two contexts: creating a module without a form, and removing
	// a module's LAST form. So the wording can't just say "add a form" — that
	// reads backwards when you're deleting. It states the rule, then names the
	// resolutions for both directions (a module always keeps ≥1 form, so to drop
	// the last one you either add another first or remove the whole module).
	const message = mod.caseType
		? `Module "${mod.name}" has a case_type ("${mod.caseType}") but no forms. CommCare needs either forms to interact with cases, or a visible case list — so add a form, make it a case-list-only viewer, or, if you're removing its last form, delete the whole module instead.`
		: `Module "${mod.name}" needs at least one form — CommCare won't build a menu with no forms and no case list. Add a form, or, if you're removing its last one, add another form first or delete the whole module.`;
	return [
		validationError("NO_FORMS_OR_CASE_LIST", "module", message, {
			moduleUuid,
			moduleName: mod.name,
		}),
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
 * Every reachable case list needs at least one visible Results field so a
 * person has something to scan before choosing a case. A definition that is
 * Details-only (or otherwise kept off Results) does not satisfy that floor.
 * This applies equally to form-bearing case modules and case-list-only
 * viewers: the latter have no other screen through which a case can be picked.
 */
function missingCaseListColumns(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const forms = formsOf(doc, moduleUuid);
	const columns = mod.caseListConfig?.columns ?? [];
	const hasVisibleResult = columns.some(
		(column) => column.visibleInList !== false,
	);
	const needsColumns =
		!!mod.caseType &&
		(mod.caseListOnly || forms.length > 0) &&
		!hasVisibleResult;
	if (!needsColumns) return [];
	return [
		validationError(
			"MISSING_CASE_LIST_COLUMNS",
			"module",
			`Module "${mod.name}" shows "${mod.caseType}" cases but its Results screen has no visible fields. Every case list needs at least one visible Results field so users can tell rows apart and pick which case to open. Add or restore an identifying field such as "case_name" on Results.`,
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
	columnKindPropertyType,
	filterTypeCheck,
	calculatedColumnTypeCheck,
	idMappingValueRequired,
	imageMapValueUnique,
	matchModeWhitespaceInValue,
	matchModeOnDeviceCompatibility,
	ancestorExistsCannotNestSubcase,
	sortPriorityUniqueness,
	searchInputNameUniqueness,
	searchInputModeMatchesPropertyType,
	searchInputTypeMatchesPropertyType,
	searchInputSelectWidgetNotSupported,
	searchInputDefaultTypeCheck,
	searchInputPredicateTypeCheck,
	searchInputRefUsesWhenInputPresent,
	searchInputViaModeCompatibility,
	// Case-search-config rules. Slot-specific checks read authored config;
	// structural/conflict checks use `effectiveCaseSearchConfig`, so legacy
	// markerless inputs receive the same validation as the remote request they
	// still emit.
	searchButtonDisplayConditionTypeCheck,
	excludedOwnerIdsTypeCheck,
	caseSearchConfigRequiresSearchableSurface,
	caseSearchConfigRequiresCaseType,
];
