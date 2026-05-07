// components/builder/case-list-config/propertyTypeSets.ts
//
// Shared `data_type` membership sets + per-shape predicates used
// across the case-list-config editor (column registry, predicate
// registry, expression registry, per-card filters). Pulling them
// into one module keeps the categorization stable across surfaces:
// adding a `CasePropertyDataType` variant to
// `lib/domain/casePropertyTypes.ts` lights up every consumer in
// one edit, and the bug class "the new variant got rolled into 4
// of N membership tables" is structurally impossible.
//
// Each set is the closed enumeration of the data types that fall
// into a given semantic category — date-shaped (calendar
// arithmetic admissible), text-shaped (string-comparison
// admissible), numeric-shaped (numeric-comparison admissible),
// ordered (any total-ordering comparison admissible). The
// per-shape predicates pin the `data_type ?? "text"` fallback in
// one place — every consumer that resolved to a CCHQ-flavored
// `text` default for un-annotated properties picks up the same
// behavior automatically.

import type { CaseProperty } from "@/lib/domain";

/**
 * Data types whose values represent a calendar moment — date
 * (calendar day) or datetime (calendar moment with time). Used
 * by:
 *   - `Date` / `Time-Since-Until` / `Late Flag` column applicability.
 *   - `between` / comparison ordering rules in the predicate
 *     editor.
 *   - `format-date`'s author-time relevance gate (no point
 *     surfacing the kind in a scope without a date property).
 *   - `match` mode `fuzzy-date` widening (the picker accepts
 *     date-typed properties on top of text-shaped ones).
 */
export const DATE_DATA_TYPES: ReadonlySet<string> = new Set([
	"date",
	"datetime",
]);

/**
 * Data types whose values are string-shaped at the wire layer —
 * plain text plus the two select-typed variants whose values are
 * stored as their option-value string. Used by:
 *   - `Phone` column applicability.
 *   - `Match` text-mode picker filter (fuzzy / phonetic /
 *     starts-with) and the type-checker's match-property rule.
 *   - `concat` / `format-date` author-time applicability gates.
 */
export const TEXT_SHAPED_DATA_TYPES: ReadonlySet<string> = new Set([
	"text",
	"single_select",
	"multi_select",
]);

/**
 * Numeric data types — admit `arith` / `double` / numeric
 * comparison without coercion. The Postgres / on-device
 * comparators promote `int` × `decimal` operands per the
 * type-checker's ordered-types rule.
 */
export const NUMERIC_DATA_TYPES: ReadonlySet<string> = new Set([
	"int",
	"decimal",
]);

/**
 * Totally-ordered data types — admit `lt` / `lte` / `gt` / `gte`
 * comparisons and `between` ranges. Numeric + temporal members of
 * the case-property type universe.
 */
export const ORDERED_DATA_TYPES: ReadonlySet<string> = new Set([
	"int",
	"decimal",
	"date",
	"datetime",
	"time",
]);

/**
 * Resolve the effective `data_type` of a property, falling back
 * to `"text"` when the property declares none. Mirrors the type
 * checker's `data_type ?? "text"` convention; consumers picking
 * un-annotated properties get the same answer everywhere.
 *
 * Exported so callers that need the raw resolved type (rather
 * than a per-shape predicate) can avoid duplicating the fallback.
 */
export function effectiveDataType(p: CaseProperty): string {
	return p.data_type ?? "text";
}

/**
 * `true` when the property's effective data type is calendar-shaped
 * (`date` / `datetime`). Used by every kind that runs calendar
 * arithmetic against the property's value.
 */
export function isDateTyped(p: CaseProperty): boolean {
	return DATE_DATA_TYPES.has(effectiveDataType(p));
}

/**
 * `true` when the property's effective data type is text-shaped.
 * Includes both plain `text` and select-typed variants whose
 * values are stored as their option-value string.
 */
export function isTextShaped(p: CaseProperty): boolean {
	return TEXT_SHAPED_DATA_TYPES.has(effectiveDataType(p));
}

/**
 * `true` when the property's effective data type admits ordered
 * comparison — numeric or temporal.
 */
export function isOrdered(p: CaseProperty): boolean {
	return ORDERED_DATA_TYPES.has(effectiveDataType(p));
}
