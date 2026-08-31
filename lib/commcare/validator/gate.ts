/**
 * The validity gate — zero-tolerance commit and boundary evaluation.
 *
 * Pure functions over the validator's structured output. Nothing here
 * renders prose: callers own presentation (the SA tool layer humanizes via
 * the existing message vocabulary; the UI renders inline). The gate's job is
 * the decision:
 *
 *   - `classifyError(code)` — which of the five validity classes a code
 *     belongs to, typed-total over `ValidationErrorCode` so a new code
 *     without a class fails compile.
 *   - `evaluateCommit({ nextDoc, lookupContext })` — the absolute per-commit gate:
 *     a commit is accepted iff the complete candidate has no shape,
 *     soundness, or completeness finding.
 *   - `evaluateScopedCommit(...)` — the same classes over a dependency
 *     footprint, used only to preserve validity from a prior valid snapshot.
 *   - `evaluateBoundary(doc, manifest, lookupContext)` — the zero-tolerance full run for
 *     transaction boundaries (export / upload / build completion),
 *     including the asset-context media rules.
 */

import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type {
	LookupReferenceExtractorRegistry,
	LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import type { ValidationError, ValidationErrorCode } from "./errors";
import type { ValidationScope } from "./index";
import { type RunValidationOptions, runValidation } from "./runner";

// ── Classification ─────────────────────────────────────────────────

/**
 * The five validity classes (spec: Definitions → Five validity classes):
 *
 *   - `shape` — states the Zod schemas / per-kind reducers already make
 *     unrepresentable; the rule survives as a backstop for values that
 *     reach a doc through a lenient path. Gates like soundness (it can
 *     never fire post-parse, so the arm is defensive).
 *   - `soundness` — a wrong thing EXISTS (bad XPath, dangling reference,
 *     duplicate id, type error, cycle, reserved name, contradictory
 *     config). Rejected on every commit, every phase.
 *   - `completeness` — construction not FINISHED (empty form, missing
 *     case-list columns, missing Connect block). Gated like soundness:
 *     every committed candidate must contain none. Atomic creation is what
 *     lets an entity land together with everything that makes it complete.
 *   - `environment` — the app is fine; something OUTSIDE it is not.
 *     Boundary-only, reached by either of two routes, and the second is
 *     easy to miss:
 *       1. The fact is external and the commit path cannot see it —
 *          media-asset state against Postgres/GCS rows, whose rules are
 *          manifest-gated and no commit passes a manifest.
 *       2. The fact is plainly visible but the RULE binds only some
 *          export targets, so it cannot gate a commit without
 *          restricting documents that are legal everywhere else.
 *     A tag CommCare HQ's fixture workbook cannot name is the second
 *     kind: the same tag ships in a `.ccz` without complaint, because a
 *     CCZ addresses its fixtures by element name. Totality is per
 *     target, so the boundary is the only place that knows enough to
 *     refuse.
 *   - `oracle` — wire-oracle codes (`XFORM_*` / `SUITE_*` / `HQJSON_*` /
 *     `BINDING_RESOLUTION_*` / `MEDIA_SUITE_*` + the media-suite resource
 *     family). Generator-bug tripwires; never produced by `runValidation`,
 *     never an authoring state the gate weighs.
 */
export type ValidityClass =
	| "shape"
	| "soundness"
	| "completeness"
	| "environment"
	| "oracle";

/**
 * The classification table, typed-total over `ValidationErrorCode` — a new
 * code added to `errors.ts` without a row here is a COMPILE error, forcing
 * a classification decision at the moment the code is born.
 *
 * Classifications were audited per rule implementation (not per name);
 * the judgment calls, recorded:
 *
 *   - The completeness rows are the unfinished-content findings
 *     (NO_MODULES, EMPTY_FORM, MISSING_CASE_LIST_COLUMNS,
 *     CASE_CREATE_NAME_MISSING, CASE_CREATE_NAME_DUPLICATE,
 *     MISSING_CHILD_CASE_MODULE,
 *     the Connect
 *     participation floor + per-block sub-config family).
 *     NO_FORMS_OR_CASE_LIST reads "unfinished"
 *     too but stays soundness — module creation is expected to land
 *     with its forms, so a formless module is a broken commit, not
 *     work in progress.
 *   - `shape` rows are the rules whose own doc-comments declare them
 *     backstops for schema-unrepresentable states, verified against the
 *     domain schemas: `required`/`calculate`/`validate` are absent from
 *     the kinds the rules flag, `postSubmit` is a Zod enum, select
 *     `options` carries `.min(2)`.
 *   - MEDIA_EXPORT_TOO_LARGE is `environment`: it is a function of the
 *     referenced assets' external byte sizes/status, fires only from the
 *     media-validation boundary entry point, and can never gate a commit.
 *     That is route 1 above.
 *   - LOOKUP_TAG_TOO_LONG_FOR_HQ and LOOKUP_TAG_RESERVED_BY_HQ are
 *     `environment` by route 2, which is a different call from the one
 *     above rather than another instance of it. A tag's length and the
 *     `types` collision are Project data Nova can read whenever it likes,
 *     so nothing HIDES them from a commit. They are boundary-only because
 *     each is true of exactly two export modes: making them soundness
 *     would forbid a tag that works in every CCZ, letting one target's
 *     spreadsheet format narrow Nova's own vocabulary. Same reasoning for
 *     LOOKUP_HQ_PUSH_TOO_LARGE, whose budget is CommCare HQ's and nobody
 *     else's.
 */
export const VALIDITY_CLASS_BY_CODE: Readonly<
	Record<ValidationErrorCode, ValidityClass>
> = {
	// ── App-level ────────────────────────────────────────────────────
	EMPTY_APP_NAME: "soundness",
	NO_MODULES: "completeness",
	MISSING_CHILD_CASE_MODULE: "completeness",
	RESERVED_CASE_TYPE_NAME: "soundness",
	CONNECT_NO_PARTICIPATING_FORMS: "completeness",
	BLUEPRINT_TOPOLOGY_INVALID: "soundness",
	BLUEPRINT_ENTITY_UUID_DUPLICATE: "soundness",
	MUTATION_IDENTITY_COLLISION: "soundness",
	MUTATION_SEQUENCE_ANCHOR_INVALID: "soundness",
	MUTATION_TARGET_INVALID: "soundness",
	MUTATION_CASE_PROPERTY_RENAME_INVALID: "soundness",
	MUTATION_WIRE_CANONICALITY_INVALID: "soundness",
	CASE_PROPERTY_REFERENCE_INVALID: "soundness",
	// A catalog choice value holding whitespace or a quote reaches the suite
	// as an XPath literal (`field = 'value'`) and the device as a select
	// value it refuses; the wire cannot carry it.
	CASE_PROPERTY_OPTION_VALUE_INVALID: "soundness",
	CASE_PROPERTY_XPATH_INCOMPATIBLE: "soundness",
	XPATH_INSTANCE_UNAVAILABLE: "soundness",
	AUTOMATION_INVALID: "soundness",
	TRANSLATION_UNIT_UNKNOWN: "soundness",
	TRANSLATION_VALUE_KIND_MISMATCH: "soundness",
	TRANSLATION_REQUIRED_CONTENT_BLANK: "soundness",
	TRANSLATION_PROTECTED_CONTENT_CHANGED: "soundness",
	APP_STRING_VALUE_UNREPRESENTABLE: "soundness",
	// Who runs the app. Every one is soundness: an illegal or duplicated
	// slug is an identity CommCare refuses, a duplicated role or persona
	// name is indistinguishable in every picker, a dangling role or
	// property reference is a value with nowhere to go, and a value outside
	// a property's choice list is rejected when the worker is created.
	USER_PROPERTY_SLUG_INVALID: "soundness",
	USER_PROPERTY_SLUG_DUPLICATE: "soundness",
	USER_PROPERTY_CHOICES_DUPLICATE: "soundness",
	USER_TYPE_NAME_DUPLICATE: "soundness",
	PERSONA_NAME_DUPLICATE: "soundness",
	PERSONA_USER_TYPE_UNKNOWN: "soundness",
	USER_DATA_UNKNOWN_PROPERTY: "soundness",
	USER_DATA_INVALID_CHOICE: "soundness",
	USER_PROPERTY_REFERENCE_UNKNOWN: "soundness",
	ORGANIZATION_LEVEL_CODE_DUPLICATE: "soundness",
	ORGANIZATION_LEVEL_NAME_DUPLICATE: "soundness",
	ORGANIZATION_LEVEL_PARENT_UNKNOWN: "soundness",
	ORGANIZATION_LEVEL_CYCLE: "soundness",
	ORGANIZATION_LEVEL_REFERENCE_UNKNOWN: "soundness",
	ORGANIZATION_LEVEL_CAP_NOT_BELOW: "soundness",
	ORGANIZATION_LEVEL_SCOPE_GAP: "soundness",
	ORGANIZATION_LEVEL_SCOPE_NOT_ANCESTOR: "soundness",
	ORGANIZATION_REVERSE_OWNER_DESTINATION_LIMIT: "soundness",
	LOCATION_PROPERTY_SLUG_INVALID: "soundness",
	LOCATION_PROPERTY_SLUG_DUPLICATE: "soundness",
	LOCATION_PROPERTY_LEVEL_UNKNOWN: "soundness",
	LOCATION_PROPERTY_REQUIRED_CAPACITY: "soundness",
	PERSONA_LOCATION_PRIMARY_REPEATED: "soundness",
	// ── Module-level ─────────────────────────────────────────────────
	NO_CASE_TYPE: "soundness",
	CASE_LIST_ONLY_HAS_FORMS: "soundness",
	CASE_LIST_ONLY_NO_CASE_TYPE: "soundness",
	NO_FORMS_OR_CASE_LIST: "soundness",
	NESTED_MENU_CROSS_TYPE_ROOT_REQUIRES_FORM: "soundness",
	INVALID_CASE_TYPE_FORMAT: "soundness",
	CASE_TYPE_TOO_LONG: "soundness",
	MISSING_CASE_LIST_COLUMNS: "completeness",
	MODULE_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE: "soundness",
	MODULE_DISPLAY_CONDITION_TYPE_ERROR: "soundness",
	FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE: "soundness",
	FORM_DISPLAY_CONDITION_TYPE_ERROR: "soundness",
	DISPLAY_CONDITION_SEARCH_INPUT_UNAVAILABLE: "soundness",
	DISPLAY_CONDITION_NOT_ON_DEVICE: "soundness",
	DISPLAY_CONDITION_ALWAYS_FALSE: "soundness",
	// ── Case-list-config rules ───────────────────────────────────────
	CASE_LIST_COLUMN_UNKNOWN_FIELD: "soundness",
	CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH: "soundness",
	CASE_LIST_COLUMN_OVER_ATTACHMENT_SLOT: "soundness",
	CASE_LIST_FILTER_TYPE_ERROR: "soundness",
	CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR: "soundness",
	CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY: "soundness",
	CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH: "soundness",
	CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH: "soundness",
	CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR: "soundness",
	CASE_LIST_SEARCH_INPUT_DEFAULT_CASE_DATA_UNAVAILABLE: "soundness",
	CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR: "soundness",
	CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME: "soundness",
	CASE_LIST_BARE_SEARCH_INPUT_REF: "soundness",
	CASE_LIST_DUPLICATE_SORT_PRIORITY: "soundness",
	CASE_LIST_ID_MAPPING_EMPTY_VALUE: "soundness",
	CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE: "soundness",
	CASE_LIST_MATCH_MODE_TOKENIZES_WHITESPACE: "soundness",
	CASE_LIST_ANCESTOR_EXISTS_NESTS_CROSS_DIRECTION_WALK: "soundness",
	CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE: "soundness",
	CASE_LIST_SEARCH_INPUT_SELECT_WIDGET_NOT_SUPPORTED: "soundness",
	CASE_LIST_MATCH_MODE_NOT_ON_DEVICE: "soundness",
	CASE_LIST_DATE_ADD_NOT_ON_DEVICE: "soundness",
	CASE_LIST_EXPRESSION_NOT_ON_DEVICE: "soundness",
	CASE_LIST_STRICT_NULL_NOT_PORTABLE: "soundness",
	CASE_LIST_CSQL_NOT_REPRESENTABLE: "soundness",
	MULTI_SELECT_PERSISTENT_TILE: "soundness",
	MULTI_SELECT_NO_BATCH_CONSUMER: "soundness",
	// Tile geometry and coverage are soundness: a cell off the grid, two
	// cells on one square, or a shown field with nowhere to sit each
	// produce a layout the running app draws differently from the one the
	// author arranged.
	CASE_LIST_TILE_CELL_OUT_OF_GRID: "soundness",
	CASE_LIST_TILE_CELLS_OVERLAP: "soundness",
	CASE_LIST_TILE_COLUMN_NOT_PLACED: "soundness",
	CASE_LIST_TILE_GROUP_HEADER_ROWS_OUT_OF_RANGE: "soundness",
	CASE_LIST_TILE_GROUP_CELL_STRADDLES_HEADER: "soundness",
	CASE_LIST_TILE_GROUP_HEADER_EMPTY: "soundness",
	FIELD_KIND_PROPERTY_TYPE_MISMATCH: "soundness",
	FIELD_KIND_WRITERS_DISAGREE: "soundness",
	// ── Case-search-config rules ─────────────────────────────────────
	CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR: "soundness",
	CASE_SEARCH_BUTTON_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE: "soundness",
	CASE_SEARCH_EXCLUDED_OWNER_IDS_CASE_DATA_UNAVAILABLE: "soundness",
	CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR: "soundness",
	CASE_SEARCH_CONFIG_REQUIRES_CASE_TYPE: "soundness",
	// ── Form-level ───────────────────────────────────────────────────
	EMPTY_FORM: "completeness",
	// A section is a page. A half-sectioned form, a section inside a field,
	// and an add-entries repeat inside a section each make the running app
	// draw the form differently from what the author arranged, so all three
	// gate commits.
	FORM_SECTION_NOT_TOP_LEVEL: "soundness",
	FORM_SECTIONS_INCOMPLETE: "soundness",
	FORM_SECTION_USER_REPEAT: "soundness",
	CASE_WRITE_NO_CASE_ACTION: "soundness",
	CASE_WRITE_NOT_DIRECT_CHILD: "soundness",
	CASE_WRITE_DUPLICATE_PROPERTY: "soundness",
	CASE_CREATE_NAME_MISSING: "completeness",
	CASE_CREATE_NAME_DUPLICATE: "soundness",
	RESERVED_CASE_PROPERTY: "soundness",
	CAPTURE_CASE_WRITE_STANDARD_PROPERTY: "soundness",
	FORM_TOO_MANY_ATTACHMENTS: "soundness",
	CLOSE_CONDITION_WRONG_TYPE: "soundness",
	CLOSE_FORM_NO_CASE_TYPE: "soundness",
	CLOSE_CONDITION_INCOMPLETE: "soundness",
	CLOSE_CONDITION_FIELD_NOT_FOUND: "soundness",
	INVALID_POST_SUBMIT: "shape",
	POST_SUBMIT_MODULE_CASE_LIST_ONLY: "soundness",
	FORM_LINK_EMPTY: "shape",
	FORM_LINK_TARGET_NOT_FOUND: "soundness",
	FORM_LINK_CIRCULAR: "soundness",
	FORM_LINK_NO_FALLBACK: "soundness",
	FORM_LINK_SELF_REFERENCE: "soundness",
	FORM_LINK_UNREACHABLE: "soundness",
	FORM_LINK_DATUMS_INCOMPLETE: "soundness",
	FORM_LINK_DATUM_UNUSED: "soundness",
	FORM_LINK_SELECTION_CARDINALITY: "soundness",
	MULTI_SELECT_FANOUT_CHILD_DATUM: "soundness",
	MULTI_SELECT_PRIMARY_CASE_WRITE: "soundness",
	MULTI_SELECT_SHARED_CASE_EXPRESSION: "soundness",
	MULTI_SELECT_APP_OPERATION_CASE_READ: "soundness",
	MULTI_SELECT_AUTHORED_KEY_CREATE: "soundness",
	MULTI_SELECT_SESSION_OPERATION_LINK: "soundness",
	MULTI_SELECT_OPERATION_ORDER: "soundness",
	CONNECT_UNQUOTED_XPATH: "soundness",
	CONNECT_EMPTY_XPATH: "soundness",
	CONNECT_MODE_MISMATCH: "soundness",
	CONNECT_ID_INVALID_FORMAT: "soundness",
	CONNECT_ID_TOO_LONG: "soundness",
	CONNECT_ID_DUPLICATE: "soundness",
	CASE_HASHTAG_ON_CREATE_FORM: "soundness",
	PRIMARY_CASE_FIELD_IN_REPEAT: "soundness",
	USERCASE_WRITE_UNDECLARED_PROPERTY: "soundness",
	USERCASE_WRITE_MANAGED_PROPERTY: "soundness",
	USERCASE_FIELD_IN_REPEAT: "soundness",
	DUPLICATE_FIELD_ID: "soundness",
	CASE_PROPERTY_BAD_FORMAT: "soundness",
	CASE_PROPERTY_TOO_LONG: "soundness",
	CASE_OPERATION_DUPLICATE_UUID: "soundness",
	CASE_OPERATION_INVALID_ID: "soundness",
	CASE_OPERATION_DUPLICATE_ID: "soundness",
	CASE_OPERATION_INVALID_FACETS: "soundness",
	CASE_OPERATION_UNKNOWN_CASE_TYPE: "soundness",
	CASE_OPERATION_INVALID_CASE_TYPE: "soundness",
	CASE_OPERATION_RESERVED_CASE_TYPE: "soundness",
	CASE_OPERATION_UNKNOWN_PROPERTY: "soundness",
	CASE_OPERATION_RESERVED_PROPERTY: "soundness",
	CASE_OPERATION_EXPRESSION_TYPE: "soundness",
	CASE_OPERATION_TARGET_INVALID: "soundness",
	CASE_OPERATION_TARGET_TYPE_MISMATCH: "soundness",
	CASE_OPERATION_REFERENCE_ORDER: "soundness",
	CASE_OPERATION_EXECUTION_ORDER: "soundness",
	CASE_OPERATION_REPEAT_INVALID: "soundness",
	CASE_OPERATION_REPEAT_CORRELATION: "soundness",
	CASE_OPERATION_AMBIGUOUS_REFERENCE: "soundness",
	CASE_OPERATION_SESSION_UNAVAILABLE: "soundness",
	CASE_OPERATION_LINK_INVALID: "soundness",
	CASE_OPERATION_RETYPE_UNSAFE: "soundness",
	// ── Field-level ──────────────────────────────────────────────────
	SELECT_NO_OPTIONS: "shape",
	// `options.length < 2` reached in place by a granular `removeOption` the
	// reducer applies without re-parsing the field through `fieldSchema`'s
	// `.min(2)`, so it needs a gating rule rather than the shape backstop.
	SELECT_TOO_FEW_OPTIONS: "soundness",
	// A choice value holding whitespace or a quote: CommCare Android throws
	// on any select value with a space, and a multi-select answer is a
	// space-joined token list, so the form cannot run with it.
	SELECT_OPTION_VALUE_INVALID: "soundness",
	// A field still writing to a case type absent from the catalog — reachable
	// when a peer concurrently retires the type the field was declared against.
	CASE_WRITE_UNKNOWN_TYPE: "soundness",
	HIDDEN_NO_VALUE: "soundness",
	REQUIRED_ON_HIDDEN: "shape",
	CALCULATE_ON_VISIBLE_INPUT: "shape",
	UNQUOTED_STRING_LITERAL: "soundness",
	INVALID_FIELD_ID: "soundness",
	RESERVED_FIELD_ID_PREFIX: "soundness",
	VALIDATION_ON_NON_INPUT_KIND: "shape",
	EMPTY_REPEAT_COUNT: "soundness",
	EMPTY_IDS_QUERY: "soundness",
	FIXTURE_REFERENCE_NOT_MODELED: "soundness",
	LOOKUP_SELECT_FILTER_TERM_NOT_ALLOWED: "soundness",
	LOOKUP_SELECT_FILTER_FIELD_NOT_EARLIER: "soundness",
	LOOKUP_SELECT_FILTER_FIELD_REPEAT_SCOPE: "soundness",
	LOOKUP_SELECT_FILTER_TYPE_ERROR: "soundness",
	LOOKUP_SELECT_FILTER_NOT_ON_DEVICE: "soundness",
	// ── XForm parse-time oracle ──────────────────────────────────────
	XFORM_PARSE_ERROR: "oracle",
	XFORM_NO_INSTANCE: "oracle",
	XFORM_BIND_NO_NODESET: "oracle",
	XFORM_NON_PATH_NODESET: "oracle",
	XFORM_DANGLING_BIND: "oracle",
	XFORM_DANGLING_REF: "oracle",
	XFORM_INVALID_BIND_EXPRESSION: "oracle",
	XFORM_CONTROL_NO_REF: "oracle",
	XFORM_NON_PATH_CONTROL_REF: "oracle",
	XFORM_SELECT_NO_ITEMS: "oracle",
	XFORM_SELECT_ITEMS_AND_ITEMSET: "oracle",
	XFORM_ITEMSET_INVALID: "oracle",
	SUITE_FIXTURE_INVALID: "oracle",
	XFORM_ITEM_INCOMPLETE: "oracle",
	XFORM_SETVALUE_NO_TARGET: "oracle",
	XFORM_INVALID_SETVALUE: "oracle",
	XFORM_INVALID_ACTION_EVENT: "oracle",
	XFORM_INVALID_OUTPUT: "oracle",
	XFORM_REPEAT_BINDS_ROOT: "oracle",
	XFORM_REPEAT_MEMBER_SCOPE: "oracle",
	XFORM_DUPLICATE_TEMPLATE: "oracle",
	XFORM_MISSING_ITEXT: "oracle",
	XFORM_DUPLICATE_ITEXT: "oracle",
	XFORM_TEXT_NO_ID: "oracle",
	XFORM_TEXT_BAD_CHILD: "oracle",
	XFORM_TRANSLATION_NONE: "oracle",
	XFORM_TRANSLATION_NO_LANG: "oracle",
	XFORM_TRANSLATION_DUPLICATE_LANG: "oracle",
	XFORM_TRANSLATION_NO_DEFAULT: "oracle",
	XFORM_TRANSLATION_MULTIPLE_DEFAULT: "oracle",
	XFORM_TRANSLATION_INCOMPLETE: "oracle",
	XFORM_DANGLING_MEDIA_REF: "oracle",
	// ── suite.xml oracle ─────────────────────────────────────────────
	SUITE_PARSE_ERROR: "oracle",
	SUITE_NO_SUITE_ELEMENT: "oracle",
	SUITE_DATUM_NO_VALUE: "oracle",
	SUITE_DATUM_NO_NODESET: "oracle",
	SUITE_DATUM_NON_PATH_VALUE: "oracle",
	SUITE_DATUM_NON_PATH_NODESET: "oracle",
	SUITE_DATA_NO_REF: "oracle",
	SUITE_DATA_NON_PATH_REF: "oracle",
	SUITE_DETAIL_NO_TITLE: "oracle",
	SUITE_FIELD_NO_HEADER: "oracle",
	SUITE_FIELD_NO_TEMPLATE: "oracle",
	SUITE_FIELD_STYLE_INVALID: "oracle",
	SUITE_DETAIL_GROUP_INVALID: "oracle",
	SUITE_ENTRY_NO_DISPLAY: "oracle",
	SUITE_INVALID_XPATH: "oracle",
	SUITE_NON_PATH_XPATH: "oracle",
	SUITE_QUERY_NO_URL: "oracle",
	SUITE_QUERY_NO_STORAGE_INSTANCE: "oracle",
	SUITE_REMOTE_REQUEST_NO_POST: "oracle",
	SUITE_POST_NO_URL: "oracle",
	SUITE_PROMPT_NO_KEY: "oracle",
	SUITE_PROMPT_DUPLICATE_KEY: "oracle",
	SUITE_STACK_BAD_OP: "oracle",
	SUITE_VERSION_NOT_INTEGER: "oracle",
	SUITE_MENU_COMMAND_UNRESOLVED: "oracle",
	SUITE_MENU_ROOT_UNRESOLVED: "oracle",
	SUITE_DETAIL_SELECT_UNRESOLVED: "oracle",
	SUITE_DETAIL_CONFIRM_UNRESOLVED: "oracle",
	SUITE_MISSING_INSTANCE: "oracle",
	SUITE_DUPLICATE_INSTANCE: "oracle",
	SUITE_MISSING_LOCALE: "oracle",
	SUITE_DUPLICATE_COMMAND: "oracle",
	SUITE_DUPLICATE_DETAIL: "oracle",
	SUITE_SORT_BAD_ORDER: "oracle",
	SUITE_SORT_BAD_DIRECTION: "oracle",
	SUITE_SORT_BAD_TYPE: "oracle",
	SUITE_SORT_BAD_BLANKS: "oracle",
	SUITE_DANGLING_MEDIA_REF: "oracle",
	// ── HQ import JSON oracle ────────────────────────────────────────
	HQJSON_BAD_DOC_TYPE: "oracle",
	HQJSON_BAD_MODULE_DOC_TYPE: "oracle",
	HQJSON_BAD_ROOT_MODULE_ID: "oracle",
	HQJSON_BAD_PARENT_SELECT_MODULE_ID: "oracle",
	HQJSON_BAD_FORM_DOC_TYPE: "oracle",
	HQJSON_BAD_CONDITION_TYPE: "oracle",
	HQJSON_BAD_CONDITION_OPERATOR: "oracle",
	HQJSON_BAD_FORM_REQUIRES: "oracle",
	HQJSON_BAD_POST_FORM_WORKFLOW: "oracle",
	HQJSON_BAD_POST_FORM_WORKFLOW_FALLBACK: "oracle",
	HQJSON_BAD_FORM_LINK: "oracle",
	HQJSON_BAD_UPDATE_MODE: "oracle",
	HQJSON_BAD_SUBCASE_RELATIONSHIP: "oracle",
	HQJSON_BAD_DETAIL_DISPLAY: "oracle",
	HQJSON_BAD_TYPE: "oracle",
	HQJSON_BAD_MULTIMEDIA_MAP_KEY: "oracle",
	HQJSON_BAD_MULTIMEDIA_MAP_MEDIA_TYPE: "oracle",
	HQJSON_BAD_NAV_MEDIA_VALUE: "oracle",
	HQJSON_BAD_LOGO_REF: "oracle",
	// ── Binding-resolution oracle ────────────────────────────────────
	BINDING_RESOLUTION_INSTANCE_UNDECLARED: "oracle",
	BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED: "oracle",
	BINDING_RESOLUTION_SESSION_CONTEXT_UNKNOWN: "oracle",
	BINDING_RESOLUTION_MEDIA_REF_UNDECLARED: "oracle",
	// ── media_suite.xml oracle ───────────────────────────────────────
	MEDIA_SUITE_PARSE_ERROR: "oracle",
	MEDIA_SUITE_NO_SUITE_ELEMENT: "oracle",
	MEDIA_SUITE_VERSION_NOT_INTEGER: "oracle",
	MEDIA_NO_PATH: "oracle",
	MEDIA_NO_RESOURCE: "oracle",
	MEDIA_RESOURCE_NO_ID: "oracle",
	MEDIA_RESOURCE_VERSION_NOT_INTEGER: "oracle",
	MEDIA_RESOURCE_NO_LOCATION: "oracle",
	MEDIA_LOCATION_NO_AUTHORITY: "oracle",
	MEDIA_LOCATION_NO_PATH: "oracle",
	MEDIA_LOCATION_UNKNOWN_AUTHORITY: "oracle",
	MEDIA_RESOURCE_DUPLICATE_ID: "oracle",
	MEDIA_LOCATION_PATH_NOT_BUNDLED: "oracle",
	// ── Media asset-context rules + export-budget guard ──────────────
	MEDIA_ASSET_NOT_FOUND: "environment",
	MEDIA_ASSET_NOT_READY: "environment",
	MEDIA_KIND_MISMATCH: "environment",
	MEDIA_EXPORT_TOO_LARGE: "environment",
	// Lookup references are authored structural identities. Missing validation
	// context is therefore a whole-candidate soundness failure.
	LOOKUP_CONTEXT_UNAVAILABLE: "soundness",
	LOOKUP_TABLE_NOT_AVAILABLE: "soundness",
	LOOKUP_COLUMN_NOT_AVAILABLE: "soundness",
	LOOKUP_COLUMN_TYPE_MISMATCH: "soundness",
	LOCATION_OWNER_EXPORT_NOT_ACTIVE: "soundness",
	/* Row-dependent boundary findings: like MEDIA_EXPORT_TOO_LARGE they are
	 * functions of external Project data, so they never gate a commit. */
	LOOKUP_SELECT_SOURCE_VALUE_BLANK: "environment",
	LOOKUP_SELECT_SOURCE_VALUE_WHITESPACE: "environment",
	LOOKUP_SELECT_SOURCE_VALUE_DUPLICATE: "environment",
	LOOKUP_SELECT_SOURCE_LABEL_BLANK: "environment",
	LOOKUP_FIXTURE_EXPORT_TOO_LARGE: "environment",
	LOOKUP_HQ_PUSH_TOO_LARGE: "environment",
	LOOKUP_TAG_TOO_LONG_FOR_HQ: "environment",
	LOOKUP_TAG_RESERVED_BY_HQ: "environment",
	// ── XPath deep validation ────────────────────────────────────────
	XPATH_SYNTAX: "soundness",
	XPATH_UNBOUND_VARIABLE: "soundness",
	XPATH_UNSUPPORTED_UNION: "soundness",
	XPATH_UNSUPPORTED_DESCENDANT: "soundness",
	XPATH_UNSUPPORTED_FILTER: "soundness",
	XPATH_UNSUPPORTED_AXIS: "soundness",
	XPATH_UNSUPPORTED_NODE_TEST: "soundness",
	XPATH_UNSUPPORTED_PATH: "soundness",
	XPATH_CARRIER_CONTEXT_UNAVAILABLE: "soundness",
	XPATH_FUNCTION_UNAVAILABLE: "soundness",
	XPATH_FUNCTION_SIGNATURE_UNAVAILABLE: "soundness",
	XPATH_FUNCTION_CONTEXT_UNAVAILABLE: "soundness",
	UNKNOWN_FUNCTION: "soundness",
	WRONG_ARITY: "soundness",
	INVALID_REF: "soundness",
	INVALID_CASE_REF: "soundness",
	PROSE_EDITOR_ROUND_TRIP_LOSS: "soundness",
	CYCLE: "soundness",
	TYPE_ERROR: "soundness",
};

/** Classify a validation code through the typed-total current table. */
export function classifyError(code: ValidationErrorCode): ValidityClass {
	return VALIDITY_CLASS_BY_CODE[code];
}

// ── Commit gate ────────────────────────────────────────────────────

export interface EvaluateCommitArgs {
	readonly nextDoc: BlueprintDoc;
	/** The exact external definition snapshot for this complete candidate. */
	readonly lookupContext: LookupValidationContext;
	/** Explicit synthetic extractor seam for pure tests; production omits it. */
	readonly lookupReferenceExtractors?: LookupReferenceExtractorRegistry;
}

export interface EvaluateScopedCommitArgs extends EvaluateCommitArgs {
	/** The complete dependency footprint the caller proved this edit can alter. */
	readonly scope: ValidationScope;
}

export type CommitVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly findings: ValidationError[] };

/**
 * The absolute per-commit gate: accept iff the complete candidate has no shape,
 * soundness, or completeness finding. There is no prior-document comparison,
 * scope narrowing, or allowance for a finding that happened to exist before
 * this commit.
 *
 * Environment rules are manifest-gated and this pure commit gate runs without
 * a manifest; oracle codes are post-expansion wire findings that
 * `runValidation` does not produce.
 */
export function evaluateCommit({
	nextDoc,
	lookupContext,
	lookupReferenceExtractors,
}: EvaluateCommitArgs): CommitVerdict {
	return evaluateCommitValidation({
		nextDoc,
		lookupContext,
		lookupReferenceExtractors,
	});
}

/**
 * Evaluate the app-wide rules plus one explicitly proven entity footprint.
 *
 * This is not a weaker standalone boundary: its caller must know the prior
 * document was valid and prove the mutation leaves every entity outside
 * `scope` unchanged. `runValidation`'s scoped-run equivalence then preserves
 * whole-document validity by induction. Export, server persistence, and any
 * unclassified mutation continue to use `evaluateCommit`.
 */
export function evaluateScopedCommit({
	nextDoc,
	lookupContext,
	lookupReferenceExtractors,
	scope,
}: EvaluateScopedCommitArgs): CommitVerdict {
	return evaluateCommitValidation({
		nextDoc,
		lookupContext,
		lookupReferenceExtractors,
		scope,
	});
}

function evaluateCommitValidation({
	nextDoc,
	lookupContext,
	lookupReferenceExtractors,
	scope,
}: EvaluateCommitArgs & { readonly scope?: ValidationScope }): CommitVerdict {
	const options: RunValidationOptions | undefined =
		lookupReferenceExtractors === undefined && scope === undefined
			? undefined
			: {
					...(lookupReferenceExtractors !== undefined && {
						lookupReferenceExtractors,
					}),
					...(scope !== undefined && { scope }),
				};
	const gating = runValidation(nextDoc, lookupContext, options).filter(
		(err) => {
			const cls = classifyError(err.code);
			return cls === "shape" || cls === "soundness" || cls === "completeness";
		},
	);

	return gating.length === 0 ? { ok: true } : { ok: false, findings: gating };
}

// ── Boundary gate ──────────────────────────────────────────────────

/**
 * The zero-tolerance transaction-boundary run: full validation including
 * the asset-context media rules (existence / readiness / kind against the
 * caller-resolved manifest). Returns every finding; a boundary caller
 * treats ANY non-empty result as a rejection — there is no introduced-
 * error allowance at a boundary.
 *
 * The aggregate export-budget guard (`MEDIA_EXPORT_TOO_LARGE`) is NOT run
 * here: it lives with the manifest loader
 * (`lib/export/boundaryValidation.ts::collectExportBoundaryViolations`) because
 * it is a property of the loaded media-asset rows, which this pure function
 * never fetches. The boundary call sites all go through that composer.
 */
export function evaluateBoundary(
	doc: BlueprintDoc,
	manifest: ReadonlyMap<string, MediaAssetRecord>,
	lookupContext: LookupValidationContext,
	lookupReferenceExtractors?: LookupReferenceExtractorRegistry,
): ValidationError[] {
	return runValidation(doc, lookupContext, {
		mediaAssets: manifest,
		...(lookupReferenceExtractors !== undefined && {
			lookupReferenceExtractors,
		}),
	});
}
