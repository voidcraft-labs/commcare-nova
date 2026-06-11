/**
 * The validity gate — introduced-error commit gating + zero-tolerance
 * boundary evaluation (VBC Layer 1).
 *
 * Pure functions over the validator's structured output. Nothing here
 * renders prose: callers own presentation (the SA tool layer humanizes via
 * the existing message vocabulary; the UI renders inline). The gate's job is
 * the decision:
 *
 *   - `classifyError(code)` — which of the five validity classes a code
 *     belongs to, typed-total over `ValidationErrorCode` so a new code
 *     without a class fails compile.
 *   - `errorIdentity(err)` — a stable identity key for a finding, built
 *     from the code plus the stable discriminators the error carries.
 *     Never prose: identity must survive message rewording, entity
 *     renames, and unrelated edits elsewhere in the doc.
 *   - `diffIntroduced(prev, next)` — the findings in `next` whose identity
 *     has no counterpart in `prev`.
 *   - `evaluateCommit({ prevDoc, nextDoc, scope, phase })` — the per-commit
 *     gate: a commit is accepted iff it introduces no soundness/shape error
 *     (and, in the `complete` phase, no completeness error — the ratchet).
 *   - `evaluateBoundary(doc, manifest)` — the zero-tolerance full run for
 *     transaction boundaries (export / upload / build completion),
 *     including the asset-context media rules.
 */

import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import type { ValidationError, ValidationErrorCode } from "./errors";
import type { ValidationScope } from "./index";
import { runValidation } from "./runner";

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
 *     case-list columns, missing Connect block). Deferred while
 *     `building`; ratcheted while `complete`; zero-tolerance only at
 *     transaction boundaries.
 *   - `environment` — media-asset state vs external Firestore/GCS rows.
 *     Boundary-only: the rules are manifest-gated and the commit path
 *     never passes a manifest.
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
 *   - The completeness set is exactly the spec's list (NO_MODULES,
 *     EMPTY_FORM, MISSING_CASE_LIST_COLUMNS, NO_CASE_NAME_FIELD,
 *     REGISTRATION_NO_CASE_PROPS, CHILD_CASE_NO_NAME_FIELD,
 *     MISSING_CHILD_CASE_MODULE, CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE,
 *     the Connect missing-block family). NO_FORMS_OR_CASE_LIST reads
 *     "unfinished" too but is NOT on the spec's list, so it stays
 *     soundness — module creation is expected to land with its forms.
 *   - `shape` rows are the rules whose own doc-comments declare them
 *     backstops for schema-unrepresentable states, verified against the
 *     domain schemas: `required`/`calculate`/`validate` are absent from
 *     the kinds the rules flag, `postSubmit` is a Zod enum, select
 *     `options` carries `.min(2)`, and media kinds carry no
 *     `case_property_on` (MEDIA_CASE_PROPERTY can still fire on a
 *     cousin-id collision — `findFieldById` resolves by first id match —
 *     which is a rule quirk, not an authoring state).
 *   - MEDIA_EXPORT_TOO_LARGE is `environment`: it is a function of the
 *     referenced assets' external byte sizes/status, fires only from the
 *     media-validation boundary entry point, and can never gate a commit.
 */
export const VALIDITY_CLASS_BY_CODE: Readonly<
	Record<ValidationErrorCode, ValidityClass>
> = {
	// ── App-level ────────────────────────────────────────────────────
	EMPTY_APP_NAME: "soundness",
	NO_MODULES: "completeness",
	DUPLICATE_MODULE_NAME: "soundness",
	MISSING_CHILD_CASE_MODULE: "completeness",
	RESERVED_CASE_TYPE_NAME: "soundness",
	// ── Module-level ─────────────────────────────────────────────────
	NO_CASE_TYPE: "soundness",
	CASE_LIST_ONLY_HAS_FORMS: "soundness",
	CASE_LIST_ONLY_NO_CASE_TYPE: "soundness",
	NO_FORMS_OR_CASE_LIST: "soundness",
	INVALID_CASE_TYPE_FORMAT: "soundness",
	CASE_TYPE_TOO_LONG: "soundness",
	MISSING_CASE_LIST_COLUMNS: "completeness",
	// ── Case-list-config rules ───────────────────────────────────────
	CASE_LIST_COLUMN_UNKNOWN_FIELD: "soundness",
	CASE_LIST_FILTER_TYPE_ERROR: "soundness",
	CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR: "soundness",
	CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY: "soundness",
	CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH: "soundness",
	CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH: "soundness",
	CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR: "soundness",
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
	FIELD_KIND_PROPERTY_TYPE_MISMATCH: "soundness",
	FIELD_KIND_WRITERS_DISAGREE: "soundness",
	// ── Case-search-config rules ─────────────────────────────────────
	CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR: "soundness",
	CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR: "soundness",
	CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT: "soundness",
	CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE: "completeness",
	CASE_SEARCH_CONFIG_REQUIRES_CASE_TYPE: "soundness",
	// ── Form-level ───────────────────────────────────────────────────
	EMPTY_FORM: "completeness",
	NO_CASE_NAME_FIELD: "completeness",
	CASE_NAME_FIELD_MISSING: "soundness",
	RESERVED_CASE_PROPERTY: "soundness",
	CASE_PROPERTY_MISSING_FIELD: "soundness",
	MEDIA_CASE_PROPERTY: "shape",
	CASE_PRELOAD_MISSING_FIELD: "soundness",
	CASE_PRELOAD_RESERVED: "soundness",
	DUPLICATE_CASE_PROPERTY: "soundness",
	REGISTRATION_NO_CASE_PROPS: "completeness",
	CLOSE_CONDITION_WRONG_TYPE: "soundness",
	CLOSE_FORM_NO_CASE_TYPE: "soundness",
	CLOSE_CONDITION_INCOMPLETE: "soundness",
	CLOSE_CONDITION_FIELD_NOT_FOUND: "soundness",
	INVALID_POST_SUBMIT: "shape",
	POST_SUBMIT_PARENT_MODULE_UNSUPPORTED: "soundness",
	POST_SUBMIT_MODULE_CASE_LIST_ONLY: "soundness",
	FORM_LINK_EMPTY: "soundness",
	FORM_LINK_TARGET_NOT_FOUND: "soundness",
	FORM_LINK_CIRCULAR: "soundness",
	FORM_LINK_NO_FALLBACK: "soundness",
	FORM_LINK_SELF_REFERENCE: "soundness",
	CONNECT_FORM_MISSING_BLOCK: "completeness",
	CONNECT_MISSING_LEARN: "completeness",
	CONNECT_MISSING_DELIVER: "completeness",
	CONNECT_UNQUOTED_XPATH: "soundness",
	CONNECT_EMPTY_XPATH: "soundness",
	CONNECT_ID_INVALID_FORMAT: "soundness",
	CONNECT_ID_TOO_LONG: "soundness",
	CONNECT_ID_MISSING: "soundness",
	CONNECT_ID_DUPLICATE: "soundness",
	CASE_HASHTAG_ON_CREATE_FORM: "soundness",
	PRIMARY_CASE_FIELD_IN_REPEAT: "soundness",
	CHILD_CASE_NO_NAME_FIELD: "completeness",
	DUPLICATE_FIELD_ID: "soundness",
	CASE_PROPERTY_BAD_FORMAT: "soundness",
	CASE_PROPERTY_TOO_LONG: "soundness",
	// ── Field-level ──────────────────────────────────────────────────
	SELECT_NO_OPTIONS: "shape",
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
	XFORM_TRANSLATION_MULTIPLE_DEFAULT: "oracle",
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
	HQJSON_BAD_FORM_DOC_TYPE: "oracle",
	HQJSON_BAD_CONDITION_TYPE: "oracle",
	HQJSON_BAD_CONDITION_OPERATOR: "oracle",
	HQJSON_BAD_FORM_REQUIRES: "oracle",
	HQJSON_BAD_POST_FORM_WORKFLOW: "oracle",
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
	// ── XPath deep validation ────────────────────────────────────────
	XPATH_SYNTAX: "soundness",
	UNKNOWN_FUNCTION: "soundness",
	WRONG_ARITY: "soundness",
	INVALID_REF: "soundness",
	INVALID_CASE_REF: "soundness",
	CYCLE: "soundness",
	TYPE_ERROR: "soundness",
};

/**
 * Classify a validation error code. Codes outside the table (a retired
 * code replayed off a historical event log) classify as `soundness` —
 * the conservative direction for a gate.
 */
export function classifyError(code: ValidationErrorCode): ValidityClass {
	return VALIDITY_CLASS_BY_CODE[code] ?? "soundness";
}

// ── Error identity ─────────────────────────────────────────────────

/**
 * A surrogate pair (kept) or a single surrogate code unit (lone — only
 * reachable when the pair branch didn't match at that position). No
 * lookbehind: the engines this sanitizer exists for (Safari ≤16.3) reject
 * lookbehind at parse time. Safe as a shared global: `String.replace`
 * owns the iteration and never leaks `lastIndex` state.
 */
const SURROGATE_PAIR_OR_LONE =
	/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/**
 * Replace lone UTF-16 surrogates with U+FFFD — `String.prototype
 * .toWellFormed`'s exact semantics, implemented environment-independently:
 * the native method is ES2024 with no polyfill in this app (missing in
 * Firefox ≤118 / Safari ≤16.3, both above Next's browser floor), and the
 * gate runs client-side once wired into the builder commit path. No
 * feature-detect-and-branch — identity must be deterministic across
 * environments, so every environment runs the same pass. Byte-identity
 * with the native method is pinned by a gate test.
 */
export function replaceLoneSurrogates(value: string): string {
	if (!/[\uD800-\uDFFF]/.test(value)) return value;
	return value.replace(SURROGATE_PAIR_OR_LONE, (match) =>
		match.length === 2 ? match : "�",
	);
}

/**
 * One identity part: a tagged, URI-encoded value so distinct discriminator
 * shapes can never alias each other in the joined key.
 *
 * Total over arbitrary strings: discriminator values are user/LLM-authored
 * and arrive through JSON, which legally transports lone UTF-16 surrogates
 * (`'"\ud83d"'` parses fine) — and `encodeURIComponent` THROWS on those.
 * Lone surrogates are replaced with U+FFFD first, so the gate always
 * renders a verdict instead of dying inside `diffIntroduced`. Well-formed
 * strings encode byte-identically to plain `encodeURIComponent`, so
 * existing identities are unchanged; two distinct lone surrogates collapse
 * to one identity — the permissive direction the identity contract already
 * allows.
 */
function part(tag: string, value: string | undefined): string {
	return `${tag}=${encodeURIComponent(replaceLoneSurrogates(value ?? ""))}`;
}

/**
 * A stable identity key for a finding: the code plus the stable
 * discriminators the error carries. The contract:
 *
 *   - stable under unrelated edits (editing form B never changes the
 *     identity of form A's findings);
 *   - stable under message rewording (no prose, no `message`, no display
 *     names except where the name IS the finding's subject);
 *   - stable under reorders (no positional indices — a fix that shifts a
 *     sibling's index must not make the sibling's finding look new);
 *   - distinct where two findings are genuinely independent, COLLAPSED
 *     where the only separator is prose or position. A collapse is always
 *     in the permissive direction: a second instance sharing an identity
 *     with a pre-existing one passes the gate, which matches the
 *     legacy-safe "broken regions can only improve" posture.
 *
 * Default shape: code + the location uuids the error carries (module /
 * form / field) + the surface key (`location.field`) where present.
 * Per-code exceptions, decided from each rule's source:
 *
 *   - Value-keyed dedup findings drop their location anchor — the rules
 *     anchor "first occurrence wins", so the flagged SITE flips under
 *     reorders while the FINDING (this name/id is duplicated) persists:
 *     DUPLICATE_MODULE_NAME → the duplicated name;
 *     RESERVED_CASE_TYPE_NAME / MISSING_CHILD_CASE_MODULE → the case type;
 *     CONNECT_ID_DUPLICATE → the colliding id.
 *   - Case-list/search findings add the stable sub-entity uuid the error's
 *     `details` carry (columnUuid / inputUuid), or the value key for
 *     duplicate findings (input name, sort priority, image-map value).
 *     AST `path`s and row/entry indices are excluded: both shift when a
 *     SIBLING finding is fixed, which would make a strict improvement look
 *     like an introduction.
 *   - Form-scope findings about a named case property / connect id /
 *     hashtag add that value from `details` so independent findings in one
 *     form stay distinct.
 *   - Codes with no structural discriminator beyond their entity collapse
 *     per entity, documented per code below: FORM_LINK_CIRCULAR (code
 *     only — the chain lives in prose), DUPLICATE_FIELD_ID /
 *     PRIMARY_CASE_FIELD_IN_REPEAT / CASE_PROPERTY_MISSING_FIELD /
 *     CASE_PRELOAD_* / CONNECT_(UNQUOTED|EMPTY)_XPATH / FORM_LINK_TARGET_
 *     NOT_FOUND / FORM_LINK_SELF_REFERENCE / CYCLE and the deep
 *     connect-xpath findings (per form), the per-slot type-check findings
 *     (per slot owner).
 *
 * Mutable SEMANTIC ids (`fieldId`, `details.fieldId`, `repeatId`) never
 * enter identity: a rename of an already-broken field must read as the
 * same finding, not a new one — uuids are the stable field anchor.
 */
export function errorIdentity(err: ValidationError): string {
	const parts: string[] = [err.code];
	const loc = err.location;
	const det = err.details;

	switch (err.code) {
		// Value-keyed, location-free (see doc comment).
		case "DUPLICATE_MODULE_NAME":
			parts.push(part("name", loc.moduleName));
			break;
		case "RESERVED_CASE_TYPE_NAME":
			parts.push(part("caseType", det?.caseType?.toLowerCase()));
			break;
		case "MISSING_CHILD_CASE_MODULE":
			parts.push(part("caseType", det?.caseType));
			break;
		case "CONNECT_ID_DUPLICATE":
			parts.push(part("connectId", det?.connectId));
			break;
		case "FORM_LINK_CIRCULAR":
			// Code only: the cycle's membership exists solely in prose. Two
			// simultaneous distinct cycles collapse to one identity —
			// permissive, and rare enough that the rule itself reports a
			// 2-cycle twice (once per entry point) already.
			break;

		// Module-scope: stable sub-entity uuid from details.
		case "CASE_LIST_COLUMN_UNKNOWN_FIELD":
		case "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR":
		case "CASE_LIST_ID_MAPPING_EMPTY_VALUE":
			parts.push(part("m", loc.moduleUuid), part("col", det?.columnUuid));
			break;
		case "CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE":
			parts.push(
				part("m", loc.moduleUuid),
				part("col", det?.columnUuid),
				part("value", det?.value),
			);
			break;
		case "CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY":
		case "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH":
		case "CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH":
		case "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR":
		case "CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR":
		case "CASE_LIST_SEARCH_INPUT_SELECT_WIDGET_NOT_SUPPORTED":
		case "CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE":
			parts.push(part("m", loc.moduleUuid), part("input", det?.inputUuid));
			break;
		case "CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME":
			parts.push(part("m", loc.moduleUuid), part("name", det?.inputName));
			break;
		case "CASE_LIST_DUPLICATE_SORT_PRIORITY":
			parts.push(part("m", loc.moduleUuid), part("priority", det?.priority));
			break;
		case "CASE_LIST_BARE_SEARCH_INPUT_REF":
			parts.push(
				part("m", loc.moduleUuid),
				part("slot", det?.slot),
				part("name", det?.inputName),
			);
			break;
		case "CASE_LIST_MATCH_MODE_TOKENIZES_WHITESPACE":
		case "CASE_LIST_MATCH_MODE_NOT_ON_DEVICE":
			parts.push(
				part("m", loc.moduleUuid),
				part("slot", det?.slot),
				part("prop", det?.property),
			);
			break;
		case "CASE_LIST_ANCESTOR_EXISTS_NESTS_CROSS_DIRECTION_WALK":
			parts.push(part("m", loc.moduleUuid), part("slot", det?.slot));
			break;
		case "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT":
			parts.push(
				part("m", loc.moduleUuid),
				part("caseType", det?.destinationCaseType),
				part("prop", det?.property),
			);
			break;

		// Form-scope: a named case property / connect id / hashtag is the
		// per-finding subject — add it so independent findings stay distinct.
		case "RESERVED_CASE_PROPERTY":
			parts.push(part("f", loc.formUuid), part("prop", det?.reservedName));
			break;
		case "MEDIA_CASE_PROPERTY":
		case "DUPLICATE_CASE_PROPERTY":
		case "CASE_PROPERTY_BAD_FORMAT":
		case "CASE_PROPERTY_TOO_LONG":
			parts.push(part("f", loc.formUuid), part("prop", det?.property));
			break;
		case "CONNECT_ID_INVALID_FORMAT":
		case "CONNECT_ID_TOO_LONG":
			parts.push(part("f", loc.formUuid), part("connectId", det?.connectId));
			break;
		case "CONNECT_ID_MISSING":
			// No id value exists to key on — the sub-config KIND is the
			// per-finding subject, so two id-less blocks on one form (e.g.
			// learn_module + assessment) stay distinct findings.
			parts.push(part("f", loc.formUuid), part("kind", det?.connectKind));
			break;
		case "CASE_HASHTAG_ON_CREATE_FORM":
			parts.push(
				part("f", loc.formUuid),
				part("surface", det?.surface),
				part("hashtag", det?.hashtag),
			);
			break;
		case "CHILD_CASE_NO_NAME_FIELD":
			parts.push(part("f", loc.formUuid), part("caseType", det?.caseType));
			break;

		// Field-scope with a structural extra.
		case "FIXTURE_REFERENCE_NOT_MODELED":
			parts.push(part("q", loc.fieldUuid), part("fixture", det?.fixtureId));
			break;

		// Media asset-context findings (boundary-only): the slot anchor
		// (uuids + location.field via the default parts) plus the asset and,
		// for image-map refs, the column uuid carried in details.
		case "MEDIA_ASSET_NOT_FOUND":
		case "MEDIA_ASSET_NOT_READY":
		case "MEDIA_KIND_MISMATCH":
			parts.push(
				...defaultLocationParts(loc),
				part("asset", det?.assetId),
				part("col", det?.columnUuid),
			);
			break;

		default:
			// Default shape: location uuids + surface key. Collapses
			// per-entity (or per-surface) where the rule emits multiple
			// findings with no structural discriminator — always permissive,
			// documented in the function comment.
			parts.push(...defaultLocationParts(loc));
			break;
	}

	return parts.join("|");
}

function defaultLocationParts(loc: ValidationError["location"]): string[] {
	const parts: string[] = [];
	if (loc.moduleUuid !== undefined) parts.push(part("m", loc.moduleUuid));
	if (loc.formUuid !== undefined) parts.push(part("f", loc.formUuid));
	if (loc.fieldUuid !== undefined) parts.push(part("q", loc.fieldUuid));
	if (loc.field !== undefined) parts.push(part("s", loc.field));
	return parts;
}

// ── Introduced-error diff ──────────────────────────────────────────

/**
 * The findings in `next` whose identity has no counterpart in `prev`.
 * Pre-existing findings (same identity on both sides) are never returned —
 * the legacy-safety property: an edit near a pre-existing error passes as
 * long as it doesn't add a NEW one. Every `next` error sharing one new
 * identity is returned (callers see each finding, not one representative).
 */
export function diffIntroduced(
	prev: readonly ValidationError[],
	next: readonly ValidationError[],
): ValidationError[] {
	const prevIdentities = new Set(prev.map(errorIdentity));
	return next.filter((err) => !prevIdentities.has(errorIdentity(err)));
}

// ── Commit gate ────────────────────────────────────────────────────

/**
 * Lifecycle phase of the app being edited. `building` = the construction
 * window (`status: "generating"` chat builds; `draft` MCP builds once D12
 * lands) — completeness is deferred. `complete` = everything else — the
 * ratchet holds (an edit may never take a complete entity incomplete).
 */
export type CommitPhase = "building" | "complete";

export interface EvaluateCommitArgs {
	readonly prevDoc: BlueprintDoc;
	readonly nextDoc: BlueprintDoc;
	/**
	 * The validation scope for THIS batch, derived from the mutations via
	 * `scopeOfMutations(prevDoc, mutations)`, or `"full"`.
	 */
	readonly scope: ValidationScope | "full";
	readonly phase: CommitPhase;
}

export type CommitVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly introduced: ValidationError[] };

/**
 * The per-commit gate: accept iff the batch introduces no error of a
 * gating class. `building` gates shape + soundness (completeness is
 * deferred — a scaffolded-but-unfilled entity is unfinished, not wrong);
 * `complete` additionally gates completeness (the ratchet). Environment
 * and oracle classes never gate a commit: environment rules are
 * manifest-gated and this runs WITHOUT a manifest (verified — the runner
 * skips `MEDIA_ASSET_RULES` when `mediaAssets` is absent), and oracle
 * codes are post-expansion wire findings `runValidation` never produces.
 *
 * Both docs are validated under the SAME scope. Why that diff equals the
 * full-run diff (the equivalence argument, load-bearing for correctness):
 *
 *   1. Scope soundness (by `scopeOfMutations`' construction): every
 *      finding whose presence can differ between `prevDoc` and `nextDoc`
 *      attributes within the scope. Mutations with cross-entity reach
 *      return `"full"` — case-property-touching field mutations
 *      included, because their readers (cross-type peer cascades,
 *      relation-walk search configs, ancestor-chain `#<type>/` refs)
 *      cannot be bounded by entity-keyed widening (see the
 *      `scopeOfMutations` header). Out-of-scope findings are therefore
 *      identical on both sides, and identity stability under unrelated
 *      edits makes their keys equal.
 *   2. An identity's scope membership is a function of the identity
 *      itself: scope-exempt codes are always in scope, and every other
 *      identity embeds the module/form uuid that decides membership
 *      (`errorWithinScope` tests exactly those uuids). So the in-scope /
 *      out-of-scope partition is the SAME for prev and next.
 *   3. With scoped ≡ full-filtered (the property-tested runner law),
 *      ids(scoped(d)) = ids(full(d)) ∩ InScope for both docs. Then
 *      ids(scoped(next)) ∖ ids(scoped(prev)) =
 *      (ids(full(next)) ∖ ids(full(prev))) ∩ InScope, and by (1) the
 *      full diff has no out-of-scope members — the two diffs are equal.
 *
 * Running prev FULL against next SCOPED would instead be wrong in the
 * permissive direction: a pre-existing out-of-scope identity could mask a
 * genuinely new in-scope finding that happens to share its key shape only
 * when keys embed scope-deciding uuids — point (2) is what makes same-key
 * imply same-scope, and holding both runs to one scope keeps the
 * comparison aligned with it.
 */
export function evaluateCommit({
	prevDoc,
	nextDoc,
	scope,
	phase,
}: EvaluateCommitArgs): CommitVerdict {
	const options = scope === "full" ? undefined : { scope };
	const prev = runValidation(prevDoc, options);
	const next = runValidation(nextDoc, options);

	const gating = diffIntroduced(prev, next).filter((err) => {
		const cls = classifyError(err.code);
		if (cls === "shape" || cls === "soundness") return true;
		return cls === "completeness" && phase === "complete";
	});

	return gating.length === 0 ? { ok: true } : { ok: false, introduced: gating };
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
 * (`lib/media/boundaryValidation.ts::collectBoundaryViolations`) because
 * it is a property of the loaded Firestore rows, which this pure function
 * never fetches. The boundary call sites all go through that composer.
 */
export function evaluateBoundary(
	doc: BlueprintDoc,
	manifest: ReadonlyMap<string, MediaAssetRecord>,
): ValidationError[] {
	return runValidation(doc, { mediaAssets: manifest });
}
