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
	| "CASE_LIST_MATCH_MODE_TOKENIZES_WHITESPACE"
	| "CASE_LIST_ANCESTOR_EXISTS_NESTS_CROSS_DIRECTION_WALK"
	| "CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE"
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
	| "DUPLICATE_FIELD_ID"
	| "CASE_PROPERTY_BAD_FORMAT"
	| "CASE_PROPERTY_TOO_LONG"
	// Field-level
	| "SELECT_NO_OPTIONS"
	| "HIDDEN_NO_VALUE"
	| "UNQUOTED_STRING_LITERAL"
	| "INVALID_FIELD_ID"
	| "VALIDATION_ON_NON_INPUT_KIND"
	| "EMPTY_REPEAT_COUNT"
	| "EMPTY_IDS_QUERY"
	// XForm output (post-expansion)
	| "XFORM_PARSE_ERROR"
	| "XFORM_NO_INSTANCE"
	| "XFORM_BIND_NO_NODESET"
	| "XFORM_DANGLING_BIND"
	| "XFORM_DANGLING_REF"
	| "XFORM_SETVALUE_NO_TARGET"
	| "XFORM_MISSING_ITEXT"
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
