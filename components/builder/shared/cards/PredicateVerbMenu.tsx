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
import {
	type ComparisonKind,
	not,
	type Predicate,
	type PropertyRef,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { usePredicateEditContext } from "../editorContext";
import {
	type PredicateEditContext,
	predicateCardSchemas,
} from "../editorSchemas";
import { preservedOperandSwap } from "./ChildPredicateEditor";
import { KIND_BUILDERS as COMPARISON_BUILDERS } from "./ComparisonCard";

type MatchMode = Extract<Predicate, { kind: "match" }>["mode"];

/** One pickable verb (or structural shape). `id` is unique across
 *  the menu; `build` produces the next AST node from the current
 *  one, carrying over whatever the target shape can hold. */
interface VerbEntry {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	/** Scan anchor — menus are skimmed by glyph before they're read. */
	readonly icon: IconifyIcon;
	/** The schema kind backing applicability dimming. */
	readonly schemaKind: Predicate["kind"];
	readonly isCurrent: (value: Predicate) => boolean;
	readonly build: (value: Predicate, ctx: PredicateEditContext) => Predicate;
}

// ── Subject / object extraction ───────────────────────────────────
//
// The "subject" is what the condition is about — the left operand.
// Carrying it across a verb change is the whole point of the shared
// menu: changing HOW you compare must never lose WHAT you compare.

function subjectOf(value: Predicate): ValueExpression | undefined {
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

// ── Per-family builders ───────────────────────────────────────────

function buildComparison(
	kind: ComparisonKind,
	value: Predicate,
	ctx: PredicateEditContext,
): Predicate {
	// Same family: both operands carry verbatim.
	const preserved = preservedOperandSwap(value, kind);
	if (preserved !== null) return preserved;
	const fallback = predicateCardSchemas[kind].defaultValue(ctx);
	const left = subjectOf(value) ?? fallback.left;
	const right = objectOf(value) ?? fallback.right;
	return COMPARISON_BUILDERS[kind](left, right);
}

function buildMatch(
	mode: MatchMode,
	value: Predicate,
	ctx: PredicateEditContext,
): Predicate {
	if (value.kind === "match") {
		return { ...value, mode };
	}
	const fallback = predicateCardSchemas.match.defaultValue(ctx);
	return {
		...fallback,
		mode,
		property: subjectRefOf(value) ?? fallback.property,
		value: objectOf(value) ?? fallback.value,
	};
}

function buildWithSubjectLeft(
	kind: "in" | "between" | "is-null" | "is-blank",
	value: Predicate,
	ctx: PredicateEditContext,
): Predicate {
	const preserved = preservedOperandSwap(value, kind);
	if (preserved !== null) return preserved;
	const fallback = predicateCardSchemas[kind].defaultValue(ctx);
	const subject = subjectOf(value);
	return subject === undefined ? fallback : { ...fallback, left: subject };
}

function buildContains(
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
	return {
		...fallback,
		quantifier,
		...(ref !== undefined ? { property: ref } : {}),
	};
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

function buildVerbEntries(): readonly VerbEntry[] {
	const entries: VerbEntry[] = [];
	for (const v of COMPARISON_VERBS) {
		entries.push({
			id: v.kind,
			label: v.label,
			description: v.description,
			icon: v.icon,
			schemaKind: v.kind,
			isCurrent: (p) => p.kind === v.kind,
			build: (p, ctx) => buildComparison(v.kind, p, ctx),
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
				return ref !== undefined ? { ...fallback, property: ref } : fallback;
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

const VERB_ENTRIES = buildVerbEntries();

/** Structural shapes — not sentences. Picking one replaces (or
 *  wraps) the condition with a container card. */
const STRUCTURE_ENTRIES: readonly VerbEntry[] = [
	{
		id: "and",
		label: "All of these…",
		icon: tablerLogicAnd,
		description: "A group — every condition inside must match.",
		schemaKind: "and",
		isCurrent: (p) => p.kind === "and",
		build: (_p, ctx) => predicateCardSchemas.and.defaultValue(ctx),
	},
	{
		id: "or",
		label: "Any of these…",
		icon: tablerLogicOr,
		description: "A group — at least one condition inside must match.",
		schemaKind: "or",
		isCurrent: (p) => p.kind === "or",
		build: (_p, ctx) => predicateCardSchemas.or.defaultValue(ctx),
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
		description: "Matches every case — a placeholder to build from.",
		schemaKind: "match-all",
		isCurrent: (p) => p.kind === "match-all",
		build: (_p, ctx) => predicateCardSchemas["match-all"].defaultValue(ctx),
	},
	{
		id: "match-none",
		label: "Always false",
		icon: tablerSlash,
		description: "Matches nothing — an explicit off switch.",
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

	const renderEntry = (entry: VerbEntry, corners: string) => {
		const isCurrent = entry.isCurrent(value);
		const isApplicable =
			predicateCardSchemas[entry.schemaKind].applicable(editCtx);
		return (
			<Menu.Item
				key={entry.id}
				disabled={isCurrent}
				onClick={() => onChange(entry.build(value, editCtx))}
				className={`${corners} ${MENU_ITEM_CLS} min-h-11 ${
					isCurrent ? "text-nova-violet-bright bg-nova-violet/10" : ""
				} ${isApplicable ? "" : "opacity-45"}`}
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
							isCurrent ? "text-nova-violet-bright/60" : "text-nova-text-muted"
						}`}
					>
						{entry.description}
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
						? "border-nova-error/40 text-nova-error/90 hover:border-nova-error/60"
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
