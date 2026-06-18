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
import { Menu } from "@base-ui/react/menu";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerAbc from "@iconify-icons/tabler/abc";
import tablerArrowsHorizontal from "@iconify-icons/tabler/arrows-horizontal";
import tablerAsterisk from "@iconify-icons/tabler/asterisk";
import tablerCalendarQuestion from "@iconify-icons/tabler/calendar-question";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerCheckbox from "@iconify-icons/tabler/checkbox";
import tablerChecks from "@iconify-icons/tabler/checks";
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
import { useRef } from "react";
import { effectiveDataType } from "@/lib/domain";
import {
	and,
	between,
	type ComparisonKind,
	comparisonOperatorsFor,
	compatibleTypesFor,
	isIn,
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
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { usePredicateEditContext, useResolvedType } from "../editorContext";
import {
	type PredicateEditContext,
	predicateCardSchemas,
} from "../editorSchemas";
import { preservedOperandSwap } from "./ChildPredicateEditor";
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
	readonly subjectGate?: (subjectType: ResolvedType | undefined) => boolean;
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
	const ct = ctx.caseTypes.find((c) => c.name === ref.caseType);
	const property = ct?.properties.find((p) => p.name === ref.property);
	return property === undefined ? undefined : effectiveDataType(property);
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
	// Same family: both operands carry verbatim (the subject-type gate
	// already blocked an operator the subject can't support).
	const preserved = preservedOperandSwap(value, kind);
	if (preserved !== null) return preserved;
	// Cross-family → comparison: carry the subject, then reseed the
	// value to the subject's compatible set. The fallback's value was
	// built for the fallback's OWN property, not this subject, so it is
	// reseeded the same as a carried value — `eq(geopoint, "")` (a text
	// literal opposite a place subject) becomes `eq(geopoint, null)`.
	const fallback = predicateCardSchemas[kind].defaultValue(ctx);
	const left = subjectOf(value) ?? fallback.left;
	const accepts = compatibleTypesFor(resolveExpressionType(left, ctx));
	const right = reseedObjectIfNeeded(
		objectOf(value) ?? fallback.right,
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
	const carried = objectOf(value);
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
	if (value.kind === "term") {
		const type = resolveExpressionType(value, ctx);
		if (type === undefined || allow.has(type)) return value;
	}
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
		// Reseed the membership values to the subject's compatible set.
		const inFallback = fallback as Extract<Predicate, { kind: "in" }>;
		const values = inFallback.values.map((v) =>
			reseedLiteralForConstraint(v, accepts),
		);
		const [first, ...rest] = values;
		return isIn(subject, first, ...rest);
	}
	if (kind === "between") {
		// Reseed each bound to the subject's compatible set.
		const b = fallback as Extract<Predicate, { kind: "between" }>;
		return between(subject, {
			lower:
				b.lower !== undefined
					? reseedObjectIfNeeded(b.lower, accepts, ctx)
					: undefined,
			upper:
				b.upper !== undefined
					? reseedObjectIfNeeded(b.upper, accepts, ctx)
					: undefined,
			lowerInclusive: b.lowerInclusive,
			upperInclusive: b.upperInclusive,
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
	return carry
		? { ...fallback, quantifier, property: ref }
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
		description: "Exactly this value.",
		icon: tablerEqual,
	},
	{
		kind: "neq",
		label: "is not",
		description: "Anything except this value.",
		icon: tablerEqualNot,
	},
	{
		kind: "gt",
		label: "is more than",
		description: "Above the value — numbers and dates compare by order.",
		icon: tablerMathGreater,
	},
	{
		kind: "gte",
		label: "is at least",
		description: "The value or above.",
		icon: tablerMathEqualGreater,
	},
	{
		kind: "lt",
		label: "is less than",
		description: "Below the value.",
		icon: tablerMathLower,
	},
	{
		kind: "lte",
		label: "is at most",
		description: "The value or below.",
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
		label: "fuzzy matches",
		description: "Forgives a typo or two per word; ignores capitalization.",
		icon: tablerWand,
	},
	{
		mode: "starts-with",
		label: "starts with",
		description: "Begins with the text — capitalization counts.",
		icon: tablerAbc,
	},
	{
		mode: "phonetic",
		label: "sounds like",
		description: "Same spoken sound — Smith finds Smyth.",
		icon: tablerEar,
	},
	{
		mode: "fuzzy-date",
		label: "fuzzy matches the date",
		description: "Forgives swapped day and month, and mistyped digits.",
		icon: tablerCalendarQuestion,
	},
];

/** Ordering operators compare by total order — only ordered subject
 *  types support them. */
const ORDERED_COMPARISON_REASON =
	"Only numbers, dates, and times compare by order.";

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
			subjectGate: (t: ResolvedType | undefined) =>
				matchModesFor(t).has(m.mode),
			disabledReason:
				m.mode === "fuzzy-date"
					? "Fuzzy-date matching needs a date or text property."
					: "Text matching needs a text property.",
		});
	}
	entries.push(
		{
			id: "in",
			label: "is any of",
			icon: tablerListCheck,
			description: "Matches one value from a list you write.",
			schemaKind: "in",
			isCurrent: (p) => p.kind === "in",
			build: (p, ctx) => buildWithSubjectLeft("in", p, ctx),
		},
		{
			id: "between",
			label: "is between",
			icon: tablerArrowsHorizontal,
			description: "Falls inside a range — either end optional.",
			schemaKind: "between",
			isCurrent: (p) => p.kind === "between",
			build: (p, ctx) => buildWithSubjectLeft("between", p, ctx),
			subjectGate: (t) => comparisonOperatorsFor(t).has("gt"),
			disabledReason:
				"A range needs an ordered property — a number, date, or time.",
		},
		{
			id: "msc:any",
			label: "includes any of",
			icon: tablerCheckbox,
			description: "The multi-choice list has at least one of the options.",
			schemaKind: "multi-select-contains",
			isCurrent: (p) =>
				p.kind === "multi-select-contains" && p.quantifier === "any",
			build: (p, ctx) => buildContains("any", p, ctx),
		},
		{
			id: "msc:all",
			label: "includes all of",
			icon: tablerChecks,
			description: "The multi-choice list has every one of the options.",
			schemaKind: "multi-select-contains",
			isCurrent: (p) =>
				p.kind === "multi-select-contains" && p.quantifier === "all",
			build: (p, ctx) => buildContains("all", p, ctx),
		},
		{
			id: "within-distance",
			label: "is near",
			icon: tablerMapPin,
			description: "Within a distance of a place.",
			schemaKind: "within-distance",
			isCurrent: (p) => p.kind === "within-distance",
			build: (p, ctx) => {
				if (p.kind === "within-distance") return p;
				const fallback =
					predicateCardSchemas["within-distance"].defaultValue(ctx);
				const ref = subjectRefOf(p);
				// Only carry the subject when it's a geopoint property;
				// otherwise the fallback already anchored a valid one.
				const carry =
					ref !== undefined && propertyType(ctx, ref) === "geopoint";
				return carry ? { ...fallback, property: ref } : fallback;
			},
		},
		{
			id: "is-blank",
			label: "is blank",
			icon: tablerCircleOff,
			description: "Empty, or missing entirely.",
			schemaKind: "is-blank",
			isCurrent: (p) => p.kind === "is-blank",
			build: (p, ctx) => buildWithSubjectLeft("is-blank", p, ctx),
		},
		{
			id: "is-null",
			label: "was never recorded",
			icon: tablerCircleDashed,
			description: "Strictly absent — an empty value still counts as recorded.",
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
		label: "All of these…",
		icon: tablerLogicAnd,
		description: "A group — every condition inside must match.",
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
		label: "Any of these…",
		icon: tablerLogicOr,
		description: "A group — at least one condition inside must match.",
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
		label: "Not…",
		icon: tablerLogicNot,
		description: "Flips this condition — matches when it doesn't.",
		schemaKind: "not",
		isCurrent: (p) => p.kind === "not",
		// Wrapping (not replacing) is the honest meaning of "not".
		build: (p) => not(p),
	},
	{
		id: "exists",
		label: "Has a related case…",
		icon: tablerLink,
		description: "At least one connected case satisfies a condition.",
		schemaKind: "exists",
		isCurrent: (p) => p.kind === "exists",
		build: (_p, ctx) => predicateCardSchemas.exists.defaultValue(ctx),
	},
	{
		id: "missing",
		label: "Has no related case…",
		icon: tablerUnlink,
		description: "No connected case satisfies the condition.",
		schemaKind: "missing",
		isCurrent: (p) => p.kind === "missing",
		build: (_p, ctx) => predicateCardSchemas.missing.defaultValue(ctx),
	},
	{
		id: "when-input-present",
		label: "When a search field is filled…",
		icon: tablerFilter,
		description: "Applies this condition only while a field has a value.",
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
		label: "Always true",
		icon: tablerAsterisk,
		description: "Always passes — a placeholder to build from.",
		schemaKind: "match-all",
		isCurrent: (p) => p.kind === "match-all",
		build: (_p, ctx) => predicateCardSchemas["match-all"].defaultValue(ctx),
	},
	{
		id: "match-none",
		label: "Always false",
		icon: tablerSlash,
		description: "Never passes — an explicit off switch.",
		schemaKind: "match-none",
		isCurrent: (p) => p.kind === "match-none",
		build: (_p, ctx) => predicateCardSchemas["match-none"].defaultValue(ctx),
	},
];

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
	const applicable = predicateCardSchemas[entry.schemaKind].applicable(editCtx);
	const subjectAdmitted =
		entry.subjectGate === undefined || entry.subjectGate(subjectType);
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

	const renderEntry = (entry: VerbEntry, corners: string) => {
		const isCurrent = entry.isCurrent(value);
		// The current verb's own row is never disabled for admission
		// reasons (legacy-open backstop) — `verbEntryAdmitted` exempts it,
		// and only the no-op `isCurrent` disable applies to it.
		const admitted = verbEntryAdmitted(entry, value, subjectType, editCtx);
		// Re-derive the gate pieces only to phrase the disabled reason.
		const subjectAdmitted =
			entry.subjectGate === undefined || entry.subjectGate(subjectType);
		const reason = !subjectAdmitted
			? entry.disabledReason
			: !predicateCardSchemas[entry.schemaKind].applicable(editCtx)
				? "Not available for this case type."
				: undefined;
		return (
			<Menu.Item
				key={entry.id}
				disabled={!admitted || isCurrent}
				onClick={() => onChange(entry.build(value, editCtx))}
				className={`${corners} ${MENU_ITEM_CLS} min-h-11 ${
					isCurrent ? "text-nova-violet-bright bg-nova-violet/10" : ""
				} ${admitted ? "" : "opacity-45"}`}
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
					<div className="truncate">{entry.label}</div>
					<div
						className={`text-[11px] truncate ${
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
			</Menu.Item>
		);
	};

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Condition: ${currentVerbLabel(value)}`}
				className={`group flex items-center gap-1.5 px-3 min-h-11 text-[13px] rounded-lg border bg-nova-deep/50 transition-colors cursor-pointer @max-md:justify-self-start ${
					invalid
						? "border-nova-rose/40 text-nova-rose hover:border-nova-rose/60"
						: "border-white/[0.06] text-nova-violet-bright hover:border-nova-violet/30"
				}`}
			>
				<span>{currentVerbLabel(value)}</span>
				<svg
					aria-hidden="true"
					width="10"
					height="10"
					viewBox="0 0 10 10"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				>
					<path
						d="M2 3.5L5 6.5L8 3.5"
						stroke="currentColor"
						strokeWidth="1.2"
						fill="none"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
					style={{ maxHeight: 380 }}
				>
					<Menu.Popup
						className={`${MENU_POPUP_CLS} max-h-[23.75rem] overflow-y-auto min-w-[17rem]`}
					>
						{VERB_ENTRIES.map((entry, i) =>
							renderEntry(entry, i === 0 ? "rounded-t-xl" : ""),
						)}
						<div
							className="px-3 pt-2.5 pb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-nova-text-muted border-t border-white/[0.06] mt-1"
							role="presentation"
						>
							Structure
						</div>
						{STRUCTURE_ENTRIES.map((entry, i) =>
							renderEntry(
								entry,
								i === STRUCTURE_ENTRIES.length - 1 ? "rounded-b-xl" : "",
							),
						)}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
