/**
 * Validation error types for the rule-based validation system.
 *
 * Every validation check produces structured ValidationError objects with
 * typed error codes, scope, location, and optional details for auto-fixes.
 */

// ── Error codes ────────────────────────────────────────────────────

/** All validation error codes — one per distinct check. */
export type ValidationErrorCode =
	| "ENTRY_POINT_INVALID"
	| "SUITE_ENDPOINT_INVALID"
	// App-level
	| "EMPTY_APP_NAME"
	| "NO_MODULES"
	| "MISSING_CHILD_CASE_MODULE"
	| "RESERVED_CASE_TYPE_NAME"
	| "CONNECT_NO_PARTICIPATING_FORMS"
	| "BLUEPRINT_TOPOLOGY_INVALID"
	| "BLUEPRINT_ENTITY_UUID_DUPLICATE"
	| "MUTATION_IDENTITY_COLLISION"
	| "MUTATION_SEQUENCE_ANCHOR_INVALID"
	| "MUTATION_TARGET_INVALID"
	| "MUTATION_CASE_PROPERTY_RENAME_INVALID"
	| "MUTATION_WIRE_CANONICALITY_INVALID"
	| "CASE_PROPERTY_REFERENCE_INVALID"
	| "CASE_PROPERTY_OPTION_VALUE_INVALID"
	| "CASE_PROPERTY_XPATH_INCOMPATIBLE"
	| "XPATH_INSTANCE_UNAVAILABLE"
	| "AUTOMATION_INVALID"
	| "TRANSLATION_UNIT_UNKNOWN"
	| "TRANSLATION_VALUE_KIND_MISMATCH"
	| "TRANSLATION_REQUIRED_CONTENT_BLANK"
	| "TRANSLATION_PROTECTED_CONTENT_CHANGED"
	| "APP_STRING_VALUE_UNREPRESENTABLE"
	// User properties, user types, personas
	| "USER_PROPERTY_SLUG_INVALID"
	| "USER_PROPERTY_SLUG_DUPLICATE"
	| "USER_PROPERTY_CHOICES_DUPLICATE"
	| "USER_TYPE_NAME_DUPLICATE"
	| "PERSONA_NAME_DUPLICATE"
	| "PERSONA_USER_TYPE_UNKNOWN"
	| "USER_DATA_UNKNOWN_PROPERTY"
	| "USER_DATA_INVALID_CHOICE"
	| "USER_PROPERTY_REFERENCE_UNKNOWN"
	// Organization levels, place information, persona assignment
	| "ORGANIZATION_LEVEL_CODE_DUPLICATE"
	| "ORGANIZATION_LEVEL_NAME_DUPLICATE"
	| "ORGANIZATION_LEVEL_PARENT_UNKNOWN"
	| "ORGANIZATION_LEVEL_CYCLE"
	| "ORGANIZATION_LEVEL_REFERENCE_UNKNOWN"
	| "ORGANIZATION_LEVEL_CAP_NOT_BELOW"
	| "ORGANIZATION_LEVEL_SCOPE_GAP"
	| "ORGANIZATION_LEVEL_SCOPE_NOT_ANCESTOR"
	| "ORGANIZATION_REVERSE_OWNER_DESTINATION_LIMIT"
	| "LOCATION_PROPERTY_SLUG_INVALID"
	| "LOCATION_PROPERTY_SLUG_DUPLICATE"
	| "LOCATION_PROPERTY_LEVEL_UNKNOWN"
	| "LOCATION_PROPERTY_REQUIRED_CAPACITY"
	| "PERSONA_LOCATION_PRIMARY_REPEATED"
	// Module-level
	| "NO_CASE_TYPE"
	| "CASE_LIST_ONLY_HAS_FORMS"
	| "CASE_LIST_ONLY_NO_CASE_TYPE"
	| "NO_FORMS_OR_CASE_LIST"
	| "NESTED_MENU_CROSS_TYPE_ROOT_REQUIRES_FORM"
	| "INVALID_CASE_TYPE_FORMAT"
	| "CASE_TYPE_TOO_LONG"
	| "MISSING_CASE_LIST_COLUMNS"
	| "MODULE_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE"
	| "MODULE_DISPLAY_CONDITION_TYPE_ERROR"
	| "FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE"
	| "FORM_DISPLAY_CONDITION_TYPE_ERROR"
	| "DISPLAY_CONDITION_SEARCH_INPUT_UNAVAILABLE"
	| "DISPLAY_CONDITION_NOT_ON_DEVICE"
	| "DISPLAY_CONDITION_ALWAYS_FALSE"
	// Case-list-config rules
	| "CASE_LIST_COLUMN_UNKNOWN_FIELD"
	| "CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH"
	| "CASE_LIST_COLUMN_OVER_ATTACHMENT_SLOT"
	| "CASE_LIST_FILTER_TYPE_ERROR"
	| "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR"
	| "CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY"
	| "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH"
	| "CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH"
	| "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR"
	| "CASE_LIST_SEARCH_INPUT_DEFAULT_CASE_DATA_UNAVAILABLE"
	| "CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR"
	| "CASE_LIST_SEARCH_INPUT_REQUIRED_CONDITION_TYPE_ERROR"
	| "CASE_LIST_SEARCH_INPUT_REQUIRED_CONDITION_CASE_DATA_UNAVAILABLE"
	| "CASE_LIST_SEARCH_INPUT_VALIDATION_RULE_TYPE_ERROR"
	| "CASE_LIST_SEARCH_INPUT_VALIDATION_RULE_CASE_DATA_UNAVAILABLE"
	| "CASE_LIST_SEARCH_INPUT_HIDDEN_VALUE_TYPE_ERROR"
	| "CASE_LIST_SEARCH_INPUT_HIDDEN_VALUE_CASE_DATA_UNAVAILABLE"
	| "CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_SCOPE"
	| "CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_TYPE_ERROR"
	| "CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_NOT_ON_DEVICE"
	| "CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME"
	| "CASE_LIST_BARE_SEARCH_INPUT_REF"
	| "CASE_LIST_DUPLICATE_SORT_PRIORITY"
	| "CASE_LIST_ID_MAPPING_EMPTY_VALUE"
	| "CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE"
	| "CASE_LIST_MATCH_MODE_TOKENIZES_WHITESPACE"
	| "CASE_LIST_ANCESTOR_EXISTS_NESTS_CROSS_DIRECTION_WALK"
	| "CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE"
	| "CASE_LIST_MULTI_SELECT_INPUT_NEEDS_DIRECT_MATCH"
	| "CASE_LIST_MATCH_MODE_NOT_ON_DEVICE"
	| "CASE_LIST_DATE_ADD_NOT_ON_DEVICE"
	| "CASE_LIST_EXPRESSION_NOT_ON_DEVICE"
	| "CASE_LIST_STRICT_NULL_NOT_PORTABLE"
	| "CASE_LIST_CSQL_NOT_REPRESENTABLE"
	| "MULTI_SELECT_PERSISTENT_TILE"
	| "MULTI_SELECT_NO_BATCH_CONSUMER"
	// Case-tile layout rules. Geometry rules run on every stored cell,
	// tile layout on or off, so switching the layout back on can never
	// be rejected for a cell the author cannot currently see. The
	// coverage rule runs only while the layout is on, and only for
	// columns the tile shows.
	| "CASE_LIST_TILE_CELL_OUT_OF_GRID"
	| "CASE_LIST_TILE_CELLS_OVERLAP"
	| "CASE_LIST_TILE_COLUMN_NOT_PLACED"
	| "CASE_LIST_TILE_GROUP_HEADER_ROWS_OUT_OF_RANGE"
	| "CASE_LIST_TILE_GROUP_CELL_STRADDLES_HEADER"
	| "CASE_LIST_TILE_GROUP_HEADER_EMPTY"
	| "FIELD_KIND_PROPERTY_TYPE_MISMATCH"
	| "FIELD_KIND_WRITERS_DISAGREE"
	// Case-search rules. Slot-specific checks read authored
	// `caseSearchConfig`; structural compatibility checks follow effective
	// Search, including the markerless-input path that also emits Search.
	| "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR"
	| "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE"
	| "CASE_SEARCH_EXCLUDED_OWNER_IDS_CASE_DATA_UNAVAILABLE"
	| "CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR"
	| "CASE_SEARCH_RELATED_CALCULATION_UNREPRESENTABLE"
	| "CASE_SEARCH_CONFIG_REQUIRES_CASE_TYPE"
	| "SEARCH_FIRST_REQUIRES_CASE_FIRST_MODULE"
	| "SEARCH_FIRST_NO_BUTTON_DISPLAY_CONDITION"
	| "SEARCH_FIRST_NO_PREVIOUS_WORKFLOW"
	| "SEARCH_FIRST_UNIQUE_INSTANCE"
	| "SEARCH_NO_MATCHES_DUPLICATE"
	// Form-level
	| "EMPTY_FORM"
	| "FORM_SECTION_NOT_TOP_LEVEL"
	| "FORM_SECTIONS_INCOMPLETE"
	| "FORM_SECTION_USER_REPEAT"
	| "CASE_WRITE_NO_CASE_ACTION"
	| "CASE_WRITE_NOT_DIRECT_CHILD"
	| "CASE_WRITE_DUPLICATE_PROPERTY"
	| "CASE_CREATE_NAME_MISSING"
	| "CASE_CREATE_NAME_DUPLICATE"
	| "RESERVED_CASE_PROPERTY"
	| "CAPTURE_CASE_WRITE_STANDARD_PROPERTY"
	| "FORM_TOO_MANY_ATTACHMENTS"
	| "CLOSE_CONDITION_WRONG_TYPE"
	| "CLOSE_FORM_NO_CASE_TYPE"
	| "CLOSE_CONDITION_INCOMPLETE"
	| "CLOSE_CONDITION_FIELD_NOT_FOUND"
	| "INVALID_POST_SUBMIT"
	| "POST_SUBMIT_MODULE_CASE_LIST_ONLY"
	| "FORM_LINK_EMPTY"
	| "FORM_LINK_TARGET_NOT_FOUND"
	| "FORM_LINK_TARGET_NO_MATCHES_FORM"
	| "SEARCH_NO_MATCHES_ENTRY_REQUIRES_SEARCH_FIRST"
	| "SEARCH_NO_MATCHES_ENTRY_NOT_REGISTRATION"
	| "SEARCH_NO_MATCHES_ENTRY_HAS_NAVIGATION"
	| "SEARCH_NO_MATCHES_ENTRY_MULTIPLE_RETURN"
	| "SEARCH_NO_MATCHES_ENTRY_PARENT_NEEDS_MENU_FORM"
	| "FORM_LINK_CIRCULAR"
	| "FORM_LINK_NO_FALLBACK"
	| "FORM_LINK_SELF_REFERENCE"
	| "FORM_LINK_UNREACHABLE"
	| "FORM_LINK_DATUMS_INCOMPLETE"
	| "FORM_LINK_DATUM_UNUSED"
	| "FORM_LINK_SELECTION_CARDINALITY"
	| "FORM_LINK_SELECTION_CASE_TYPE_CHANGED"
	| "MULTI_SELECT_FANOUT_CHILD_DATUM"
	| "MULTI_SELECT_SHARED_CASE_EXPRESSION"
	| "MULTI_SELECT_APP_OPERATION_CASE_READ"
	| "MULTI_SELECT_AUTHORED_KEY_CREATE"
	| "MULTI_SELECT_SESSION_OPERATION_LINK"
	| "MULTI_SELECT_OPERATION_ORDER"
	| "CONNECT_UNQUOTED_XPATH"
	| "CONNECT_EMPTY_XPATH"
	| "CONNECT_MODE_MISMATCH"
	| "CONNECT_ID_INVALID_FORMAT"
	| "CONNECT_ID_TOO_LONG"
	| "CONNECT_ID_DUPLICATE"
	| "CASE_HASHTAG_ON_CREATE_FORM"
	| "PRIMARY_CASE_FIELD_IN_REPEAT"
	| "USERCASE_WRITE_UNDECLARED_PROPERTY"
	| "USERCASE_WRITE_MANAGED_PROPERTY"
	| "USERCASE_FIELD_IN_REPEAT"
	| "DUPLICATE_FIELD_ID"
	| "CASE_PROPERTY_BAD_FORMAT"
	| "CASE_PROPERTY_TOO_LONG"
	| "CASE_OPERATION_DUPLICATE_UUID"
	| "CASE_OPERATION_INVALID_ID"
	| "CASE_OPERATION_DUPLICATE_ID"
	| "CASE_OPERATION_INVALID_FACETS"
	| "CASE_OPERATION_UNKNOWN_CASE_TYPE"
	| "CASE_OPERATION_INVALID_CASE_TYPE"
	| "CASE_OPERATION_RESERVED_CASE_TYPE"
	| "CASE_OPERATION_UNKNOWN_PROPERTY"
	| "CASE_OPERATION_RESERVED_PROPERTY"
	| "CASE_OPERATION_EXPRESSION_TYPE"
	| "CASE_OPERATION_TARGET_INVALID"
	| "CASE_OPERATION_TARGET_TYPE_MISMATCH"
	| "CASE_OPERATION_REFERENCE_ORDER"
	| "CASE_OPERATION_EXECUTION_ORDER"
	| "CASE_OPERATION_REPEAT_INVALID"
	| "CASE_OPERATION_REPEAT_CORRELATION"
	| "CASE_OPERATION_AMBIGUOUS_REFERENCE"
	| "CASE_OPERATION_SESSION_UNAVAILABLE"
	| "CASE_OPERATION_LINK_INVALID"
	| "CASE_OPERATION_RETYPE_UNSAFE"
	// Field-level
	| "SELECT_NO_OPTIONS"
	| "SELECT_TOO_FEW_OPTIONS"
	| "SELECT_OPTION_VALUE_INVALID"
	| "CASE_WRITE_UNKNOWN_TYPE"
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
	| "LOOKUP_SELECT_FILTER_TERM_NOT_ALLOWED"
	| "LOOKUP_SELECT_FILTER_FIELD_NOT_EARLIER"
	| "LOOKUP_SELECT_FILTER_FIELD_REPEAT_SCOPE"
	| "LOOKUP_SELECT_FILTER_TYPE_ERROR"
	| "LOOKUP_SELECT_FILTER_NOT_ON_DEVICE"
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
	| "XFORM_ITEMSET_INVALID"
	| "SUITE_FIXTURE_INVALID"
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
	| "XFORM_TRANSLATION_NO_DEFAULT"
	| "XFORM_TRANSLATION_MULTIPLE_DEFAULT"
	| "XFORM_TRANSLATION_INCOMPLETE"
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
	| "SUITE_FIELD_STYLE_INVALID"
	| "SUITE_DETAIL_GROUP_INVALID"
	| "SUITE_ENTRY_NO_DISPLAY"
	| "SUITE_INVALID_XPATH"
	| "SUITE_NON_PATH_XPATH"
	| "SUITE_QUERY_NO_URL"
	| "SUITE_QUERY_NO_STORAGE_INSTANCE"
	| "SUITE_STACK_QUERY_INVALID"
	| "SUITE_REMOTE_REQUEST_NO_POST"
	| "SUITE_POST_NO_URL"
	| "SUITE_PROMPT_NO_KEY"
	| "SUITE_PROMPT_DUPLICATE_KEY"
	| "SUITE_STACK_BAD_OP"
	| "SUITE_VERSION_NOT_INTEGER"
	// Category 2 — parse-clean, runtime-fatal cross-references.
	| "SUITE_MENU_COMMAND_UNRESOLVED"
	| "SUITE_MENU_ROOT_UNRESOLVED"
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
	| "HQJSON_BAD_ROOT_MODULE_ID"
	| "HQJSON_BAD_PARENT_SELECT_MODULE_ID"
	| "HQJSON_BAD_FORM_DOC_TYPE"
	| "HQJSON_BAD_CONDITION_TYPE"
	| "HQJSON_BAD_CONDITION_OPERATOR"
	| "HQJSON_BAD_FORM_REQUIRES"
	| "HQJSON_BAD_POST_FORM_WORKFLOW"
	| "HQJSON_BAD_POST_FORM_WORKFLOW_FALLBACK"
	| "HQJSON_BAD_FORM_LINK"
	| "HQJSON_BAD_CASE_LIST_FORM"
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
	// Lookup references — structural carrier vs Project definition snapshot.
	| "LOOKUP_CONTEXT_UNAVAILABLE"
	| "LOOKUP_TABLE_NOT_AVAILABLE"
	| "LOOKUP_COLUMN_NOT_AVAILABLE"
	| "LOOKUP_COLUMN_TYPE_MISMATCH"
	| "LOCATION_OWNER_EXPORT_NOT_ACTIVE"
	// Row-dependent lookup findings from the export boundary: rows live
	// outside the document, so these are functions of current Project data,
	// not of any commit. Every export mode takes them — a choice list whose
	// saved values are blank or duplicated is equally broken however the
	// table reached the device.
	| "LOOKUP_SELECT_SOURCE_VALUE_BLANK"
	| "LOOKUP_SELECT_SOURCE_VALUE_WHITESPACE"
	| "LOOKUP_SELECT_SOURCE_VALUE_DUPLICATE"
	| "LOOKUP_SELECT_SOURCE_LABEL_BLANK"
	// What each carrier can hold: fixture bytes a downloadable app embeds,
	// rows CommCare HQ's importer takes in one workbook, and the sheet name
	// its importer addresses a table by.
	| "LOOKUP_FIXTURE_EXPORT_TOO_LARGE"
	| "LOOKUP_HQ_PUSH_TOO_LARGE"
	| "LOOKUP_TAG_TOO_LONG_FOR_HQ"
	| "LOOKUP_TAG_RESERVED_BY_HQ"
	// Aggregate export-budget guard (not a per-ref rule): the media-ON
	// compile / HQ-upload paths load every referenced ready asset into
	// memory at once, so the total count + bytes are bounded before any
	// download. Fires from `collectExportBoundaryViolations`, not a rule file.
	| "MEDIA_EXPORT_TOO_LARGE"
	// XPath deep (from existing pipeline)
	| "XPATH_SYNTAX"
	| "XPATH_UNBOUND_VARIABLE"
	| "XPATH_UNSUPPORTED_UNION"
	| "XPATH_UNSUPPORTED_DESCENDANT"
	| "XPATH_UNSUPPORTED_FILTER"
	| "XPATH_UNSUPPORTED_AXIS"
	| "XPATH_UNSUPPORTED_NODE_TEST"
	| "XPATH_UNSUPPORTED_PATH"
	| "XPATH_CARRIER_CONTEXT_UNAVAILABLE"
	| "XPATH_FUNCTION_UNAVAILABLE"
	| "XPATH_FUNCTION_SIGNATURE_UNAVAILABLE"
	| "XPATH_FUNCTION_CONTEXT_UNAVAILABLE"
	| "UNKNOWN_FUNCTION"
	| "WRONG_ARITY"
	| "INVALID_REF"
	| "INVALID_CASE_REF"
	| "INVALID_SEARCH_REF"
	| "PROSE_EDITOR_ROUND_TRIP_LOSS"
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
