// lib/domain/predicate/slotConstraints.ts
//
// The downward-flowing TYPE CONSTRAINT the card editor threads to every
// value slot. A `SlotConstraint` answers, for one position in a
// Predicate / ValueExpression tree, "what may go here and stay
// type-correct?" — the editor's pickers consume it to offer ONLY valid
// choices (disable-with-reason, never dim), so the authored AST is valid
// by construction and the commit gate is never surprised.
//
// Every constraint's accept-set is computed from the SAME forward rules
// the type checker rejects against (`compatibleTypesFor` →
// `typesCompatible`, `MATCH_PROPERTY_TYPES_BY_MODE`, `ORDERED_TYPES`,
// `isNumeric` / `isDateOrDatetime` / `TEXT_SHAPED_TYPES`) — co-located in
// `typeChecker.ts` — so the offered-set can never drift from the
// accept-set. This module adds NO second table; it only shapes the
// checker's verdicts into per-slot descriptors.

import {
	ALL_RESOLVED_TYPES,
	compatibleTypesFor,
	isDateOrDatetime,
	isNumeric,
	MATCH_PROPERTY_TYPES_BY_MODE,
	type ResolvedType,
	TEXT_SHAPED_TYPES,
	type ValueExpressionResultClass,
	valueExpressionKindResultClass,
} from "./typeChecker";
import type { MatchMode, ValueExpression } from "./types";

// ── The descriptor ────────────────────────────────────────────────

/**
 * A type constraint on one tree slot.
 *
 *   - `accepts` — the result types admissible here, or `"any"` for no
 *     narrowing (a slot whose subject is unresolved, or a position like
 *     `concat`'s parts where every value coerces to the result type).
 *   - `nonEmpty` — a literal placed here may not be the empty string
 *     (`match.value`: every match mode collapses an empty value to a
 *     non-match).
 *   - `termOnly` — only a `term`-arm value is admissible, no computed
 *     expression kind (`match.value`: the wire match emitter consumes
 *     terms only).
 */
export interface SlotConstraint {
	readonly accepts: ReadonlySet<ResolvedType> | "any";
	readonly nonEmpty?: boolean;
	readonly termOnly?: boolean;
}

/** The unconstrained slot — the additive default while plumbing, and
 *  the constraint for a Predicate-clause slot (a Predicate has no result
 *  type to narrow). */
export const ANY_CONSTRAINT: SlotConstraint = { accepts: "any" };

// ── Type sets the factories draw on (built from the checker's rules) ──

const NUMERIC_TYPES: ReadonlySet<ResolvedType> = new Set(
	ALL_RESOLVED_TYPES.filter(isNumeric),
);
const DATE_TYPES: ReadonlySet<ResolvedType> = new Set(
	ALL_RESOLVED_TYPES.filter(isDateOrDatetime),
);
/** Anything `double` reads — a text-shaped string or an already-numeric
 *  value (mirrors `checkExpression`'s `double` arm). */
const TEXT_OR_NUMERIC_TYPES: ReadonlySet<ResolvedType> = new Set<ResolvedType>([
	...TEXT_SHAPED_TYPES,
	...NUMERIC_TYPES,
]);

// ── Per-slot constraint factories ─────────────────────────────────
//
// One per typed slot family. Each delegates its accept-set to the
// checker's forward rules; the structural flags encode the per-operator
// shape rules the checker enforces.

/** A comparison's object slot (`eq`/`neq`/`gt`/… right): any value type
 *  compatible with the subject. */
export function comparisonObjectConstraint(
	subjectType: ResolvedType | undefined,
): SlotConstraint {
	return { accepts: compatibleTypesFor(subjectType) };
}

/** A `between` bound (`lower`/`upper`): compatible with the ordered
 *  subject. */
export function betweenBoundConstraint(
	subjectType: ResolvedType | undefined,
): SlotConstraint {
	return { accepts: compatibleTypesFor(subjectType) };
}

/** An `in` membership literal: compatible with the subject. */
export function inValueConstraint(
	subjectType: ResolvedType | undefined,
): SlotConstraint {
	return { accepts: compatibleTypesFor(subjectType) };
}

/** A `match` value: a non-empty term whose type the mode admits. */
export function matchValueConstraint(mode: MatchMode): SlotConstraint {
	return {
		accepts: MATCH_PROPERTY_TYPES_BY_MODE[mode],
		nonEmpty: true,
		termOnly: true,
	};
}

/** A `within-distance` center: a geopoint or a text-encoded coordinate. */
export function withinCenterConstraint(): SlotConstraint {
	return { accepts: new Set<ResolvedType>(["geopoint", "text"]) };
}

/** An `arith` operand: numeric. */
export function arithOperandConstraint(): SlotConstraint {
	return { accepts: NUMERIC_TYPES };
}

/** A bare-numeric operand (`double` reads text-or-numeric; `date-add`'s
 *  quantity is numeric). */
export function numericConstraint(): SlotConstraint {
	return { accepts: NUMERIC_TYPES };
}

/** `double`'s operand — a text-shaped string or an already-numeric value. */
export function doubleOperandConstraint(): SlotConstraint {
	return { accepts: TEXT_OR_NUMERIC_TYPES };
}

/** A `concat` part: any value (everything coerces to text). */
export function concatPartConstraint(): SlotConstraint {
	return { accepts: "any" };
}

/** A `date-add` / `format-date` date operand: date or datetime. */
export function dateOperandConstraint(): SlotConstraint {
	return { accepts: DATE_TYPES };
}

/** A `date-coerce` / `datetime-coerce` operand: a text-shaped value. */
export function textShapedConstraint(): SlotConstraint {
	return { accepts: TEXT_SHAPED_TYPES };
}

// ── Admission helpers (consumed by the pickers) ───────────────────

/** Does the constraint admit a value of resolved type `t`? `"any"`
 *  admits everything. Used to filter property / input / literal sources. */
export function acceptsType(c: SlotConstraint, t: ResolvedType): boolean {
	return c.accepts === "any" || c.accepts.has(t);
}

/** The concrete result types a hard-typed kind class can produce — the
 *  set a kind's result is tested against the slot's `accepts`. */
const RESULT_CLASS_TYPES: Record<
	Exclude<ValueExpressionResultClass, "depends">,
	readonly ResolvedType[]
> = {
	numeric: ["int", "decimal"],
	text: ["text"],
	date: ["date"],
	datetime: ["datetime"],
	"date-or-datetime": ["date", "datetime"],
	int: ["int"],
	sequence: ["_sequence"],
};

/**
 * Can a `ValueExpression` of `kind` be placed in a slot with constraint
 * `c` and stay type-correct? `"depends"` kinds (`term`/`if`/`switch`/
 * `coalesce`) are always admissible — they propagate `c` to their inner
 * slots. A hard-typed kind is admitted iff its result class intersects
 * `c.accepts`. A `termOnly` slot admits only `term`.
 */
export function admitsValueExpressionKind(
	kind: ValueExpression["kind"],
	c: SlotConstraint,
): { admitted: boolean; reason?: string } {
	if (c.termOnly && kind !== "term") {
		return { admitted: false, reason: "This spot takes a single value." };
	}
	const cls = valueExpressionKindResultClass(kind);
	if (cls === "depends") return { admitted: true };
	if (c.accepts === "any") return { admitted: true };
	const accepts = c.accepts;
	const admitted = RESULT_CLASS_TYPES[cls].some((t) => accepts.has(t));
	return admitted
		? { admitted: true }
		: { admitted: false, reason: reasonFor(c) };
}

// ── Reason copy ───────────────────────────────────────────────────
//
// Person-to-person phrasing for a disabled choice's tooltip — names what
// the slot WANTS, not the internal type tokens. `_any` (null-universal)
// and `_sequence` never carry user meaning here and are dropped.

const FRIENDLY_TYPE: Partial<Record<ResolvedType, string>> = {
	int: "a number",
	decimal: "a number",
	text: "text",
	single_select: "text",
	multi_select: "text",
	date: "a date",
	datetime: "a date & time",
	time: "a time",
	geopoint: "a place",
};

/** A short "needs X" phrase from a constraint's accept-set, for a
 *  disabled choice. `"any"` (unconstrained) returns a generic line. */
export function reasonFor(c: SlotConstraint): string {
	if (c.accepts === "any") return "Not available here.";
	const names = new Set<string>();
	for (const t of c.accepts) {
		const friendly = FRIENDLY_TYPE[t];
		if (friendly) names.add(friendly);
	}
	if (names.size === 0) return "Not available here.";
	const list = [...names];
	const phrase =
		list.length === 1
			? list[0]
			: `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`;
	return `Needs ${phrase} to match what it's compared with.`;
}
