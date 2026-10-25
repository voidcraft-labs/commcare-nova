/**
 * Where a refusal's finding opens: the one mapping from a gate finding (or a
 * refused media reference) to the builder place that holds it, shared by the
 * case-list workspace's selection review and the platform section's refusal
 * block, so both open a finding the same way.
 *
 * Pure: it returns the navigation to run and runs nothing, so a caller
 * decides what else the Open does (the selection review closes itself; the
 * platform block stays open as the person's checklist).
 */

import type { StructuredCommitFinding } from "@/lib/doc/hooks/useBlueprintMutations";
import { uuidSchema } from "@/lib/domain";
import type { MediaRefLocation } from "@/lib/domain/mediaRefs";
import type { NavigateActions } from "@/lib/routing/navigation";

/** The features whose finding is fixed in the module's Search settings. */
const SEARCH_CONFIG_FEATURES: ReadonlySet<string> = new Set([
	"search-first",
	"search-field-single-date",
	"search-field-multiple-choice",
]);

/** The features whose finding is fixed in the module's case list. */
const CASE_LIST_FEATURES: ReadonlySet<string> = new Set([
	"several-cases",
	"case-list-here",
]);

/**
 * The navigation that opens the place a finding names, or `undefined` when
 * it names no place a person can open (a finding located at the app).
 *
 * In order: a case operation, a form link, a form's display condition, then
 * the form (selecting the finding's field). A platform finding at a module
 * (`details.feature`, which only platform findings carry) opens Search
 * settings or the case list by its feature; any other module finding opens
 * the module.
 */
export function findingOpenAction(
	finding: StructuredCommitFinding,
	navigate: NavigateActions,
): (() => void) | undefined {
	const { location, details } = finding;
	const parsedOperationUuid = uuidSchema.safeParse(details?.operationUuid);
	const operationUuid = parsedOperationUuid.success
		? parsedOperationUuid.data
		: undefined;
	const parsedLinkUuid = uuidSchema.safeParse(details?.linkUuid);
	const linkUuid = parsedLinkUuid.success ? parsedLinkUuid.data : undefined;
	const surface = details?.surface;
	const feature = details?.feature;
	const { moduleUuid, formUuid } = location;
	if (moduleUuid !== undefined && formUuid !== undefined) {
		if (operationUuid !== undefined)
			return () =>
				navigate.openFormOperations(moduleUuid, formUuid, operationUuid);
		if (
			linkUuid !== undefined ||
			finding.code.startsWith("FORM_LINK_") ||
			surface === "form_link_condition" ||
			surface === "form_link_datum_xpath"
		)
			return () => navigate.openFormLinks(moduleUuid, formUuid, linkUuid);
		if (
			finding.code.includes("FORM_DISPLAY_CONDITION") ||
			surface === "form_display_condition"
		)
			return () => navigate.openFormCondition(moduleUuid, formUuid);
		return () => navigate.openForm(moduleUuid, formUuid, location.fieldUuid);
	}
	if (moduleUuid === undefined) return undefined;
	if (feature !== undefined && SEARCH_CONFIG_FEATURES.has(feature))
		return () => navigate.openSearchConfig(moduleUuid);
	if (feature !== undefined && CASE_LIST_FEATURES.has(feature))
		return () => navigate.openCaseList(moduleUuid);
	return () => navigate.openModule(moduleUuid);
}

/** What an Open button names: the field, else the form, else the module. */
export function findingTargetName(
	location: StructuredCommitFinding["location"],
): string {
	return (
		location.fieldId ?? location.formName ?? location.moduleName ?? "this item"
	);
}

/**
 * The navigation that opens a media reference's carrier, or `undefined` for
 * the app logo, which sits in App settings beside the block that lists it.
 */
export function mediaLocationOpenAction(
	location: MediaRefLocation,
	navigate: NavigateActions,
): (() => void) | undefined {
	switch (location.kind) {
		case "app_logo":
			return undefined;
		case "field_media_bundle":
		case "option_media":
			return () =>
				navigate.openForm(
					location.moduleUuid,
					location.formUuid,
					location.fieldUuid,
				);
		case "form_icon":
		case "form_audio_label":
			return () => navigate.openForm(location.moduleUuid, location.formUuid);
		case "module_icon":
		case "module_audio_label":
			return () => navigate.openModule(location.moduleUuid);
		case "case_list_icon":
		case "case_list_audio_label":
		case "image_map_mapping":
			return () => navigate.openCaseList(location.moduleUuid);
	}
}

/** What a media row's Open button names. */
export function mediaLocationTargetName(location: MediaRefLocation): string {
	switch (location.kind) {
		case "app_logo":
			return "the logo";
		case "field_media_bundle":
		case "option_media":
			return location.fieldId;
		case "form_icon":
		case "form_audio_label":
			return location.formName;
		case "module_icon":
		case "module_audio_label":
		case "case_list_icon":
		case "case_list_audio_label":
		case "image_map_mapping":
			return location.moduleName;
	}
}
