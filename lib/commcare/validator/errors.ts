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
	| "DUPLICATE_MODULE_NAME"
	| "MISSING_CHILD_CASE_MODULE"
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
	| "REGISTRATION_NO_CASE_PROPS"
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
	| "CONNECT_FORM_MISSING_BLOCK"
	| "CONNECT_MISSING_LEARN"
	| "CONNECT_MISSING_DELIVER"
	| "CONNECT_UNQUOTED_XPATH"
	| "CONNECT_EMPTY_XPATH"
	| "CONNECT_ID_INVALID_FORMAT"
	| "CONNECT_ID_TOO_LONG"
	| "CONNECT_ID_DUPLICATE"
	| "CASE_HASHTAG_ON_CREATE_FORM"
	| "SUBCASE_IN_REPEAT_NOT_MODELED"
	| "DUPLICATE_FIELD_ID"
	| "CASE_PROPERTY_BAD_FORMAT"
	| "CASE_PROPERTY_TOO_LONG"
	// Field-level
	| "SELECT_NO_OPTIONS"
	| "HIDDEN_NO_VALUE"
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
	// Binding-resolution oracle (post-expansion) — JavaRosa's install-time XPath
	// resolution contract. A reference an expression makes that can't be
	// resolved against the form's symbol space crashes JavaRosa at form-init,
	// surfaced on device as "A part of your application is invalid". The
	// parse-time oracle (XFORM_* above) only proves the XPath PARSES; this
	// oracle proves it RESOLVES.
	| "BINDING_RESOLUTION_INSTANCE_UNDECLARED"
	| "BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED"
	| "BINDING_RESOLUTION_SESSION_CONTEXT_UNKNOWN"
	// Media — the three asset-context rules under `rules/media/`. Each
	// fires only when the validator runs with a resolved asset manifest
	// (the SA validation loop's path); structural rules (e.g. image-map
	// duplicate values) live alongside the case-list rules and fire
	// regardless of manifest presence.
	| "MEDIA_ASSET_NOT_FOUND"
	| "MEDIA_ASSET_NOT_READY"
	| "MEDIA_KIND_MISMATCH"
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
