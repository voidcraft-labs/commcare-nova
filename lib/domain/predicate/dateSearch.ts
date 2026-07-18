// lib/domain/predicate/dateSearch.ts
//
// Shared semantic lowering for a calendar-day search. A `date` search widget
// produces one day (`YYYY-MM-DD`), while the property it targets may store
// either dates or full datetimes. Equality against a datetime would only match
// midnight exactly, so the faithful meaning is the half-open day interval:
//
//     date property:     property >= date(day)
//                        AND property < date(day) + 1 day
//     datetime property: property >= datetime(day)
//                        AND property < datetime(day) + 1 day
//
// Both the exported CommCare query and Nova Preview build this exact Predicate
// through this helper. Keeping the meaning in the domain layer prevents the
// two runtimes from independently inventing date-search behavior.

import {
	canonicalCasePropertyName,
	isStandardCaseListProperty,
	STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
} from "../standardCaseProperties";
import {
	and,
	between,
	dateAdd,
	dateCoerce,
	datetimeCoerce,
	exists,
	gte,
	literal,
	lt,
	prop,
	term,
} from "./builders";
import { relationDestinationCaseType } from "./rewrite";
import {
	checkRelationPath,
	resolveTermType,
	type TypeContext,
} from "./typeChecker";
import type { Predicate, RelationPath, ValueExpression } from "./types";

export interface ExactDateSearchPredicateArgs {
	/** Case type whose case list is being searched. */
	readonly caseType: string;
	/** Property targeted by the search input. */
	readonly property: string;
	/** Optional relation walk from the listed case to the targeted property. */
	readonly via?: RelationPath;
	/** The selected day before date coercion (an input ref on wire, literal in Preview). */
	readonly day: ValueExpression;
	/** Resolves the target property's date-vs-datetime runtime type. */
	readonly typeContext: TypeContext;
}

export interface DateRangeSearchPredicateArgs {
	/** Case type whose case list is being searched. */
	readonly caseType: string;
	/** Property targeted by the date-range input. */
	readonly property: string;
	/** Optional relation walk from the listed case to the targeted property. */
	readonly via?: RelationPath;
	/** Required first calendar day of the completed range. */
	readonly lowerDay: ValueExpression;
	/** Required final calendar day of the completed range. */
	readonly upperDay: ValueExpression;
	/** Resolves the target property's date-vs-datetime runtime type. */
	readonly typeContext: TypeContext;
}

/**
 * Build the canonical same-day predicate for an exact `date` search input.
 *
 * A related-property search deliberately uses ONE relational quantifier with
 * both bounds in its `where` clause. Emitting two independent property-via
 * comparisons would allow the lower bound to be satisfied by one related case
 * and the upper bound by another, which is not "one related value falls on the
 * chosen day."
 *
 * The returned predicate is derived runtime configuration, not a persisted
 * authoring AST. Date properties use date-shaped bounds. Datetime properties
 * use explicit UTC-midnight datetime bounds, including CCHQ indexed metadata;
 * Nova intentionally defines one UTC-day semantic until app timezone is an
 * authored concept instead of inheriting HQ's hidden project-timezone special
 * case for only some property names.
 */
export function exactDateSearchPredicate({
	caseType,
	property,
	via,
	day,
	typeContext,
}: ExactDateSearchPredicateArgs): Predicate {
	const targetType = resolveTargetType(caseType, property, via, typeContext);
	// Nova currently has no authored app timezone. A datetime property's
	// "selected day" is therefore the UTC half-open day, on both CCHQ and
	// Preview/Postgres. Explicit `datetime(YYYY-MM-DD)` is important for CCHQ's
	// indexed metadata: it deliberately bypasses HQ's hidden domain-timezone
	// special case so `date_opened` / `last_modified` behave exactly like a
	// custom datetime property. Date properties retain date-shaped boundaries.
	const coerceBoundary =
		targetType === "datetime" ? datetimeCoerce : dateCoerce;
	const lower = coerceBoundary(day);
	// Compute tomorrow while the value is still a calendar date, then lift it
	// to datetime. Adding `interval '1 day'` to a timestamptz follows the
	// Postgres session timezone and can be only 23 or 25 hours across DST;
	// date-first arithmetic keeps the promised UTC [midnight, midnight) day.
	const nextDay = dateAdd(dateCoerce(day), "days", term(literal(1)));
	const upper = targetType === "datetime" ? datetimeCoerce(nextDay) : nextDay;

	if (via === undefined || via.kind === "self") {
		const propertyRef = prop(caseType, property);
		return and(gte(propertyRef, lower), lt(propertyRef, upper));
	}

	const destinationCaseType = resolveDestinationCaseType(
		via,
		caseType,
		typeContext,
	);
	const destinationProperty = prop(destinationCaseType, property);
	return exists(
		via,
		and(gte(destinationProperty, lower), lt(destinationProperty, upper)),
	);
}

/**
 * Build the canonical predicate for a completed date-range search input.
 *
 * CommCare's daterange answer is an indivisible start/end pair; this helper
 * therefore requires both bounds. Date targets retain inclusive calendar-date
 * comparisons. Datetime targets use the UTC half-open interval from the first
 * day's midnight through (but not including) midnight after the final day.
 * The exclusive next-day upper bound is what keeps every instant on the final
 * selected day, instead of cutting the range off at that day's midnight.
 */
export function dateRangeSearchPredicate({
	caseType,
	property,
	via,
	lowerDay,
	upperDay,
	typeContext,
}: DateRangeSearchPredicateArgs): Predicate {
	const targetType = resolveTargetType(caseType, property, via, typeContext);
	const buildClause = (propertyRef: ReturnType<typeof prop>): Predicate => {
		if (targetType === "date") {
			return between(propertyRef, {
				lower: lowerDay,
				upper: upperDay,
			});
		}

		const lower = datetimeCoerce(lowerDay);
		// See `exactDateSearchPredicate`: date-first next-day arithmetic is
		// independent of the database session timezone and DST boundary length.
		const upper = datetimeCoerce(
			dateAdd(dateCoerce(upperDay), "days", term(literal(1))),
		);
		return and(gte(propertyRef, lower), lt(propertyRef, upper));
	};

	if (via === undefined || via.kind === "self") {
		return buildClause(prop(caseType, property));
	}

	const destinationCaseType = resolveDestinationCaseType(
		via,
		caseType,
		typeContext,
	);
	return exists(via, buildClause(prop(destinationCaseType, property)));
}

function resolveDestinationCaseType(
	via: Exclude<RelationPath, { kind: "self" }>,
	originCaseType: string,
	typeContext: TypeContext,
): string {
	// Prefer the destination encoded directly in the relation AST. This keeps
	// the helper usable in client-side projections that only carry the search
	// input itself, while still accepting the schema-resolved unqualified paths
	// the canonical type checker admits.
	const hinted = relationDestinationCaseType(via, originCaseType);
	if (hinted !== undefined) return hinted;

	const errors: Parameters<typeof checkRelationPath>[3] = [];
	const destination = checkRelationPath(
		via,
		originCaseType,
		typeContext,
		errors,
		["exact-date-search", "via"],
	);
	if (destination !== undefined) return destination;

	const detail = errors.map((error) => error.message).join("; ");
	throw new Error(
		`Cannot derive an exact date search through the authored relation from case type "${originCaseType}": ${detail || "the destination case type could not be resolved"}. The validator should reject this relation before runtime or wire emission.`,
	);
}

function resolveTargetType(
	caseType: string,
	property: string,
	via: RelationPath | undefined,
	typeContext: TypeContext,
): "date" | "datetime" {
	// Standard properties are implicit runtime scalars and deliberately absent
	// from the materializable case schema passed to Preview SQL. Resolve them
	// from the canonical domain catalog before consulting declared properties.
	const canonicalProperty = canonicalCasePropertyName(property);
	if (isStandardCaseListProperty(canonicalProperty)) {
		const standardType =
			STANDARD_CASE_LIST_PROPERTY_DATA_TYPES[canonicalProperty];
		if (standardType === "datetime") return standardType;
	}

	const errors: Parameters<typeof resolveTermType>[2] = [];
	const resolved = resolveTermType(
		prop(caseType, property, via),
		typeContext,
		errors,
		["exact-date-search", "property"],
	);
	if (resolved === "date" || resolved === "datetime") return resolved;

	const detail = errors.map((error) => error.message).join("; ");
	throw new Error(
		`Cannot derive an exact date search for property "${property}" on case type "${caseType}": expected a date or datetime target, resolved ${resolved === undefined ? "no type" : `"${resolved}"`}${detail === "" ? "" : ` (${detail})`}. The validator should reject an incompatible date-search target before runtime or wire emission.`,
	);
}
