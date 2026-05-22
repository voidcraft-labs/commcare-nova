/** CommCare platform constants — single source of truth. */

import type { CasePropertyDataType } from "@/lib/domain";

/**
 * Case property names that HQ rejects in update_case / case_preload blocks.
 * Matches commcare-hq/corehq/apps/app_manager/static/app_manager/json/case-reserved-words.json
 * (38 entries), plus `name` and
 * `owner_id` which HQ also rejects in update blocks.
 */
export const RESERVED_CASE_PROPERTIES: ReadonlySet<string> = new Set([
	// From case-reserved-words.json
	"actions",
	"case_id",
	"case_name",
	"case_type",
	"case_type_id",
	"closed",
	"closed_by",
	"closed_on",
	"commtrack",
	"create",
	"computed_",
	"computed_modified_on_",
	"date",
	"date_modified",
	"date-opened",
	"date_opened",
	"doc_type",
	"domain",
	"external-id",
	"index",
	"indices",
	"initial_processing_complete",
	"last_modified",
	"modified_by",
	"modified_on",
	"opened_by",
	"opened_on",
	"parent",
	"referrals",
	"server_modified_on",
	"server_opened_on",
	"status",
	"type",
	"user_id",
	"userid",
	"version",
	"xform_id",
	"xform_ids",
	// Additional — HQ rejects these in update blocks
	"name",
	"owner_id",
]);

/** Safe rename targets for reserved property names the LLM might generate. */
export const RESERVED_RENAME_MAP: Readonly<Record<string, string>> = {
	date: "visit_date",
	status: "case_status",
	type: "case_category",
	parent: "parent_case",
	index: "case_index",
	version: "form_version",
	domain: "case_domain",
	closed: "is_closed",
	actions: "case_actions",
	create: "create_info",
};

/** Field kinds that produce binary/media uploads — cannot be saved as case properties. */
export const MEDIA_FIELD_KINDS: ReadonlySet<string> = new Set([
	"image",
	"audio",
	"video",
	"signature",
]);

/**
 * Field kinds that accept user input and therefore support validation
 * (constraint + constraintMsg) on the wire. Structural kinds
 * (group / repeat / label) have no value to check; hidden is a computed
 * value the user can't correct, so validation there is a category error.
 * Used by the XForm builder to gate constraint emission.
 */
const VALIDATABLE_KINDS: ReadonlySet<string> = new Set([
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
]);

export function supportsValidation(kind: string): boolean {
	return VALIDATABLE_KINDS.has(kind);
}

/** Standard create-block properties (not user case properties). */
export const STANDARD_CREATE_PROPS: ReadonlySet<string> = new Set([
	"case_type",
	"case_name",
	"owner_id",
]);

/** Valid case property name: starts with a letter, then letters/digits/underscores/hyphens. */
export const CASE_PROPERTY_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** Valid case type identifier: same rules as case property names. */
export const CASE_TYPE_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** Valid XML element name for XForm property elements (no hyphens — XML spec). */
export const XML_ELEMENT_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Reserved prefix for XForm data nodes the emitter SYNTHESIZES rather than
 * the author declares. Currently the hidden node a hoisted `count_bound`
 * repeat needs: a literal/expression `jr:count` is illegal on the wire
 * (JavaRosa requires a node path — see `lib/commcare/xform/countReference.ts`),
 * so the emitter materializes `__nova_count_<fieldId>` at form root and
 * points `jr:count` at it.
 *
 * `__nova_` is a perfectly legal XML element name, so the XML-name regex
 * can't keep authors out of it — the constraint is a Nova-domain
 * reservation, enforced by the field-validation rule that rejects an
 * authored field id under this prefix. Without that guard, an author field
 * named `__nova_count_x` could shadow a synthesized node and silently
 * corrupt a sibling repeat's cardinality.
 */
export const RESERVED_XFORM_NODE_PREFIX = "__nova_";

/** Valid XForm data path (e.g. /data/name, /data/group/age). */
export const XFORM_PATH_REGEX = /^\/data\/[a-zA-Z0-9_/]+$/;

/** Maximum length for case type names (CommCare Core CaseXmlParser constraint). */
export const MAX_CASE_TYPE_LENGTH = 255;

/** Maximum length for case property names (CommCare Core CaseXmlParser constraint). */
export const MAX_CASE_PROPERTY_LENGTH = 255;

/**
 * Implicit `data_type` for each standard case-list property — every
 * member of `STANDARD_CASE_LIST_PROPERTIES` carries a known wire-form
 * type that CommCare's runtime comparator and search-input emitter
 * read against. The blueprint's declared `caseTypes[].properties[]`
 * never lists these — CommCare provides them implicitly — so any
 * type-driven validator rule (sort compatibility, search-input
 * mode-vs-type) needs this table to enforce the same per-type
 * structural constraints that custom properties get from
 * `effectiveDataType(...)`.
 *
 * Type assignments follow the wire-form contracts in CommCare HQ's
 * detail screen + case search layers:
 *
 *   - `date_opened` / `date-opened` / `last_modified` — datetime
 *     timestamps; emitted into `<sort type="...">` blocks as date-
 *     comparator targets.
 *   - `case_name` / `name` / `owner_id` / `external_id` /
 *     `external-id` / `status` — plain text identifiers / status
 *     enums; the runtime comparator handles them lexicographically.
 *
 * Authored as the structural source of truth: the `as const` tuple
 * declared first, the data-type record keyed on the tuple's union
 * second, and the runtime `Set` derived from the tuple last. The
 * `Record<keyof typeof ..., CasePropertyDataType>` shape forces the
 * compiler to reject the source if any member of the tuple lacks an
 * entry in the data-type table — silent fall-through is structurally
 * impossible, no `?? "text"` defensive default needed at consumers.
 */
export const STANDARD_CASE_LIST_PROPERTY_DATA_TYPES = {
	case_name: "text",
	name: "text",
	date_opened: "datetime",
	"date-opened": "datetime",
	last_modified: "datetime",
	owner_id: "text",
	external_id: "text",
	"external-id": "text",
	status: "text",
} as const satisfies Record<string, CasePropertyDataType>;

/** Closed key set of `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES` —
 *  the canonical type a property name passes through after a
 *  `STANDARD_CASE_LIST_PROPERTIES.has(name)` narrowing. Consumers
 *  who want to walk the table use this union to type the lookup. */
export type StandardCaseListProperty =
	keyof typeof STANDARD_CASE_LIST_PROPERTY_DATA_TYPES;

/** Type-narrowing predicate against `STANDARD_CASE_LIST_PROPERTIES`.
 *  Returns `true` when `name` is one of the standard set, narrowing
 *  to `StandardCaseListProperty` so callers can index
 *  `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES[name]` without the `??`
 *  defensive default.
 */
export function isStandardCaseListProperty(
	name: string,
): name is StandardCaseListProperty {
	return name in STANDARD_CASE_LIST_PROPERTY_DATA_TYPES;
}

/**
 * Case properties that are always available in case list columns
 * without needing to be explicitly created by forms.
 * Source: commcare-hq/corehq/apps/app_manager/detail_screen.py CASE_PROPERTY_MAP
 * + modules.py default properties.
 *
 * Derived from the keys of `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES`
 * — single source of truth for the standard set; adding an entry to
 * the data-type table cascades to this set automatically. Element
 * type is `StandardCaseListProperty` (the closed key union of the
 * data-type table) so iterators land on a key the type system
 * recognizes — no defensive narrowing needed at consumer sites that
 * walk the set and index back into the table.
 */
export const STANDARD_CASE_LIST_PROPERTIES: ReadonlySet<StandardCaseListProperty> =
	new Set(
		Object.keys(
			STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
		) as StandardCaseListProperty[],
	);
