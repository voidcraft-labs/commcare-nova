// lib/domain/casePropertyTypes.ts
//
// Leaf module for the case-property `data_type` enum + the
// shape-membership categorization shared across every consumer
// that reasons about a property's type:
//
//   - The predicate AST type checker (`./predicate/typeChecker.ts`)
//     and per-arm rule files use the predicates to reject
//     mismatched comparisons.
//   - The case-list-config card editor (`components/builder/case-
//     list-config/`) gates the kind-replace menu and inline
//     applicability on the same predicates.
//   - The form engine, sample heuristic generator, Postgres SQL
//     compiler, and `case-store` typecast layer all share the
//     `data_type ?? "text"` fallback `effectiveDataType` encodes.
//
// Lives at the domain leaf (not in `blueprint.ts`) so the module
// graph stays acyclic: the predicate AST imports the enum + its
// shape predicates without pulling in `Module` / `BlueprintDoc`,
// and `blueprint.ts` imports the enum without pulling in any
// editor surface. The structural `{ data_type?: CasePropertyDataType }`
// shape on the predicates avoids the back-edge from
// `casePropertyTypes` to `blueprint`'s `CaseProperty` — every
// caller's `CaseProperty` is structurally compatible with the
// shape, but the leaf doesn't depend on the broader schema.

import { z } from "zod";

/**
 * The data types a case property may declare. Exported as a
 * readonly tuple so every consumer that reasons about case-
 * property typing — the predicate AST, the JSON Schema emitter,
 * the SQL compiler — shares one enumeration rather than
 * maintaining parallel copies. The Zod enum is built from the
 * tuple via `z.enum(...)` so the runtime schema and the static
 * union stay in lockstep: adding a variant to the tuple expands
 * both surfaces in one edit.
 */
export const casePropertyDataTypes = [
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
	"geopoint",
] as const;
export type CasePropertyDataType = (typeof casePropertyDataTypes)[number];
export const casePropertyDataTypeSchema = z.enum(casePropertyDataTypes);

// ── Shape-membership sets ─────────────────────────────────────────
//
// Per-shape closed sets categorizing the data-type universe into
// the membership groups the editor + type checker + emitters all
// reason about. The Set values are typed `CasePropertyDataType`
// so adding a variant to `casePropertyDataTypes` lights up an
// `exhaustive` build break only at the lookup sites that need to
// add the new variant — the Sets themselves stay typed against
// the full enum.

/**
 * Data types whose values represent a calendar moment — date
 * (calendar day) or datetime (calendar moment with time).
 *
 * Consumed by:
 *   - `Date` / `Time-Since-Until` / `Late Flag` column applicability.
 *   - `between` / comparison ordering rules in the predicate
 *     editor.
 *   - `format-date`'s author-time relevance gate.
 *   - `match` mode `fuzzy-date` widening.
 */
export const DATE_DATA_TYPES: ReadonlySet<string> = new Set([
	"date",
	"datetime",
]);

/**
 * Data types whose values are string-shaped at the wire layer —
 * plain text plus the two select-typed variants whose values are
 * stored as their option-value string.
 *
 * Consumed by:
 *   - `Phone` column applicability.
 *   - `Match` text-mode picker filter (fuzzy / phonetic /
 *     starts-with) and the type-checker's match-property rule.
 *   - `concat` / `format-date` author-time applicability gates.
 *   - `unwrap-list` operand seed (CSQL-only operator targeting
 *     a JSON-encoded array stored on a text-shaped property).
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

// ── Per-shape predicates ──────────────────────────────────────────
//
// Each predicate accepts the structural `{ data_type? }` shape so
// the leaf stays acyclic — `CaseProperty` (declared in
// `./blueprint.ts`) carries a superset of this shape, so a
// `CaseProperty` value satisfies the parameter type without an
// import back-edge from this leaf. The `data_type ?? "text"`
// fallback is the convention every case-property consumer
// applies for un-annotated properties; encoding it here means
// every consumer gets the same answer.

/**
 * Structural shape every per-shape predicate accepts. `CaseProperty`
 * is structurally assignable; callers don't import this shape —
 * it's named only to keep the predicate signatures readable.
 */
type PropertyDataTypeCarrier = { readonly data_type?: CasePropertyDataType };

/**
 * Resolve the effective `data_type` of a property, falling back
 * to `"text"` when the property declares none. Mirrors the type
 * checker's `data_type ?? "text"` convention; consumers picking
 * un-annotated properties get the same answer everywhere.
 *
 * Exported so callers that need the raw resolved type (rather
 * than a per-shape predicate) can avoid duplicating the fallback.
 *
 * The return type is `CasePropertyDataType` — the closed enum the
 * function structurally returns. Both arms of the body produce a
 * `CasePropertyDataType` value (the prop's own typed `data_type`,
 * or the literal `"text"` fallback), so widening the signature to
 * `string` would surrender narrowing at call sites for no
 * structural gain. Callers that need a `string`-typed value (e.g.
 * `applicableSortTypes(string | undefined)`, JSX template strings
 * rendering the type label) accept the narrower type by structural
 * assignment without changes.
 */
export function effectiveDataType(
	p: PropertyDataTypeCarrier,
): CasePropertyDataType {
	return p.data_type ?? "text";
}

/**
 * `true` when the property's effective data type is calendar-shaped
 * (`date` / `datetime`). Used by every kind that runs calendar
 * arithmetic against the property's value.
 */
export function isDateTyped(p: PropertyDataTypeCarrier): boolean {
	return DATE_DATA_TYPES.has(effectiveDataType(p));
}

/**
 * `true` when the property's effective data type is text-shaped.
 * Includes both plain `text` and select-typed variants whose
 * values are stored as their option-value string.
 */
export function isTextShaped(p: PropertyDataTypeCarrier): boolean {
	return TEXT_SHAPED_DATA_TYPES.has(effectiveDataType(p));
}

/**
 * `true` when the property's effective data type admits ordered
 * comparison — numeric or temporal.
 */
export function isOrdered(p: PropertyDataTypeCarrier): boolean {
	return ORDERED_DATA_TYPES.has(effectiveDataType(p));
}

// ── Cast failability ──────────────────────────────────────────────

/**
 * Whether retyping a property from `fromType` to `toType` can leave
 * a stored value behind: `true` when SOME valid value of `fromType`
 * has no faithful representation in `toType`, so the case store's
 * per-row cast can fail and park that value (holding its case out of
 * the app until review). `false` means the migration is total — every
 * stored value carries — so the transition needs no consent.
 *
 * This is the pure verdict the conversion surfaces render BEFORE a
 * conversion commits (the builder's impact dialog, the SA's
 * needs-confirmation result). The cast itself lives in the case
 * store (`tryCastValue` in `lib/case-store/postgres/store.ts`); the
 * contract-suite parity sweep proves each `true` edge against a
 * value the store actually parks, so this table can't quietly claim
 * risk the cast doesn't have — keep the two in lockstep when a cast
 * arm widens or narrows.
 *
 * The matrix by destination:
 *   - `text` / `single_select`: every value string-projects (arrays
 *     space-join — the XForms wire convention) — total.
 *   - `multi_select`: a non-blank scalar lifts to a one-element
 *     selection; blank values drop before the cast — total.
 *   - `decimal`: only `int` is a subset; any other source can hold
 *     a non-numeric value.
 *   - `int`: nothing is safe — even `decimal` can hold a fraction
 *     or overflow the int4 range.
 *   - `date` / `time`: only `datetime` truncates faithfully; a bare
 *     date has no time of day and vice versa.
 *   - `datetime`: only `date` extends faithfully (midnight UTC); a
 *     bare time has no calendar day.
 *   - `geopoint`: no other type guarantees the `lat lon alt acc`
 *     shape.
 */
export function castCanFail(
	fromType: CasePropertyDataType,
	toType: CasePropertyDataType,
): boolean {
	if (fromType === toType) return false;
	switch (toType) {
		case "text":
		case "single_select":
		case "multi_select":
			return false;
		case "decimal":
			return fromType !== "int";
		case "int":
			return true;
		case "date":
		case "time":
			return fromType !== "datetime";
		case "datetime":
			return fromType !== "date";
		case "geopoint":
			return true;
		default: {
			// Exhaustiveness — a new data type must take a position here
			// before any conversion surface can offer it.
			const _exhaustive: never = toType;
			void _exhaustive;
			return true;
		}
	}
}
