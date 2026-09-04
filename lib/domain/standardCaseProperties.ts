// lib/domain/standardCaseProperties.ts
//
// The CommCare standard case properties — the closed set every case
// carries implicitly (`case_name`, `date_opened`, …) with the wire-form
// data type each one reads as. The blueprint's declared
// `caseTypes[].properties[]` need not list these; they exist on every
// case regardless of what forms write. A declared entry may remain to
// carry catalog metadata/order, but storage projections always route
// its value to the scalar case column rather than JSONB.
//
// Lives in the domain (not `lib/commcare`) because the EFFECTIVE
// case-type view (`effectiveCaseTypes.ts`) folds these entries into
// the property catalog every authoring surface reads — the builder
// workspace, the SA tools, and the validator all resolve properties
// against one admission set, and that set includes the standard
// properties. `lib/commcare/constants.ts` re-exports the three
// symbols so wire-side consumers keep their import path.
//
// Type assignments follow the wire-form contracts in CommCare HQ's
// detail screen + case search layers:
//
//   - `date_opened` / `last_modified` — datetime
//     timestamps; emitted into `<sort type="...">` blocks as date-
//     comparator targets.
//   - `case_name` / `owner_id` / `external_id` / `status` — plain
//     text identifiers / status
//     enums; the runtime comparator handles them lexicographically.
//
// Source: commcare-hq/corehq/apps/app_manager/detail_screen.py
// CASE_PROPERTY_MAP + modules.py default properties.
//
// Authored as the structural source of truth: the data-type record
// declared first, the runtime `Set` derived from its keys last. The
// `satisfies Record<string, CasePropertyDataType>` shape forces the
// compiler to reject the source if an entry's type falls outside the
// enum — silent fall-through is structurally impossible, no
// `?? "text"` defensive default needed at consumers.

import type { CasePropertyDataType } from "./casePropertyTypes";

/**
 * Implicit `data_type` for each standard case-list property — every
 * member of `STANDARD_CASE_LIST_PROPERTIES` carries a known wire-form
 * type that CommCare's runtime comparator and search-input emitter
 * read against.
 */
export const STANDARD_CASE_LIST_PROPERTY_DATA_TYPES = {
	case_name: "text",
	date_opened: "datetime",
	last_modified: "datetime",
	owner_id: "text",
	external_id: "text",
	status: "text",
} as const satisfies Record<string, CasePropertyDataType>;

/** Friendly labels for the one supported authoring name of each system value. */
export const CANONICAL_STANDARD_CASE_PROPERTY_LABELS = {
	case_name: "Case name",
	date_opened: "Date opened",
	last_modified: "Last modified",
	owner_id: "Owner",
	external_id: "External ID",
	status: "Case status (open or closed)",
} as const satisfies Readonly<Record<string, string>>;

export function standardCasePropertyDisplayLabel(name: string): string {
	return Object.hasOwn(CANONICAL_STANDARD_CASE_PROPERTY_LABELS, name)
		? CANONICAL_STANDARD_CASE_PROPERTY_LABELS[
				name as keyof typeof CANONICAL_STANDARD_CASE_PROPERTY_LABELS
			]
		: name;
}

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
	return Object.hasOwn(STANDARD_CASE_LIST_PROPERTY_DATA_TYPES, name);
}

/**
 * Case properties that are always available in case list columns
 * without needing to be explicitly created by forms.
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

/**
 * Case metadata the device keeps as attributes of the case node rather than
 * as child elements. A property name that a runtime reads by NAME alone, the
 * way a bare search prompt key is read, cannot reach one of these: the wire
 * spells them differently from every other property. Authoring surfaces
 * consult this set to withhold shapes that depend on a direct name match.
 */
export const CASE_NODE_ATTRIBUTE_PROPERTIES: ReadonlySet<string> = new Set([
	"case_id",
	"case_type",
	"owner_id",
	"status",
]);

/**
 * Standard case values backed by first-class case-row columns rather than the
 * authored JSON property document. These values survive a case-type change as
 * row metadata and must never enter a JSON-property conversion/parking plan.
 * `case_id` and `case_type` are not display-list conveniences, so they sit
 * outside `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES`, but share the same scalar
 * storage contract.
 */
export const CASE_SCALAR_PROPERTY_NAMES: ReadonlySet<string> = new Set([
	"case_id",
	"case_type",
	...STANDARD_CASE_LIST_PROPERTIES,
]);

/**
 * Standard scalar properties an ordinary form field may write explicitly.
 *
 * These are authored with their stable Nova names even though neither value
 * belongs in the custom JSON property document. Lowering and persistence route
 * each one through its dedicated case-action / row-scalar path.
 */
export const WRITABLE_STANDARD_CASE_PROPERTIES: ReadonlySet<string> = new Set([
	"case_name",
	"external_id",
]);

/**
 * Platform-owned or runtime-divergent names that may never use an ordinary
 * field's `caseWrite` destination.
 *
 * This is domain admission policy, not a compatibility alias table. The set is
 * deliberately exact: custom properties remain open-ended, while every
 * standard/system spelling except the two members of
 * `WRITABLE_STANDARD_CASE_PROPERTIES` is rejected before wire or storage
 * projection. Retired spellings such as `name` are included so a
 * validation-bypassing historical document still fails closed.
 */
export const FORBIDDEN_CASE_WRITE_PROPERTIES: ReadonlySet<string> = new Set([
	"actions",
	"case_id",
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
	"date_opened",
	"doc_type",
	"domain",
	"index",
	"indices",
	"initial_processing_complete",
	"last_modified",
	"modified_by",
	"modified_on",
	"name",
	"opened_by",
	"opened_on",
	"owner_id",
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
	"location_id",
	"hq_user_id",
	"category",
	"state",
]);

/**
 * Generic operation writes share ordinary-field admission, except that
 * `case_name` belongs to the operation's dedicated name / rename facet.
 * `external_id` remains a generic writable scalar on both surfaces.
 */
export const FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES: ReadonlySet<string> =
	new Set([...FORBIDDEN_CASE_WRITE_PROPERTIES, "case_name"]);

export function isWritableStandardCaseProperty(
	property: string,
): property is "case_name" | "external_id" {
	return WRITABLE_STANDARD_CASE_PROPERTIES.has(property);
}
