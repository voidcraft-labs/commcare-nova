// lib/domain/standardCaseProperties.ts
//
// The CommCare standard case properties — the closed set every case
// carries implicitly (`case_name`, `date_opened`, …) with the wire-form
// data type each one reads as. The blueprint's declared
// `caseTypes[].properties[]` never lists these; they exist on every
// case regardless of what forms write.
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
//   - `date_opened` / `date-opened` / `last_modified` — datetime
//     timestamps; emitted into `<sort type="...">` blocks as date-
//     comparator targets.
//   - `case_name` / `name` / `owner_id` / `external_id` /
//     `external-id` / `status` — plain text identifiers / status
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

import type { CaseProperty } from "./blueprint";
import type { CasePropertyDataType } from "./casePropertyTypes";

/**
 * Implicit `data_type` for each standard case-list property — every
 * member of `STANDARD_CASE_LIST_PROPERTIES` carries a known wire-form
 * type that CommCare's runtime comparator and search-input emitter
 * read against.
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

/**
 * Historical CCHQ detail-field spellings that resolve to the same value as a
 * Nova property. They remain accepted at the wire/runtime boundary so an old
 * document keeps working, but Nova never offers them as separate authoring
 * choices. One concept gets one name in the builder.
 */
export const LEGACY_STANDARD_CASE_PROPERTY_ALIASES = {
	name: "case_name",
	"date-opened": "date_opened",
	"external-id": "external_id",
} as const satisfies Readonly<Record<string, StandardCaseListProperty>>;

export type LegacyStandardCasePropertyAlias =
	keyof typeof LEGACY_STANDARD_CASE_PROPERTY_ALIASES;

export function canonicalCasePropertyName(name: string): string {
	return Object.hasOwn(LEGACY_STANDARD_CASE_PROPERTY_ALIASES, name)
		? LEGACY_STANDARD_CASE_PROPERTY_ALIASES[
				name as LegacyStandardCasePropertyAlias
			]
		: name;
}

export function isLegacyStandardCasePropertyAlias(
	name: string,
): name is LegacyStandardCasePropertyAlias {
	return Object.hasOwn(LEGACY_STANDARD_CASE_PROPERTY_ALIASES, name);
}

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
	const canonical = canonicalCasePropertyName(name);
	return Object.hasOwn(CANONICAL_STANDARD_CASE_PROPERTY_LABELS, canonical)
		? CANONICAL_STANDARD_CASE_PROPERTY_LABELS[
				canonical as keyof typeof CANONICAL_STANDARD_CASE_PROPERTY_LABELS
			]
		: canonical;
}

/**
 * Project a semantic property catalog into Nova's authoring vocabulary.
 * CCHQ aliases are collapsed onto their canonical counterpart, preferring the
 * canonical property's own metadata when both are present. The input is never
 * mutated and non-alias properties retain their original order.
 */
export function authorableCaseProperties(
	properties: readonly CaseProperty[],
): readonly CaseProperty[] {
	const canonicalByName = new Map(
		properties
			.filter((property) => !isLegacyStandardCasePropertyAlias(property.name))
			.map((property) => [property.name, property]),
	);
	const emitted = new Set<string>();
	const result: CaseProperty[] = [];

	for (const property of properties) {
		const canonicalName = canonicalCasePropertyName(property.name);
		if (emitted.has(canonicalName)) continue;
		emitted.add(canonicalName);
		const canonical = canonicalByName.get(canonicalName);
		if (property.name === canonicalName) {
			result.push(property);
			continue;
		}
		if (canonical === undefined) {
			result.push({ ...property, name: canonicalName });
			continue;
		}
		// Effective catalogs put declared entries before injected standards.
		// Keep the old app's authored human copy while taking type/options/
		// validation semantics from the canonical standard record.
		result.push({
			...canonical,
			name: canonicalName,
			label: property.label || canonical.label,
			...(property.hint !== undefined ? { hint: property.hint } : {}),
		});
	}

	return result;
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
