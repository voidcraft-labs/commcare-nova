/**
 * Validation error types for the rule-based validation system.
 *
 * Every validation check produces structured ValidationError objects with
 * typed error codes, scope, location, and optional details for auto-fixes.
 */

// ── Error codes ────────────────────────────────────────────────────

/** All validation error codes — one per distinct check. */
export type ValidationErrorCode =
	// App-level
	| "EMPTY_APP_NAME"
	| "NO_MODULES"
	| "MISSING_CHILD_CASE_MODULE"
	| "RESERVED_CASE_TYPE_NAME"
	| "CONNECT_NO_PARTICIPATING_FORMS"
	// Module-level
	| "NO_CASE_TYPE"
	| "CASE_LIST_ONLY_HAS_FORMS"
	| "CASE_LIST_ONLY_NO_CASE_TYPE"
	| "NO_FORMS_OR_CASE_LIST"
	| "INVALID_CASE_TYPE_FORMAT"
	| "CASE_TYPE_TOO_LONG"
	| "MISSING_CASE_LIST_COLUMNS"
	// Case-list-config rules
	| "CASE_LIST_COLUMN_UNKNOWN_FIELD"
	| "CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH"
	| "CASE_LIST_FILTER_TYPE_ERROR"
	| "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR"
	| "CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY"
	| "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH"
	| "CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH"
	| "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR"
	| "CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR"
	| "CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME"
	| "CASE_LIST_BARE_SEARCH_INPUT_REF"
	| "CASE_LIST_DUPLICATE_SORT_PRIORITY"
	| "CASE_LIST_ID_MAPPING_EMPTY_VALUE"
	| "CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE"
	| "CASE_LIST_MATCH_MODE_TOKENIZES_WHITESPACE"
	| "CASE_LIST_ANCESTOR_EXISTS_NESTS_CROSS_DIRECTION_WALK"
	| "CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE"
	| "CASE_LIST_SEARCH_INPUT_SELECT_WIDGET_NOT_SUPPORTED"
	| "CASE_LIST_MATCH_MODE_NOT_ON_DEVICE"
	| "FIELD_KIND_PROPERTY_TYPE_MISMATCH"
	| "FIELD_KIND_WRITERS_DISAGREE"
	// Case-search-config rules — fire only when `caseSearchConfig`
	// is present on the module. Without it, no `<remote-request>` is
	// emitted, so each rule short-circuits cleanly when the config
	// slot is absent.
	| "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR"
	| "CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR"
	| "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT"
	| "CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE"
	| "CASE_SEARCH_CONFIG_REQUIRES_CASE_TYPE"
	// Form-level
	| "EMPTY_FORM"
	| "NO_CASE_NAME_FIELD"
	| "CASE_NAME_FIELD_MISSING"
	| "RESERVED_CASE_PROPERTY"
	| "CASE_PROPERTY_MISSING_FIELD"
	| "MEDIA_CASE_PROPERTY"
	| "CASE_PRELOAD_MISSING_FIELD"
	| "CASE_PRELOAD_RESERVED"
	| "DUPLICATE_CASE_PROPERTY"
	| "CLOSE_CONDITION_WRONG_TYPE"
	| "CLOSE_FORM_NO_CASE_TYPE"
	| "CLOSE_CONDITION_INCOMPLETE"
	| "CLOSE_CONDITION_FIELD_NOT_FOUND"
	| "INVALID_POST_SUBMIT"
	| "POST_SUBMIT_PARENT_MODULE_UNSUPPORTED"
	| "POST_SUBMIT_MODULE_CASE_LIST_ONLY"
	| "FORM_LINK_EMPTY"
	| "FORM_LINK_TARGET_NOT_FOUND"
	| "FORM_LINK_CIRCULAR"
	| "FORM_LINK_NO_FALLBACK"
	| "FORM_LINK_SELF_REFERENCE"
	| "CONNECT_MISSING_LEARN"
	| "CONNECT_MISSING_DELIVER"
	| "CONNECT_UNQUOTED_XPATH"
	| "CONNECT_EMPTY_XPATH"
	| "CONNECT_ID_INVALID_FORMAT"
	| "CONNECT_ID_TOO_LONG"
	| "CONNECT_ID_MISSING"
	| "CONNECT_ID_DUPLICATE"
	| "CASE_HASHTAG_ON_CREATE_FORM"
	| "PRIMARY_CASE_FIELD_IN_REPEAT"
	| "CHILD_CASE_NO_NAME_FIELD"
	| "DUPLICATE_FIELD_ID"
	| "CASE_PROPERTY_BAD_FORMAT"
	| "CASE_PROPERTY_TOO_LONG"
	// Field-level
	| "SELECT_NO_OPTIONS"
	| "SELECT_TOO_FEW_OPTIONS"
	| "CASE_PROPERTY_ON_UNKNOWN_TYPE"
	| "HIDDEN_NO_VALUE"
	| "REQUIRED_ON_HIDDEN"
	| "CALCULATE_ON_VISIBLE_INPUT"
	| "UNQUOTED_STRING_LITERAL"
	| "INVALID_FIELD_ID"
	| "RESERVED_FIELD_ID_PREFIX"
	| "VALIDATION_ON_NON_INPUT_KIND"
	| "EMPTY_REPEAT_COUNT"
	| "EMPTY_IDS_QUERY"
	| "FIXTURE_REFERENCE_NOT_MODELED"
	// XForm output (post-expansion) — the parse-time oracle's FATAL contract.
	| "XFORM_PARSE_ERROR"
	| "XFORM_NO_INSTANCE"
	| "XFORM_BIND_NO_NODESET"
	| "XFORM_NON_PATH_NODESET"
	| "XFORM_DANGLING_BIND"
	| "XFORM_DANGLING_REF"
	| "XFORM_INVALID_BIND_EXPRESSION"
	| "XFORM_CONTROL_NO_REF"
	| "XFORM_NON_PATH_CONTROL_REF"
	| "XFORM_SELECT_NO_ITEMS"
	| "XFORM_SELECT_ITEMS_AND_ITEMSET"
	| "XFORM_ITEM_INCOMPLETE"
	| "XFORM_SETVALUE_NO_TARGET"
	| "XFORM_INVALID_SETVALUE"
	| "XFORM_INVALID_ACTION_EVENT"
	| "XFORM_INVALID_OUTPUT"
	| "XFORM_REPEAT_BINDS_ROOT"
	| "XFORM_REPEAT_MEMBER_SCOPE"
	| "XFORM_DUPLICATE_TEMPLATE"
	| "XFORM_MISSING_ITEXT"
	| "XFORM_DUPLICATE_ITEXT"
	| "XFORM_TEXT_NO_ID"
	| "XFORM_TEXT_BAD_CHILD"
	| "XFORM_TRANSLATION_NONE"
	| "XFORM_TRANSLATION_NO_LANG"
	| "XFORM_TRANSLATION_DUPLICATE_LANG"
	| "XFORM_TRANSLATION_MULTIPLE_DEFAULT"
	| "XFORM_DANGLING_MEDIA_REF"
	// suite.xml output (post-emit) — the suite-parse + session-runtime oracle.
	// Category 1 (fatal at suite parse) and Category 2 (parse-clean,
	// runtime-fatal cross-references) the device's SuiteParser / session
	// resolver enforce. A suite that trips one is a generator bug, never a
	// fixable authoring state.
	| "SUITE_PARSE_ERROR"
	| "SUITE_NO_SUITE_ELEMENT"
	// Category 1 — fatal at parse.
	| "SUITE_DATUM_NO_VALUE"
	| "SUITE_DATUM_NO_NODESET"
	| "SUITE_DATUM_NON_PATH_VALUE"
	| "SUITE_DATUM_NON_PATH_NODESET"
	| "SUITE_DATA_NO_REF"
	| "SUITE_DATA_NON_PATH_REF"
	| "SUITE_DETAIL_NO_TITLE"
	| "SUITE_FIELD_NO_HEADER"
	| "SUITE_FIELD_NO_TEMPLATE"
	| "SUITE_ENTRY_NO_DISPLAY"
	| "SUITE_INVALID_XPATH"
	| "SUITE_NON_PATH_XPATH"
	| "SUITE_QUERY_NO_URL"
	| "SUITE_QUERY_NO_STORAGE_INSTANCE"
	| "SUITE_REMOTE_REQUEST_NO_POST"
	| "SUITE_POST_NO_URL"
	| "SUITE_PROMPT_NO_KEY"
	| "SUITE_PROMPT_DUPLICATE_KEY"
	| "SUITE_STACK_BAD_OP"
	| "SUITE_VERSION_NOT_INTEGER"
	// Category 2 — parse-clean, runtime-fatal cross-references.
	| "SUITE_MENU_COMMAND_UNRESOLVED"
	| "SUITE_DETAIL_SELECT_UNRESOLVED"
	| "SUITE_DETAIL_CONFIRM_UNRESOLVED"
	| "SUITE_MISSING_INSTANCE"
	| "SUITE_DUPLICATE_INSTANCE"
	| "SUITE_MISSING_LOCALE"
	| "SUITE_DUPLICATE_COMMAND"
	| "SUITE_DUPLICATE_DETAIL"
	// Sort — silently tolerated by the device (behaves-wrong, never throws).
	| "SUITE_SORT_BAD_ORDER"
	| "SUITE_SORT_BAD_DIRECTION"
	| "SUITE_SORT_BAD_TYPE"
	| "SUITE_SORT_BAD_BLANKS"
	// Media wire-path resolution against the bundled-media manifest. Fires on
	// menu-borne locale media values (`<text form="image"><locale id>` →
	// app_strings → jr://file/<path>) and image-map column templates
	// (`<template form="image"><text><xpath function>` with inlined jr://
	// literals). A dangling reference parses clean and renders as a broken
	// icon on device.
	| "SUITE_DANGLING_MEDIA_REF"
	// HQ import JSON (post-expansion) — the deserialization (`Application.wrap`)
	// contract. A violation here makes CCHQ's CouchDB `DocumentSchema` wrap raise
	// `BadValueError` / `ValueError` and rejects the whole app at import. A
	// generator that trips one is an `expandDoc` bug, never a fixable authoring
	// state.
	| "HQJSON_BAD_DOC_TYPE"
	| "HQJSON_BAD_MODULE_DOC_TYPE"
	| "HQJSON_BAD_FORM_DOC_TYPE"
	| "HQJSON_BAD_CONDITION_TYPE"
	| "HQJSON_BAD_CONDITION_OPERATOR"
	| "HQJSON_BAD_FORM_REQUIRES"
	| "HQJSON_BAD_POST_FORM_WORKFLOW"
	| "HQJSON_BAD_UPDATE_MODE"
	| "HQJSON_BAD_SUBCASE_RELATIONSHIP"
	| "HQJSON_BAD_DETAIL_DISPLAY"
	| "HQJSON_BAD_TYPE"
	// `multimedia_map` shape regression guard. CCHQ's
	// `suite_xml/generator.py::media_resources` RAISES `MediaResourceError`
	// when a `multimedia_map` key doesn't start with `jr://file/`, and the
	// `media_type` value must be one of the closed CommCare media class
	// names (`CommCareImage` / `CommCareAudio` / `CommCareVideo`). Menu
	// media dicts (`media_image` / `media_audio`) and the web-apps logo
	// (`logo_refs.hq_logo_web_apps.path`) carry the same `jr://file/`
	// prefix contract — the suite the runtime parses from the upload is
	// regenerated off these dicts.
	| "HQJSON_BAD_MULTIMEDIA_MAP_KEY"
	| "HQJSON_BAD_MULTIMEDIA_MAP_MEDIA_TYPE"
	| "HQJSON_BAD_NAV_MEDIA_VALUE"
	| "HQJSON_BAD_LOGO_REF"
	// Binding-resolution oracle (post-expansion) — JavaRosa's install-time XPath
	// resolution contract. A reference an expression makes that can't be
	// resolved against the form's symbol space crashes JavaRosa at form-init,
	// surfaced on device as "A part of your application is invalid". The
	// parse-time oracle (XFORM_* above) only proves the XPath PARSES; this
	// oracle proves it RESOLVES.
	| "BINDING_RESOLUTION_INSTANCE_UNDECLARED"
	| "BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED"
	| "BINDING_RESOLUTION_SESSION_CONTEXT_UNKNOWN"
	| "BINDING_RESOLUTION_MEDIA_REF_UNDECLARED"
	// `media_suite.xml` parse contract. CommCare's runtime parses the file
	// through the generic `SuiteParser` + `ResourceParser` machinery; each
	// `<media>` block contributes one or more `<resource>` entries, and the
	// installer (`BasicInstaller`) routes through the resource's
	// `<location authority="local">` to read its bundled bytes. Category-1
	// codes are fatal at parse (KXmlParser throws or `parseInt` fails);
	// Category-2 codes parse clean but render the media unusable at install.
	| "MEDIA_SUITE_PARSE_ERROR"
	| "MEDIA_SUITE_NO_SUITE_ELEMENT"
	| "MEDIA_SUITE_VERSION_NOT_INTEGER"
	| "MEDIA_NO_PATH"
	| "MEDIA_NO_RESOURCE"
	| "MEDIA_RESOURCE_NO_ID"
	| "MEDIA_RESOURCE_VERSION_NOT_INTEGER"
	| "MEDIA_RESOURCE_NO_LOCATION"
	| "MEDIA_LOCATION_NO_AUTHORITY"
	| "MEDIA_LOCATION_NO_PATH"
	| "MEDIA_LOCATION_UNKNOWN_AUTHORITY"
	| "MEDIA_RESOURCE_DUPLICATE_ID"
	| "MEDIA_LOCATION_PATH_NOT_BUNDLED"
	// Media — the three asset-context rules under `rules/media/`. Each
	// fires only when the validator runs with a resolved asset manifest
	// (the SA validation loop's path); structural rules (e.g. image-map
	// duplicate values) live alongside the case-list rules and fire
	// regardless of manifest presence.
	| "MEDIA_ASSET_NOT_FOUND"
	| "MEDIA_ASSET_NOT_READY"
	| "MEDIA_KIND_MISMATCH"
	// Aggregate export-budget guard (not a per-ref rule): the media-ON
	// compile / HQ-upload paths load every referenced ready asset into
	// memory at once, so the total count + bytes are bounded before any
	// download. Fires from `collectBoundaryViolations`, not a rule file.
	| "MEDIA_EXPORT_TOO_LARGE"
	// XPath deep (from existing pipeline)
	| "XPATH_SYNTAX"
	| "UNKNOWN_FUNCTION"
	| "WRONG_ARITY"
	| "INVALID_REF"
	| "INVALID_CASE_REF"
	| "CYCLE"
	| "TYPE_ERROR";

// ── Error location ─────────────────────────────────────────────────

import type { Uuid } from "@/lib/domain";

/**
 * Where a validation error occurred in the normalized domain doc.
 *
 * UUIDs are the canonical references: `moduleUuid`, `formUuid`, `fieldUuid`.
 * Names (`moduleName`, `formName`) and the semantic `fieldId` are duplicated
 * at the boundary for human-readable error messages and for the validation
 * loop's stuck-detection signature. The `field` key is the property being
 * validated (e.g. `relevant`, `calculate`) — NOT a uuid.
 */
export interface ValidationLocation {
	moduleUuid?: Uuid;
	moduleName?: string;
	formUuid?: Uuid;
	formName?: string;
	fieldUuid?: Uuid;
	fieldId?: string;
	field?: string;
}

// ── Structured error ───────────────────────────────────────────────

export interface ValidationError {
	code: ValidationErrorCode;
	scope: "app" | "module" | "form" | "field";
	message: string;
	location: ValidationLocation;
	/** Extra context for auto-fixes (e.g. reserved property name, suggested fix). */
	details?: Record<string, string>;
}

// ── Factory ────────────────────────────────────────────────────────

export function validationError(
	code: ValidationErrorCode,
	scope: ValidationError["scope"],
	message: string,
	location: ValidationLocation,
	details?: Record<string, string>,
): ValidationError {
	return { code, scope, message, location, details };
}

// ── String rendering ───────────────────────────────────────────────

/**
 * Render a ValidationError as a human-readable string.
 * Messages are self-contained sentences — no fragment concatenation needed.
 */
export function errorToString(err: ValidationError): string {
	return err.message;
}

// ── Media error category ───────────────────────────────────────────

/**
 * The media-category validation codes — the union of every rule that
 * fires on a media reference or a media-bearing case-list column. Two
 * groups:
 *
 *   - the three asset-context rules under `rules/media/` (existence /
 *     ready / kind-match), which fire only when `runValidation` runs
 *     with a resolved asset manifest, and
 *   - `imageMapValueUnique`, a doc-structural rule registered in
 *     `MODULE_RULES` that fires regardless of manifest presence. Its
 *     code carries the `CASE_LIST_` prefix (it's a case-list-column
 *     rule by shape) — listed explicitly here because a prefix-based
 *     filter would silently drop it.
 *
 * The export boundary gate no longer filters to this set (it rejects on
 * EVERY validator finding — `gate.ts::evaluateBoundary`); the set remains
 * the named definition of the media category, pinned by the gate tests so
 * the environment-class classification can't silently drift. A new media
 * rule adds its code here beside its `ValidationErrorCode` entry.
 */
export const MEDIA_VALIDATION_CODES: ReadonlySet<ValidationErrorCode> = new Set(
	[
		"MEDIA_ASSET_NOT_FOUND",
		"MEDIA_ASSET_NOT_READY",
		"MEDIA_KIND_MISMATCH",
		"CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE",
	],
);
