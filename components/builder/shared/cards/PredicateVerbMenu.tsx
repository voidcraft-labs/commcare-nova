// components/builder/shared/cards/PredicateVerbMenu.tsx
//
// THE verb of a condition sentence. A condition is something the
// author already knows how to say — "age is at least 50" — so the
// editor renders it as that sentence: subject (the property), verb
// (this menu), object (the value). Every filter builder people
// already know (Notion, Airtable, smart folders, mail rules) uses
// this exact shape, and none of them title the row with the
// operation's internal name — the verb IS the operation.
//
// One menu therefore replaces two old controls: the per-card
// operator dropdown (a lone math glyph) AND the header's "Change"
// kind-replace. Picking a verb in the same family rewrites the
// operator in place; picking across families rebuilds the node
// while carrying the SUBJECT over (and the value where the target
// has one) — switching "age is at least 50" to "is between" keeps
// age, because that's what changing a verb means. The Structure
// group holds the non-sentence shapes (groups, related-case
// lookups, the always-true/false sentinels); those become titled
// container cards when picked.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerAbc from "@iconify-icons/tabler/abc";
import tablerArrowsHorizontal from "@iconify-icons/tabler/arrows-horizontal";
import tablerAsterisk from "@iconify-icons/tabler/asterisk";
import tablerCalendarQuestion from "@iconify-icons/tabler/calendar-question";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerCheckbox from "@iconify-icons/tabler/checkbox";
import tablerChecks from "@iconify-icons/tabler/checks";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerCircleDashed from "@iconify-icons/tabler/circle-dashed";
import tablerCircleOff from "@iconify-icons/tabler/circle-off";
import tablerEar from "@iconify-icons/tabler/ear";
import tablerEqual from "@iconify-icons/tabler/equal";
import tablerEqualNot from "@iconify-icons/tabler/equal-not";
import tablerFilter from "@iconify-icons/tabler/filter";
import tablerLink from "@iconify-icons/tabler/link";
import tablerListCheck from "@iconify-icons/tabler/list-check";
import tablerLogicAnd from "@iconify-icons/tabler/logic-and";
import tablerLogicNot from "@iconify-icons/tabler/logic-not";
import tablerLogicOr from "@iconify-icons/tabler/logic-or";
import tablerMapPin from "@iconify-icons/tabler/map-pin";
import tablerMathEqualGreater from "@iconify-icons/tabler/math-equal-greater";
import tablerMathEqualLower from "@iconify-icons/tabler/math-equal-lower";
import tablerMathGreater from "@iconify-icons/tabler/math-greater";
import tablerMathLower from "@iconify-icons/tabler/math-lower";
import tablerSlash from "@iconify-icons/tabler/slash";
import tablerUnlink from "@iconify-icons/tabler/unlink";
import tablerWand from "@iconify-icons/tabler/wand";
import { useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import {
	acceptsType,
	and,
	between,
	type ComparisonKind,
	comparisonObjectTypesFor,
	comparisonOperatorsFor,
	compatibleTypesFor,
	inSubjectConstraint,
	isIn,
	type Literal,
	literal,
	literalType,
	MATCH_PROPERTY_TYPES_BY_MODE,
	matchModesFor,
	not,
	or,
	type Predicate,
	type PropertyRef,
	type ResolvedType,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { usePredicateEditContext, useResolvedType } from "../editorContext";
import {
	isAuthorablePredicateKind,
	type PredicateEditContext,
	predicateCardSchemas,
	predicateUnavailableReason,
} from "../editorSchemas";
import { useRuleFocusContext } from "../RuleFocusContext";
import {
	PredicateTransitionAlert,
	planPredicateTransition,
	preservedOperandSwap,
} from "./ChildPredicateEditor";
import { KIND_BUILDERS as COMPARISON_BUILDERS } from "./ComparisonCard";
import {
	reseedLiteralForConstraint,
	reseedValueForConstraint,
	resolveExpressionType,
} from "./reseed";

type MatchMode = Extract<Predicate, { kind: "match" }>["mode"];

/** One pickable verb (or structural shape). `id` is unique across
 *  the menu; `build` produces the next AST node from the current
 *  one, carrying over whatever the target shape can hold. Exported
 *  so the glue-fuzz can iterate the entries the menu dispatches. */
export interface VerbEntry {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	/** Scan anchor — menus are skimmed by glyph before they're read. */
	readonly icon: IconifyIcon;
	/** The schema kind backing applicability dimming. */
	readonly schemaKind: Predicate["kind"];
	readonly isCurrent: (value: Predicate) => boolean;
	readonly build: (value: Predicate, ctx: PredicateEditContext) => Predicate;
	/**
	 * Subject-type gate — whether the subject (left operand) of the
	 * CURRENT condition can support this verb. Absent for verbs every
	 * subject supports (`eq` / `neq` / `in` / `is-null` / `is-blank`,
	 * the contains / near shapes whose builder re-anchors a valid
	 * property, and the structure shapes). When present and the gate
	 * fails, the verb is disabled with `disabledReason` — so changing
	 * HOW you compare never lands a type the subject can't take; the
	 * author changes the subject first.
	 */
	readonly subjectGate?: (
		subjectType: ResolvedType | undefined,
		subject: ValueExpression | undefined,
	) => boolean;
	/** Reason shown when the subject-type gate disables the verb. */
	readonly disabledReason?: string;
}

// ── Subject / object extraction ───────────────────────────────────
//
// The "subject" is what the condition is about — the left operand.
// Carrying it across a verb change is the whole point of the shared
// menu: changing HOW you compare must never lose WHAT you compare.

export function subjectOf(value: Predicate): ValueExpression | undefined {
	switch (value.kind) {
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
		case "in":
		case "between":
		case "is-null":
		case "is-blank":
			return value.left;
		case "match":
		case "multi-select-contains":
		case "within-distance":
			return term(value.property);
		default:
			return undefined;
	}
}

/** The subject as a bare property reference, when it is one — the
 *  shapes whose subject slot is a `PropertyRef` (match, contains,
 *  near) can only carry a property over, not a computed value. */
function subjectRefOf(value: Predicate): PropertyRef | undefined {
	const subject = subjectOf(value);
	return propertyRefOfExpression(subject);
}

function propertyRefOfExpression(
	subject: ValueExpression | undefined,
): PropertyRef | undefined {
	if (subject === undefined || subject.kind !== "term") return undefined;
	return subject.term.kind === "prop" ? subject.term : undefined;
}

function objectOf(value: Predicate): ValueExpression | undefined {
	switch (value.kind) {
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return value.right;
		case "match":
			return value.value;
		default:
			return undefined;
	}
}

function expressionLiteral(value: ValueExpression): Literal | undefined {
	return value.kind === "term" && value.term.kind === "literal"
		? value.term
		: undefined;
}

/** Values that can move into a literal-only target such as `in` or
 * multi-select containment. The objects themselves are reused so partially
 * authored list drafts survive a compatible verb change. */
function literalCandidates(value: Predicate): readonly Literal[] {
	switch (value.kind) {
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte": {
			const literal = expressionLiteral(value.right);
			return literal === undefined ? [] : [literal];
		}
		case "match": {
			const literal = expressionLiteral(value.value);
			return literal === undefined ? [] : [literal];
		}
		case "in":
		case "multi-select-contains":
			return value.values;
		case "between":
			return [value.lower, value.upper].flatMap((bound) => {
				if (bound === undefined) return [];
				const literal = expressionLiteral(bound);
				return literal === undefined ? [] : [literal];
			});
		case "within-distance": {
			const literal = expressionLiteral(value.center);
			return literal === undefined ? [] : [literal];
		}
		default:
			return [];
	}
}

/** Best single value for a target that has one object slot. The planner still
 * confirms when a multi-value source has additional authored values that the
 * target cannot hold. */
function singleValueCandidate(
	value: Predicate,
	targetComparison?: ComparisonKind,
): ValueExpression | undefined {
	const direct = objectOf(value);
	if (direct !== undefined) return direct;
	switch (value.kind) {
		case "in":
		case "multi-select-contains":
			return term(value.values[0]);
		case "between":
			if (targetComparison === "lt" || targetComparison === "lte") {
				return value.upper ?? value.lower;
			}
			return value.lower ?? value.upper;
		case "within-distance":
			return value.center;
		default:
			return undefined;
	}
}

function rangeFromSource(value: Predicate): {
	readonly lower?: ValueExpression;
	readonly upper?: ValueExpression;
	readonly lowerInclusive: boolean;
	readonly upperInclusive: boolean;
} | null {
	switch (value.kind) {
		case "gt":
			return {
				lower: value.right,
				lowerInclusive: false,
				upperInclusive: true,
			};
		case "gte":
			return {
				lower: value.right,
				lowerInclusive: true,
				upperInclusive: true,
			};
		case "lt":
			return {
				upper: value.right,
				lowerInclusive: true,
				upperInclusive: false,
			};
		case "lte":
			return {
				upper: value.right,
				lowerInclusive: true,
				upperInclusive: true,
			};
		case "eq":
		case "neq":
			return {
				lower: value.right,
				upper: value.right,
				lowerInclusive: true,
				upperInclusive: true,
			};
		case "match":
			return {
				lower: value.value,
				upper: value.value,
				lowerInclusive: true,
				upperInclusive: true,
			};
		case "in":
		case "multi-select-contains":
			return {
				lower: term(value.values[0]),
				...(value.values[1] === undefined
					? { upper: term(value.values[0]) }
					: { upper: term(value.values[1]) }),
				lowerInclusive: true,
				upperInclusive: true,
			};
		case "within-distance":
			return {
				lower: value.center,
				upper: value.center,
				lowerInclusive: true,
				upperInclusive: true,
			};
		default:
			return null;
	}
}

// ── Reseed helpers ────────────────────────────────────────────────
//
// Changing the verb carries the subject (and the value where the
// target holds one), but the carried VALUE may not fit the new shape
// — `is any of` over an int subject can't seed a text literal, a
// fuzzy-date value can't carry into a fuzzy match. Each builder reseeds
// a now-incompatible carried object in the same step so the emitted
// predicate is valid by construction. The subject-type gate on the
// menu (below) already prevents an operator the subject can't support;
// the reseed handles the object on the other side.

/** Resolve a property ref's declared type against the editor scope. */
export function propertyType(
	ctx: PredicateEditContext,
	ref: PropertyRef,
): ResolvedType | undefined {
	// Let the canonical checker walk `via` before it resolves the property.
	// Looking directly at `ref.caseType` is wrong for related information:
	// that field names the origin scope, while the property lives at the
	// relation destination.
	return resolveExpressionType(term(ref), ctx);
}

/** Carry a value expression unless its resolved type sits outside
 *  `accepts` — then reseed it valid (carrying its typed content where
 *  the new accept-set can hold it). */
export function reseedObjectIfNeeded(
	obj: ValueExpression,
	accepts: ReadonlySet<ResolvedType>,
	ctx: PredicateEditContext,
): ValueExpression {
	const type = resolveExpressionType(obj, ctx);
	return type !== undefined && !accepts.has(type)
		? reseedValueForConstraint(obj, accepts)
		: obj;
}

// ── Per-family builders ───────────────────────────────────────────

export function buildComparison(
	kind: ComparisonKind,
	value: Predicate,
	ctx: PredicateEditContext,
): Predicate {
	// Same family: keep both operands when the target operator admits
	// them. An `_any` subject admits ordered verbs, but that does NOT make
	// an unordered object valid; reseed the object against the target
	// operator's exact inverse rule before returning.
	const preserved = preservedOperandSwap(value, kind);
	if (preserved !== null) {
		if (!("right" in preserved)) {
			throw new Error(
				`Comparison transition produced '${preserved.kind}' instead of '${kind}'.`,
			);
		}
		const accepts = comparisonObjectTypesFor(
			kind,
			resolveExpressionType(preserved.left, ctx),
		);
		return COMPARISON_BUILDERS[kind](
			preserved.left,
			reseedObjectIfNeeded(preserved.right, accepts, ctx),
		);
	}
	// Cross-family → comparison: carry the subject, then reseed the
	// value to the subject's compatible set. The fallback's value was
	// built for the fallback's OWN property, not this subject, so it is
	// reseeded the same as a carried value — `eq(geopoint, "")` (a text
	// literal opposite a place subject) becomes `eq(geopoint, null)`.
	const fallback = predicateCardSchemas[kind].defaultValue(ctx);
	const left = subjectOf(value) ?? fallback.left;
	const accepts = comparisonObjectTypesFor(
		kind,
		resolveExpressionType(left, ctx),
	);
	const right = reseedObjectIfNeeded(
		singleValueCandidate(value, kind) ?? fallback.right,
		accepts,
		ctx,
	);
	return COMPARISON_BUILDERS[kind](left, right);
}

export function buildMatch(
	mode: MatchMode,
	value: Predicate,
	ctx: PredicateEditContext,
): Predicate {
	const allow = MATCH_PROPERTY_TYPES_BY_MODE[mode];
	if (value.kind === "match") {
		// Mode change on an existing match — reseed the value if its type
		// no longer sits in the new mode's allow-list.
		return { ...value, mode, value: reseedMatchValue(value.value, allow, ctx) };
	}
	const fallback = predicateCardSchemas.match.defaultValue(ctx);
	const ref = subjectRefOf(value);
	// Carry the subject only when it's a property the mode can match;
	// otherwise the fallback already anchored a matchable property.
	const carriedType = ref !== undefined ? propertyType(ctx, ref) : undefined;
	const property =
		ref !== undefined && carriedType !== undefined && allow.has(carriedType)
			? ref
			: fallback.property;
	const carried = singleValueCandidate(value);
	const matchValue =
		carried !== undefined
			? reseedMatchValue(carried, allow, ctx)
			: fallback.value;
	return { ...fallback, mode, property, value: matchValue };
}

/** A match value valid for the mode's allow-list — carries a still-
 *  admissible term, reseeds an incompatible one, and leaves an
 *  unresolved (empty / placeholder) term as the completeness state. */
export function reseedMatchValue(
	value: ValueExpression,
	allow: ReadonlySet<ResolvedType>,
	ctx: PredicateEditContext,
): ValueExpression {
	const type = resolveExpressionType(value, ctx);
	// Match values are full ValueExpressions. Preserve computed values and
	// unresolved drafts when the target mode can represent their result type;
	// only an actually incompatible value needs a valid replacement.
	if (type === undefined || allow.has(type)) return value;
	return reseedValueForConstraint(value, allow);
}

export function buildWithSubjectLeft(
	kind: "in" | "between" | "is-null" | "is-blank",
	value: Predicate,
	ctx: PredicateEditContext,
): Predicate {
	const preserved = preservedOperandSwap(value, kind);
	if (preserved !== null) return preserved;
	const fallback = predicateCardSchemas[kind].defaultValue(ctx);
	const subject = subjectOf(value);
	if (subject === undefined) return fallback;
	const accepts = compatibleTypesFor(resolveExpressionType(subject, ctx));
	if (kind === "in") {
		// Carry every literal the source shape can represent. Computed objects
		// cannot enter this literal-only AST arm; the transition planner names
		// that loss before it can commit.
		const inFallback = fallback as Extract<Predicate, { kind: "in" }>;
		const candidates = literalCandidates(value);
		const values = (candidates.length > 0 ? candidates : inFallback.values).map(
			(value) =>
				accepts.has(literalType(value))
					? value
					: reseedLiteralForConstraint(value, accepts),
		);
		const safeValues = values.some((candidate) => candidate.value !== null)
			? values
			: [reseedLiteralForConstraint(literal(""), accepts)];
		const [first, ...rest] = safeValues;
		return isIn(subject, first, ...rest);
	}
	if (kind === "between") {
		// Comparisons map their value to the matching side of the range;
		// literal lists map their first two values. This preserves every
		// representable draft rather than swapping in unrelated defaults.
		const b = fallback as Extract<Predicate, { kind: "between" }>;
		const carried = rangeFromSource(value);
		const lower = carried === null ? b.lower : carried.lower;
		const upper = carried === null ? b.upper : carried.upper;
		return between(subject, {
			lower:
				lower !== undefined
					? reseedObjectIfNeeded(lower, accepts, ctx)
					: undefined,
			upper:
				upper !== undefined
					? reseedObjectIfNeeded(upper, accepts, ctx)
					: undefined,
			lowerInclusive: carried?.lowerInclusive ?? b.lowerInclusive,
			upperInclusive: carried?.upperInclusive ?? b.upperInclusive,
		});
	}
	// is-null / is-blank carry only the subject — any read can be absent.
	return { ...fallback, left: subject };
}

export function buildContains(
	quantifier: "any" | "all",
	value: Predicate,
	ctx: PredicateEditContext,
): Predicate {
	if (value.kind === "multi-select-contains") {
		return { ...value, quantifier };
	}
	const fallback =
		predicateCardSchemas["multi-select-contains"].defaultValue(ctx);
	const ref = subjectRefOf(value);
	// Only carry the subject when it's a multi_select property; otherwise
	// the fallback already anchored a valid multi_select property.
	const carry = ref !== undefined && propertyType(ctx, ref) === "multi_select";
	const values = literalCandidates(value);
	const safeValues = values.some((candidate) => candidate.value !== null)
		? values
		: [literal("")];
	return carry
		? {
				...fallback,
				quantifier,
				property: ref,
				values: safeValues as [Literal, ...Literal[]],
			}
		: { ...fallback, quantifier };
}

// ── The vocabulary ────────────────────────────────────────────────

const COMPARISON_VERBS: ReadonlyArray<{
	kind: ComparisonKind;
	label: string;
	description: string;
	icon: IconifyIcon;
}> = [
	{
		kind: "eq",
		label: "is",
		description: "Exactly this value",
		icon: tablerEqual,
	},
	{
		kind: "neq",
		label: "isn’t",
		description: "Anything except this value",
		icon: tablerEqualNot,
	},
	{
		kind: "gt",
		label: "is more than",
		description: "Above this number or date",
		icon: tablerMathGreater,
	},
	{
		kind: "gte",
		label: "is at least",
		description: "This value or above",
		icon: tablerMathEqualGreater,
	},
	{
		kind: "lt",
		label: "is less than",
		description: "Below this value",
		icon: tablerMathLower,
	},
	{
		kind: "lte",
		label: "is at most",
		description: "This value or below",
		icon: tablerMathEqualLower,
	},
];

const MATCH_VERBS: ReadonlyArray<{
	mode: MatchMode;
	label: string;
	description: string;
	icon: IconifyIcon;
}> = [
	{
		mode: "fuzzy",
		label: "Similar spelling",
		description: "Forgives a typo or two per word and ignores capitalization",
		icon: tablerWand,
	},
	{
		mode: "starts-with",
		label: "starts with",
		description: "Begins with the text and keeps capitalization exact",
		icon: tablerAbc,
	},
	{
		mode: "phonetic",
		label: "sounds like",
		description: "Matches words that sound alike, such as Smith and Smyth",
		icon: tablerEar,
	},
	{
		mode: "fuzzy-date",
		label: "Flexible date",
		description: "Forgives a swapped day and month or mistyped digits",
		icon: tablerCalendarQuestion,
	},
];

/** Ordering operators compare by total order — only ordered subject
 *  types support them. */
const ORDERED_COMPARISON_REASON =
	"Only numbers, dates, and times compare by order";

function buildVerbEntries(): readonly VerbEntry[] {
	const entries: VerbEntry[] = [];
	for (const v of COMPARISON_VERBS) {
		const ordered =
			v.kind === "gt" ||
			v.kind === "gte" ||
			v.kind === "lt" ||
			v.kind === "lte";
		entries.push({
			id: v.kind,
			label: v.label,
			description: v.description,
			icon: v.icon,
			schemaKind: v.kind,
			isCurrent: (p) => p.kind === v.kind,
			build: (p, ctx) => buildComparison(v.kind, p, ctx),
			...(ordered
				? {
						subjectGate: (t: ResolvedType | undefined) =>
							comparisonOperatorsFor(t).has(v.kind),
						disabledReason: ORDERED_COMPARISON_REASON,
					}
				: {}),
		});
	}
	for (const m of MATCH_VERBS) {
		entries.push({
			id: `match:${m.mode}`,
			label: m.label,
			description: m.description,
			icon: m.icon,
			schemaKind: "match",
			isCurrent: (p) => p.kind === "match" && p.mode === m.mode,
			build: (p, ctx) => buildMatch(m.mode, p, ctx),
			subjectGate: (t: ResolvedType | undefined, subject) =>
				propertyRefOfExpression(subject) !== undefined &&
				matchModesFor(t).has(m.mode),
			disabledReason:
				m.mode === "fuzzy-date"
					? "Choose date or text information to use flexible date matching"
					: "Choose text information to use text matching",
		});
	}
	entries.push(
		{
			id: "in",
			label: "is any of",
			icon: tablerListCheck,
			description: "Matches one value from a list you write",
			schemaKind: "in",
			isCurrent: (p) => p.kind === "in",
			build: (p, ctx) => buildWithSubjectLeft("in", p, ctx),
			subjectGate: (t) =>
				t !== undefined && acceptsType(inSubjectConstraint(), t),
			disabledReason: "Choose information that can be compared with a list",
		},
		{
			id: "between",
			label: "is between",
			icon: tablerArrowsHorizontal,
			description: "Falls inside a range with either end left open if needed",
			schemaKind: "between",
			isCurrent: (p) => p.kind === "between",
			build: (p, ctx) => buildWithSubjectLeft("between", p, ctx),
			subjectGate: (t) => comparisonOperatorsFor(t).has("gt"),
			disabledReason: "A range needs a number, date, or time",
		},
		{
			id: "msc:any",
			label: "includes any of",
			icon: tablerCheckbox,
			description: "The multi-choice list has at least one option",
			schemaKind: "multi-select-contains",
			isCurrent: (p) =>
				p.kind === "multi-select-contains" && p.quantifier === "any",
			build: (p, ctx) => buildContains("any", p, ctx),
			subjectGate: (t, subject) =>
				propertyRefOfExpression(subject) !== undefined && t === "multi_select",
			disabledReason: "Choose information that allows multiple choices",
		},
		{
			id: "msc:all",
			label: "includes all of",
			icon: tablerChecks,
			description: "The multi-choice list has every option",
			schemaKind: "multi-select-contains",
			isCurrent: (p) =>
				p.kind === "multi-select-contains" && p.quantifier === "all",
			build: (p, ctx) => buildContains("all", p, ctx),
			subjectGate: (t, subject) =>
				propertyRefOfExpression(subject) !== undefined && t === "multi_select",
			disabledReason: "Choose information that allows multiple choices",
		},
		{
			id: "within-distance",
			label: "is near",
			icon: tablerMapPin,
			description: "Within a distance of a place",
			schemaKind: "within-distance",
			isCurrent: (p) => p.kind === "within-distance",
			subjectGate: (t, subject) =>
				propertyRefOfExpression(subject) !== undefined && t === "geopoint",
			disabledReason: "Choose location information",
			build: (p, ctx) => {
				if (p.kind === "within-distance") return p;
				const fallback =
					predicateCardSchemas["within-distance"].defaultValue(ctx);
				const ref = subjectRefOf(p);
				// Only carry the subject when it's a geopoint property;
				// otherwise the fallback already anchored a valid one.
				const carry =
					ref !== undefined && propertyType(ctx, ref) === "geopoint";
				const center = singleValueCandidate(p);
				const centerType =
					center === undefined ? undefined : resolveExpressionType(center, ctx);
				const carryCenter =
					center !== undefined &&
					(centerType === undefined ||
						centerType === "geopoint" ||
						centerType === "text");
				return carry
					? {
							...fallback,
							property: ref,
							...(carryCenter ? { center } : {}),
						}
					: fallback;
			},
		},
		{
			id: "is-blank",
			label: "is blank",
			icon: tablerCircleOff,
			description: "Empty or missing entirely",
			schemaKind: "is-blank",
			isCurrent: (p) => p.kind === "is-blank",
			build: (p, ctx) => buildWithSubjectLeft("is-blank", p, ctx),
			subjectGate: (_t, subject) =>
				subject !== undefined && expressionLiteral(subject) === undefined,
			disabledReason:
				"Choose case information or another value that can change while the app runs",
		},
		{
			id: "is-null",
			label: "was never recorded",
			icon: tablerCircleDashed,
			description: "The value was never recorded; an empty value still counts",
			schemaKind: "is-null",
			isCurrent: (p) => p.kind === "is-null",
			build: (p, ctx) => buildWithSubjectLeft("is-null", p, ctx),
		},
	);
	return entries;
}

/** Every sentence verb (comparison / match / membership / range /
 *  contains / near / blank) — exported so the valid-by-construction
 *  glue-fuzz can drive every build the menu can dispatch. */
export const VERB_ENTRIES = buildVerbEntries();

/** Structural shapes — not sentences. Picking one replaces (or
 *  wraps) the condition with a container card. Exported alongside
 *  `VERB_ENTRIES` for the same glue-fuzz. */
export const STRUCTURE_ENTRIES: readonly VerbEntry[] = [
	{
		id: "and",
		label: "All conditions match",
		icon: tablerLogicAnd,
		description: "Group conditions so every condition must match",
		schemaKind: "and",
		isCurrent: (p) => p.kind === "and",
		// Wrapping (not replacing): the current condition becomes the
		// group's first row, with a fresh row beside it to fill in —
		// "group this" must never throw away what the author built.
		// The sibling group kind converts in place (same rows, the
		// other combinator); only the sentinels start from the
		// registry default, since wrapping "always true" carries
		// nothing worth keeping.
		build: (p, ctx) => {
			if (p.kind === "and") return p;
			if (p.kind === "or") {
				return and(p.clauses[0], p.clauses[1], ...p.clauses.slice(2));
			}
			if (p.kind === "match-all" || p.kind === "match-none") {
				return predicateCardSchemas.and.defaultValue(ctx);
			}
			return and(p, predicateCardSchemas.eq.defaultValue(ctx));
		},
	},
	{
		id: "or",
		label: "Any condition matches",
		icon: tablerLogicOr,
		description: "Group conditions so at least one condition must match",
		schemaKind: "or",
		isCurrent: (p) => p.kind === "or",
		build: (p, ctx) => {
			if (p.kind === "or") return p;
			if (p.kind === "and") {
				return or(p.clauses[0], p.clauses[1], ...p.clauses.slice(2));
			}
			if (p.kind === "match-all" || p.kind === "match-none") {
				return predicateCardSchemas.or.defaultValue(ctx);
			}
			return or(p, predicateCardSchemas.eq.defaultValue(ctx));
		},
	},
	{
		id: "not",
		label: "Exclude when",
		icon: tablerLogicNot,
		description: "Exclude cases when this condition matches",
		schemaKind: "not",
		isCurrent: (p) => p.kind === "not",
		// Wrapping (not replacing) is the honest meaning of "not".
		build: (p) => not(p),
	},
	{
		id: "exists",
		label: "Has a related case",
		icon: tablerLink,
		description: "Require at least one connected case to match",
		schemaKind: "exists",
		isCurrent: (p) => p.kind === "exists",
		build: (_p, ctx) => predicateCardSchemas.exists.defaultValue(ctx),
	},
	{
		id: "missing",
		label: "Has no related case",
		icon: tablerUnlink,
		description: "Require that no connected case matches",
		schemaKind: "missing",
		isCurrent: (p) => p.kind === "missing",
		build: (_p, ctx) => predicateCardSchemas.missing.defaultValue(ctx),
	},
	{
		id: "when-input-present",
		label: "After a search answer",
		icon: tablerFilter,
		description: "Apply this condition only after a search field has an answer",
		schemaKind: "when-input-present",
		isCurrent: (p) => p.kind === "when-input-present",
		// Wrap: the current condition becomes the gated clause.
		build: (p, ctx) => {
			const fallback =
				predicateCardSchemas["when-input-present"].defaultValue(ctx);
			return { ...fallback, clause: p };
		},
	},
	{
		id: "match-all",
		label: "Always match",
		icon: tablerAsterisk,
		description: "Let everything pass this condition",
		schemaKind: "match-all",
		isCurrent: (p) => p.kind === "match-all",
		build: (_p, ctx) => predicateCardSchemas["match-all"].defaultValue(ctx),
	},
	{
		id: "match-none",
		label: "Never match",
		icon: tablerSlash,
		description: "Let nothing pass this condition",
		schemaKind: "match-none",
		isCurrent: (p) => p.kind === "match-none",
		build: (_p, ctx) => predicateCardSchemas["match-none"].defaultValue(ctx),
	},
];

/**
 * Whole-condition outcomes are valid authored predicates, but they are not
 * ordinary additions to a filter. Keep them out of the primary Add condition
 * menu and expose them progressively in the condition's existing kind menu.
 * Inside the focused workbench the recursive structure actions live elsewhere,
 * so these are the only non-sentence entries that still belong in this menu.
 */
const SPECIAL_CONDITION_ENTRIES = STRUCTURE_ENTRIES.filter(
	(entry) =>
		entry.schemaKind === "match-all" || entry.schemaKind === "match-none",
);

/** The verb the current node reads as — shown on the trigger chip. */
export function currentVerbLabel(value: Predicate): string {
	const all = [...VERB_ENTRIES, ...STRUCTURE_ENTRIES];
	return all.find((e) => e.isCurrent(value))?.label ?? value.kind;
}

/**
 * Whether a verb entry is offerable for the CURRENT predicate — the
 * exact admission the menu renders against. A verb is admitted when it
 * is the current verb (legacy-open backstop), or when both its
 * case-type applicability (`schemaKind.applicable`) AND its subject-type
 * gate pass. Exported so the glue-fuzz can drive every admitted build
 * the way the menu would.
 */
export function verbEntryAdmitted(
	entry: VerbEntry,
	value: Predicate,
	subjectType: ResolvedType | undefined,
	editCtx: PredicateEditContext,
): boolean {
	if (entry.isCurrent(value)) return true;
	if (!isAuthorablePredicateKind(entry.schemaKind)) return false;
	const subject = subjectOf(value);
	// Sentence verbs build from the current subject. Their admission must not
	// depend on an unrelated direct property in the origin case type: a valid
	// related-property subject already supplies everything the target needs.
	const applicable =
		(VERB_ENTRIES.includes(entry) && subject !== undefined) ||
		predicateCardSchemas[entry.schemaKind].applicable(editCtx);
	const subjectAdmitted =
		entry.subjectGate === undefined || entry.subjectGate(subjectType, subject);
	return applicable && subjectAdmitted;
}

interface PredicateVerbMenuProps {
	readonly value: Predicate;
	readonly onChange: (next: Predicate) => void;
	readonly invalid?: boolean;
}

/**
 * The verb chip + its menu. Rendered by every sentence-shaped card
 * in its verb slot; the chip reads as part of the sentence and the
 * menu holds every behavior the condition can take.
 */
export function PredicateVerbMenu({
	value,
	onChange,
	invalid = false,
}: PredicateVerbMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
	const focus = useRuleFocusContext();
	const ctx = usePredicateEditContext();
	const editCtx: PredicateEditContext = {
		caseTypes: ctx.caseTypes,
		currentCaseType: ctx.currentCaseType,
		knownInputs: ctx.knownInputs,
	};
	// The subject (left operand) drives which verbs are offerable — the
	// same checker `checkComparison` / `checkMatch` validate against, so
	// a verb the subject can't take is never selectable into an error.
	const subjectType = useResolvedType(subjectOf(value));
	const pendingEntry =
		pendingEntryId === null
			? undefined
			: [...VERB_ENTRIES, ...STRUCTURE_ENTRIES].find(
					(entry) => entry.id === pendingEntryId,
				);
	const pendingPlan =
		pendingEntry === undefined
			? null
			: planPredicateTransition(
					value,
					pendingEntry.build(value, editCtx),
					pendingEntry.label,
				);
	const additionalEntries =
		focus === null ? STRUCTURE_ENTRIES : SPECIAL_CONDITION_ENTRIES;
	const additionalEntriesLabel =
		focus === null ? "More ways to combine conditions" : "Special conditions";
	const workbenchVerbTrigger = () => {
		if (focus === null) return null;
		const activePath = JSON.stringify(focus.activePath);
		const regions = [
			...document.querySelectorAll<HTMLElement>("[data-workbench-focus-id]"),
		];
		const activeRegion =
			regions.find(
				(candidate) => candidate.dataset.workbenchFocusId === activePath,
			) ??
			document
				.querySelector<HTMLElement>("[data-workbench-active-heading]")
				?.closest<HTMLElement>("[data-workbench-focus-id]");
		return (
			activeRegion?.querySelector<HTMLButtonElement>(
				"[data-predicate-verb-trigger]",
			) ?? null
		);
	};
	const transitionFinalFocus =
		focus === null ? triggerRef : () => workbenchVerbTrigger() ?? false;
	const restoreWorkbenchVerbFocus = () => {
		if (focus === null) return;
		// A confirmed kind change can replace the card component that owned the
		// alert. Base UI can no longer return to that disconnected trigger, so
		// focus the same semantic control in the newly rendered condition.
		requestAnimationFrame(() => {
			workbenchVerbTrigger()?.focus({ preventScroll: true });
		});
	};

	const chooseEntry = (entry: VerbEntry) => {
		const plan = planPredicateTransition(
			value,
			entry.build(value, editCtx),
			entry.label,
		);
		if (plan.confirmation !== undefined) {
			setPendingEntryId(entry.id);
			return;
		}
		onChange(plan.next);
	};

	const renderEntry = (entry: VerbEntry) => {
		const isCurrent = entry.isCurrent(value);
		// The current verb's own row is never disabled for admission
		// reasons (legacy-open backstop) — `verbEntryAdmitted` exempts it,
		// and only the no-op `isCurrent` disable applies to it.
		const admitted = verbEntryAdmitted(entry, value, subjectType, editCtx);
		// Re-derive the gate pieces only to phrase the disabled reason.
		const subject = subjectOf(value);
		const subjectAdmitted =
			entry.subjectGate === undefined ||
			entry.subjectGate(subjectType, subject);
		const applicable =
			(VERB_ENTRIES.includes(entry) && subject !== undefined) ||
			predicateCardSchemas[entry.schemaKind].applicable(editCtx);
		const reason = !subjectAdmitted
			? entry.disabledReason
			: !applicable
				? predicateUnavailableReason(entry.schemaKind, editCtx)
				: undefined;
		return (
			<DropdownMenuItem
				key={entry.id}
				disabled={!admitted || isCurrent}
				onClick={() => chooseEntry(entry)}
				className={`h-auto min-h-11 items-start whitespace-normal py-2 ${
					isCurrent ? "bg-nova-violet/10 text-nova-violet-bright" : ""
				}`}
			>
				<Icon
					icon={entry.icon}
					width="15"
					height="15"
					className={
						isCurrent ? "text-nova-violet-bright" : "text-nova-text-muted"
					}
				/>
				<span className="flex-1 text-left min-w-0">
					<div className="break-words">{entry.label}</div>
					<div
						className={`break-words text-xs ${
							isCurrent ? "text-nova-violet-bright" : "text-nova-text-muted"
						}`}
					>
						{admitted || reason === undefined ? entry.description : reason}
					</div>
				</span>
				{isCurrent && (
					<Icon
						icon={tablerCheck}
						width="14"
						height="14"
						className="text-nova-violet-bright"
					/>
				)}
			</DropdownMenuItem>
		);
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={triggerRef}
					aria-label={`Condition ${currentVerbLabel(value)}`}
					aria-invalid={invalid || undefined}
					render={
						<Button
							type="button"
							variant="outline"
							size="xl"
							data-predicate-verb-trigger
							className={`group border bg-nova-deep/50 px-3 text-sm dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50 @max-md:justify-self-start ${
								invalid
									? "border-nova-rose/40 text-nova-rose not-disabled:hover:border-nova-rose/60"
									: "border-white/[0.06] text-nova-violet-bright not-disabled:hover:border-nova-violet/30"
							}`}
						/>
					}
				>
					<span>{currentVerbLabel(value)}</span>
					<Icon
						icon={tablerChevronDown}
						width="14"
						height="14"
						className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
					/>
				</DropdownMenuTrigger>
				<DropdownMenuPortal>
					<DropdownMenuPositioner
						side="bottom"
						align="start"
						sideOffset={4}
						anchor={triggerRef}
						style={{ minWidth: "17rem", maxHeight: 380 }}
					>
						<DropdownMenuPopup className="max-h-[min(23.75rem,var(--available-height))] min-w-0">
							{VERB_ENTRIES.filter(
								(entry) =>
									entry.isCurrent(value) ||
									isAuthorablePredicateKind(entry.schemaKind),
							).map(renderEntry)}
							{additionalEntries.length > 0 && (
								<>
									<div
										className="mt-1 border-t border-white/[0.06] px-3 pt-2.5 pb-1 text-xs font-medium text-nova-text-muted"
										role="presentation"
									>
										{additionalEntriesLabel}
									</div>
									{additionalEntries
										.filter(
											(entry) =>
												entry.isCurrent(value) ||
												isAuthorablePredicateKind(entry.schemaKind),
										)
										.map(renderEntry)}
								</>
							)}
						</DropdownMenuPopup>
					</DropdownMenuPositioner>
				</DropdownMenuPortal>
			</DropdownMenu>
			<PredicateTransitionAlert
				plan={pendingPlan}
				finalFocus={transitionFinalFocus}
				onCancel={() => setPendingEntryId(null)}
				onConfirm={() => {
					if (pendingPlan === null) return;
					const next = pendingPlan.next;
					setPendingEntryId(null);
					onChange(next);
					restoreWorkbenchVerbFocus();
				}}
			/>
		</>
	);
}
