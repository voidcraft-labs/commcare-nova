// components/builder/shared/editorSchemas.ts
//
// Declarative registry mapping every Expression kind to its card
// component, label, icon, default-value factory, and applicability
// predicate. Mirrors the field-editor pattern at
// `components/builder/editor/fieldEditorSchemas.ts`: adding a new
// Expression kind requires one entry here, and TypeScript flags the
// omission at compile time via the `Record<ConditionArm["kind"], ...>`
// shape.
//
// Why per-kind entries (instead of per-card-file entries): a card
// COMPONENT can serve multiple Expression kinds: `ComparisonCard`
// serves the six comparison kinds, `LogicalGroupCard` serves
// `and` / `or` / `not`, `ExistsCard` serves `exists` and `missing`,
// `SentinelCards` serves `match-all` / `match-none`, but each
// kind needs its own picker entry (label, icon, default-value,
// applicability filter) so the kind-picker menu reads correctly.
// Sharing a component across kinds is purely a code-organization
// choice; the registry's per-kind keying preserves the
// exhaustivity check independent of file layout.

import type { IconifyIcon } from "@iconify/react/offline";
import tablerArrowsHorizontal from "@iconify-icons/tabler/arrows-horizontal";
import tablerArrowsSplit from "@iconify-icons/tabler/arrows-split";
import tablerAsterisk from "@iconify-icons/tabler/asterisk";
import tablerCheckbox from "@iconify-icons/tabler/checkbox";
import tablerCircleOff from "@iconify-icons/tabler/circle-off";
import tablerEqual from "@iconify-icons/tabler/equal";
import tablerEqualNot from "@iconify-icons/tabler/equal-not";
import tablerFilter from "@iconify-icons/tabler/filter";
import tablerLink from "@iconify-icons/tabler/link";
import tablerListCheck from "@iconify-icons/tabler/list-check";
import tablerLogicAnd from "@iconify-icons/tabler/logic-and";
import tablerLogicNot from "@iconify-icons/tabler/logic-not";
import tablerLogicOr from "@iconify-icons/tabler/logic-or";
import tablerMapPin from "@iconify-icons/tabler/map-pin";
import tablerMathGreater from "@iconify-icons/tabler/math-greater";
import tablerMathLower from "@iconify-icons/tabler/math-lower";
import tablerRegex from "@iconify-icons/tabler/regex";
import tablerSlash from "@iconify-icons/tabler/slash";
import tablerTextRecognition from "@iconify-icons/tabler/text-recognition";
import tablerUnlink from "@iconify-icons/tabler/unlink";
import type { ComponentType } from "react";
import { expressionEditVerdict } from "@/lib/doc/hooks/predicateVerdicts";
import type { CaseProperty, CaseType, UserProperty } from "@/lib/domain";
import {
	effectiveDataType,
	isOrdered,
	isTextShaped,
	proseText,
} from "@/lib/domain";
import {
	acceptsType,
	matchAll as buildMatchAll,
	matchNone as buildMatchNone,
	type ConditionArm,
	type Expression,
	type ExpressionContext,
	type ExpressionOfKind,
	inSubjectConstraint,
	type SlotConstraint,
} from "@/lib/domain/expression";
import { BetweenCard, betweenDefault } from "./cards/BetweenCard";
import { ComparisonCard, comparisonDefault } from "./cards/ComparisonCard";
import {
	ConditionChoiceCard,
	conditionChoiceDefault,
} from "./cards/ConditionChoiceCard";
import { ExistsCard, existsDefault, missingDefault } from "./cards/ExistsCard";
import { InCard, inDefault } from "./cards/InCard";
import { IsBlankCard, isBlankDefault } from "./cards/IsBlankCard";
import {
	andDefault,
	LogicalGroupCard,
	notDefault,
	orDefault,
} from "./cards/LogicalGroupCard";
import { MatchCard, matchDefault } from "./cards/MatchCard";
import {
	MatchesPatternCard,
	matchesPatternDefault,
} from "./cards/MatchesPatternCard";
import {
	MultiSelectContainsCard,
	multiSelectContainsDefault,
} from "./cards/MultiSelectContainsCard";
import { MatchAllCard, MatchNoneCard } from "./cards/SentinelCards";
import {
	WhenInputPresentCard,
	whenInputPresentDefault,
} from "./cards/WhenInputPresentCard";
import {
	WithinDistanceCard,
	withinDistanceDefault,
} from "./cards/WithinDistanceCard";
import { hasConditionSeed } from "./conditionSeed";
import type { OperationValueScope } from "./expressionEditorSchemas";
import type { EditorFormFieldDecl } from "./formFieldPresentation";
import type {
	EditorLookupTableDecl,
	EditorLookupTableScope,
} from "./lookupTablePresentation";
import {
	PATTERN_MATCH_UNAVAILABLE_REASON,
	patternMatchingInScope,
} from "./patternMatchingScope";
import { hasRelatedCaseType } from "./relationSeed";
import type { EditorSearchInputDecl } from "./searchInputPresentation";

/**
 * When a slot's expression is evaluated relative to a case row.
 *
 *   - `"per-case"`: the ordinary scope: the expression runs against a
 *     case (a Results row, a search candidate), so case-property and
 *     relationship reads are meaningful.
 *   - `"selected-case"`: the expression runs against ONE already-chosen
 *     case and can see nothing else: a form's display condition on a
 *     module where everyone picks a case first. CommCare evaluates it on
 *     the case-list screen, where the chosen case is the whole world, so
 *     the commit gate rejects related-case reads, counts, and presence
 *     tests (`FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE`).
 *   - `"global"`: the expression resolves ONCE, before any case is
 *     selected (a search input's starting value, the search-button
 *     display condition, a module's display condition). There is no row
 *     to read: the commit gate rejects case-data reads there
 *     (`CASE_LIST_SEARCH_INPUT_DEFAULT_CASE_DATA_UNAVAILABLE` /
 *     `CASE_SEARCH_BUTTON_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE` /
 *     `MODULE_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE`), so the pickers
 *     must not offer them.
 */
export type CaseDataScope =
	| "per-case"
	| "selected-case"
	| "global"
	| "table-row";

/** One shared disabled-choice reason for every case-data-dependent
 *  pick in a global slot: sources, verbs, and calculated kinds all
 *  read the same sentence so the vocabulary can't drift. */
export const GLOBAL_SCOPE_CASE_DATA_REASON =
	"This is decided before a case is selected, so it can use only fixed values and current-user information";

/** Why a never-matching rule is withheld from a display condition: taking
 *  the item off the menu is the "Show on the menu" switch's job. */
export const NEVER_MATCH_UNAVAILABLE_REASON =
	"To keep this item off the menu, turn off “Show on the menu” in its settings";

/** The `"selected-case"` twin of `GLOBAL_SCOPE_CASE_DATA_REASON`: the
 *  chosen case's own information is available, everything reached
 *  through a connection is not. */
export const SELECTED_CASE_SCOPE_RELATED_DATA_REASON =
	"This is decided for one already-chosen case, so it can read that case's own information but not connected cases or their counts";

export const TABLE_ROW_SCOPE_CASE_DATA_REASON =
	"This rule runs against one data-table row, so it can use that table's columns, earlier form answers, fixed values, and current-user information";

/**
 * Inputs available at the time `defaultValue` and `applicable` run.
 * The factories pick a sensible default property / case type when
 * possible; the applicability predicate narrows the kind picker so
 * authors see only the kinds whose semantics fit the current scope
 * (e.g. `multi-select-contains` is only applicable when the case
 * type has a multi_select-typed property).
 *
 * `caseDataScope` is REQUIRED (not defaulted) so every construction
 * site states which evaluation scope its slot runs in: a surface
 * that silently dropped the axis would offer case reads into a
 * global slot and bounce off the commit gate.
 */
export interface PredicateEditContext {
	readonly expressionContext: ExpressionContext;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly EditorSearchInputDecl[];
	readonly caseDataScope: CaseDataScope;
	/** Custom worker information available to identity-backed user terms.
	 *  Carried here, not just on the React context: because a card's
	 *  cascade reseed resolves types against this shape, and a missing
	 *  catalog would resolve a saved worker-information read to nothing. */
	readonly userProperties?: readonly UserProperty[];
	/** Form answers this slot may read, already narrowed to the ones its
	 *  surface admits. Absent means the slot reads no form answers. */
	readonly formFields?: readonly EditorFormFieldDecl[];
	readonly formCaseTypes?: ReadonlySet<string>;
	/** Rows-free definitions used to resolve lookup identities and types. */
	readonly lookupTables?: readonly EditorLookupTableDecl[];
	/** The active lookup row; direct table-column terms are authorable only
	 * while this exact scope is present. */
	readonly tableScope?: EditorLookupTableScope;
	/** Present only inside a case operation: see `ExpressionEditContext`. */
	readonly operationScope?: OperationValueScope;
	/** Present only for the owner facet of a case operation. */
	readonly ownerValues?: boolean;
	/**
	 * Whether a rule that can never match is meaningful in this slot.
	 *
	 * Defaults to true, because for most carriers it is: a case-list
	 * filter matching nothing is a real query, and the Search action's
	 * condition is deliberately allowed to be `match-none`:
	 * `lib/domain/CLAUDE.md` records that projection as valid authored
	 * data an existing document may already hold, never normalized away.
	 * It is FALSE only for a navigation display condition, where an item
	 * nobody is offered is said with the "Show on the menu" switch
	 * (`hiddenFromMenu`), and a condition that starts with "never" is
	 * refused (`DISPLAY_CONDITION_USE_HIDDEN_FROM_MENU`).
	 *
	 * Deliberately its own axis rather than a reading of
	 * `caseDataScope`: a module's display condition and the Search
	 * action's condition share the `global` scope and disagree here.
	 */
	readonly allowsNeverMatch?: boolean;
	/** In a global slot, the truth value an UNCHOSEN placeholder must
	 *  evaluate to so committing it leaves the rule's meaning unchanged:
	 *  true at the root and inside "all" groups (`and(p, true)` = `p`),
	 *  false inside "any" groups (`or(p, false)` = `p`). Defaults to
	 *  true. Ignored in per-case slots, whose seeds are friendly content
	 *  rather than neutral placeholders. */
	readonly globalPlaceholderHolds?: boolean;
	/** Presentation metadata retained by mounting surfaces. Runtime admission
	 * always reads expressionContext.profile.targets. */
	readonly evaluationTarget?: EvaluationTarget;
	/** Presentation metadata; pattern admission reads profile.patternMatching. */
	readonly patternMatching?: true;
}

/** The runtime a rule is evaluated by. See
 *  `PredicateEditContext.evaluationTarget`. */
export type EvaluationTarget =
	| "on-device"
	| "case-search"
	| "on-device-and-case-search";

/** Whether case-property / relationship reads are meaningful in this
 *  editor scope. */
export function caseDataInScope(ctx: PredicateEditContext): boolean {
	return (
		ctx.caseDataScope === "per-case" || ctx.caseDataScope === "selected-case"
	);
}

export function tableRowInScope(ctx: PredicateEditContext): boolean {
	return ctx.caseDataScope === "table-row";
}

/** Whether a never-matching rule is meaningful in this slot. */
export function neverMatchInScope(ctx: PredicateEditContext): boolean {
	return ctx.allowsNeverMatch ?? true;
}

/** Whether the scope can reach past the case being evaluated:
 *  relationship walks, relationship counts, relationship presence. Only
 *  the ordinary per-case scope can. */
export function relatedCaseDataInScope(
	ctx: Pick<PredicateEditContext, "caseDataScope">,
): boolean {
	return ctx.caseDataScope === "per-case";
}

/** The truth value an unchosen global placeholder must hold in this
 *  editor scope (see `PredicateEditContext.globalPlaceholderHolds`). */
export function globalPlaceholderTruth(ctx: PredicateEditContext): boolean {
	return ctx.globalPlaceholderHolds ?? true;
}

/**
 * One registry entry. Generic over `K` (the Expression kind discriminator)
 * so each entry's `component` and `defaultValue` carry the precise
 * per-arm shape: `ComparisonCard`'s component receives the
 * comparison-arm subtype, `LogicalGroupCard`'s receives the and/or/not
 * arm, etc. The signed exhaustiveness lives at the
 * `predicateCardSchemas` declaration (a `Record<ConditionArm["kind"],
 * ...>`): adding a kind without an entry breaks the build.
 *
 * `icon` carries imported `IconifyIcon` data (the object literal
 * shape exported by `@iconify-icons/tabler/*`). Mirrors the
 * `FieldKindMetadata` shape in `lib/domain/kinds.ts`.
 */
/** The kinds a condition position renders as a card: every condition arm,
 * and `if` whose branches are conditions ("Depends on a condition"). */
export type PredicateCardKind = ConditionArm["kind"] | "if";

export function isPredicateCardValue(
	value: Expression,
): value is ExpressionOfKind<PredicateCardKind> {
	return Object.hasOwn(predicateCardSchemas, value.kind);
}

export const CONDITION_CHOICE_UNAVAILABLE_REASON =
	"Choosing between conditions works in a case list's filter and a search's conditions";

/** Whether this slot admits a runtime choice between conditions here: the
 * gate's verdict on a fresh choice at the current position, so the verb is
 * offered exactly where a commit of it is admitted. */
function conditionChoiceInScope(ctx: PredicateEditContext): boolean {
	return (
		hasConditionSeed(ctx) &&
		expressionEditVerdict(conditionChoiceDefault(ctx), ctx.expressionContext).ok
	);
}

export interface PredicateCardSchema<K extends PredicateCardKind> {
	readonly kind: K;
	readonly label: string;
	readonly icon: IconifyIcon;
	readonly description: string;
	readonly component: ComponentType<{
		readonly value: ExpressionOfKind<K>;
		readonly onChange: (next: Expression) => void;
		readonly path: readonly (string | number)[];
		/** The slot's type constraint: threaded by the dispatch shell
		 *  for signature uniformity with the expression registry. A
		 *  Expression has no result type, so predicate cards compute
		 *  their own child constraints from `useResolvedType` and ignore
		 *  the incoming one (always `ANY_CONSTRAINT`). */
		readonly constraint?: SlotConstraint;
	}>;
	readonly defaultValue: (ctx: PredicateEditContext) => ExpressionOfKind<K>;
	readonly applicable: (ctx: PredicateEditContext) => boolean;
}

// ── Applicability helpers ───────────────────────────────────────────────
//
// Per-kind applicability is a function of the current case-type's
// declared properties. Sharing the helpers across the registry keeps
// the per-kind entries focused on label + icon + factory.

function getCurrentCaseType(ctx: PredicateEditContext): CaseType | undefined {
	return ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
}

/** A subject exists for a plain comparison / blank check: any case
 *  property per-case, or the always-available session values in a
 *  global slot. */
function hasComparableSubject(ctx: PredicateEditContext): boolean {
	if (tableRowInScope(ctx)) return (ctx.tableScope?.columns.length ?? 0) > 0;
	if (!caseDataInScope(ctx)) return true;
	return hasAnyProperty(ctx);
}

function hasAnyProperty(ctx: PredicateEditContext): boolean {
	if (tableRowInScope(ctx)) return (ctx.tableScope?.columns.length ?? 0) > 0;
	const ct = getCurrentCaseType(ctx);
	return ct !== undefined && ct.properties.length > 0;
}

function hasMembershipProperty(ctx: PredicateEditContext): boolean {
	if (tableRowInScope(ctx)) {
		const constraint = inSubjectConstraint();
		return (
			ctx.tableScope?.columns.some((column) =>
				acceptsType(constraint, column.dataType),
			) ?? false
		);
	}
	// Session values are text-shaped, and text is a legal `in` subject:
	// a global slot always has one.
	if (!caseDataInScope(ctx)) return true;
	const constraint = inSubjectConstraint();
	return hasCasePropertyOfType(ctx, (property) =>
		acceptsType(constraint, effectiveDataType(property)),
	);
}

function hasCasePropertyOfType(
	ctx: PredicateEditContext,
	predicate: (p: CaseProperty) => boolean,
): boolean {
	// Property-dependent kinds (ordered comparisons, match,
	// within-distance, multi-select-contains) have no subject in a
	// global slot: session values are text, which none of those kinds
	// admit beyond what `hasComparableSubject` already covers.
	if (!caseDataInScope(ctx)) return false;
	const ct = getCurrentCaseType(ctx);
	if (ct === undefined) return false;
	return ct.properties.some(predicate);
}

/** Scalar comparisons may use either case properties or the active table
 * row's typed columns. Operators whose AST specifically requires a
 * `PropertyRef` use `hasCasePropertyOfType` instead. */
function hasScalarSubjectOfType(
	ctx: PredicateEditContext,
	predicate: (p: CaseProperty) => boolean,
): boolean {
	if (tableRowInScope(ctx)) {
		return (
			ctx.tableScope?.columns.some((column) =>
				predicate({
					name: column.wireName,
					label: proseText(column.label),
					data_type: column.dataType,
				}),
			) ?? false
		);
	}
	return hasCasePropertyOfType(ctx, predicate);
}

/** Actionable copy for condition choices that cannot yet produce a valid
 * predicate in the current scope. Menus share this wording so authors never
 * get a generic search-field instruction for an unrelated case relationship
 * or data-type requirement. */
export function predicateUnavailableReason(
	kind: PredicateCardKind,
	ctx: PredicateEditContext,
): string {
	if (kind === "if" && hasConditionSeed(ctx))
		return CONDITION_CHOICE_UNAVAILABLE_REASON;
	if (kind === "match-none" && !neverMatchInScope(ctx)) {
		return NEVER_MATCH_UNAVAILABLE_REASON;
	}
	if (kind === "matches-pattern" && !patternMatchingInScope(ctx)) {
		return PATTERN_MATCH_UNAVAILABLE_REASON;
	}
	if (tableRowInScope(ctx)) {
		switch (kind) {
			case "match":
			case "multi-select-contains":
			case "within-distance":
			case "exists":
			case "missing":
				return "This condition requires case information and isn't available in a data-table row rule";
			case "lt":
			case "lte":
			case "gt":
			case "gte":
			case "between":
				return "Add a number or date data-table column first";
			case "when-input-present":
				return ctx.knownInputs.length === 0
					? "Add a search field first"
					: TABLE_ROW_SCOPE_CASE_DATA_REASON;
			default:
				return (ctx.tableScope?.columns.length ?? 0) === 0
					? "Add a data-table column first"
					: TABLE_ROW_SCOPE_CASE_DATA_REASON;
		}
	}
	if (!caseDataInScope(ctx)) return GLOBAL_SCOPE_CASE_DATA_REASON;
	switch (kind) {
		case "exists":
		case "missing":
			return relatedCaseDataInScope(ctx)
				? "Add a parent or child case type first"
				: SELECTED_CASE_SCOPE_RELATED_DATA_REASON;
		case "when-input-present":
			return ctx.knownInputs.length === 0
				? "Add a search field first"
				: "Add case information or a related case type first";
		case "and":
		case "or":
		case "not":
			return "Add case information or a related case type first";
		case "lt":
		case "lte":
		case "gt":
		case "gte":
		case "between":
			return "Add number or date case information first";
		case "multi-select-contains":
			return "Add case information with multiple choices first";
		case "within-distance":
			return "Add location case information first";
		case "match":
			return "Add text, choice, date, or time case information first";
		default:
			return "Add case information first";
	}
}

// ── Registry ────────────────────────────────────────────────────────────
//
// Keyed by `ConditionArm["kind"]` so the discriminator union forces an
// entry for every kind. Six comparison kinds share `ComparisonCard`,
// `match-all` / `match-none` share `SentinelCards`, `and` / `or` /
// `not` share `LogicalGroupCard`, `exists` / `missing` share
// `ExistsCard`. Each kind's entry retains its own label / icon /
// description / factory so the kind-picker UI reads each as a
// distinct option even when the component is shared.

/**
 * Per-kind editor schema keyed by `ConditionArm["kind"]`. The
 * mapped-type shape forces TypeScript to fail compilation if a new
 * kind lands in the Expression union without a parallel entry, the
 * registry's exhaustivity is the structural guarantee that the
 * editor never silently bypasses a kind.
 */
export const predicateCardSchemas: {
	readonly [K in PredicateCardKind]: PredicateCardSchema<K>;
} = {
	// ── Comparison (6 kinds, one card) ──────────────────────────────
	eq: {
		kind: "eq",
		label: "Is",
		icon: tablerEqual,
		description: "The property is exactly a value",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("eq", ctx),
		applicable: hasComparableSubject,
	},
	neq: {
		kind: "neq",
		label: "Isn't",
		icon: tablerEqualNot,
		description: "The property is anything except a value",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("neq", ctx),
		applicable: hasComparableSubject,
	},
	lt: {
		kind: "lt",
		label: "Is less than",
		icon: tablerMathLower,
		description: "Below a number or date",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("lt", ctx),
		applicable: (ctx) => hasScalarSubjectOfType(ctx, isOrdered),
	},
	lte: {
		kind: "lte",
		label: "Is at most",
		icon: tablerMathLower,
		description: "A value or below",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("lte", ctx),
		applicable: (ctx) => hasScalarSubjectOfType(ctx, isOrdered),
	},
	gt: {
		kind: "gt",
		label: "Is more than",
		icon: tablerMathGreater,
		description: "Above a number or date",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("gt", ctx),
		applicable: (ctx) => hasScalarSubjectOfType(ctx, isOrdered),
	},
	gte: {
		kind: "gte",
		label: "Is at least",
		icon: tablerMathGreater,
		description: "A value or above",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("gte", ctx),
		applicable: (ctx) => hasScalarSubjectOfType(ctx, isOrdered),
	},

	// ── Membership / range ──────────────────────────────────────────
	in: {
		kind: "in",
		label: "Is any of",
		icon: tablerListCheck,
		description: "Matches one value from a list",
		component: InCard,
		defaultValue: inDefault,
		applicable: hasMembershipProperty,
	},
	between: {
		kind: "between",
		label: "Is between",
		icon: tablerArrowsHorizontal,
		description: "Falls inside a range with either end left open if needed",
		component: BetweenCard,
		defaultValue: betweenDefault,
		applicable: (ctx) => hasScalarSubjectOfType(ctx, isOrdered),
	},

	// ── Multi-select containment ────────────────────────────────────
	"multi-select-contains": {
		kind: "multi-select-contains",
		label: "Includes options",
		icon: tablerCheckbox,
		description: "Includes one or every option you choose",
		component: MultiSelectContainsCard,
		defaultValue: multiSelectContainsDefault,
		applicable: (ctx) =>
			hasCasePropertyOfType(ctx, (p) => p.data_type === "multi_select"),
	},

	// ── Text match (4 modes, one card) ──────────────────────────────
	match: {
		kind: "match",
		label: "Matches text",
		icon: tablerTextRecognition,
		description:
			"Match by similar spelling, the beginning of text, sound, or a flexible date",
		component: MatchCard,
		defaultValue: matchDefault,
		applicable: (ctx) =>
			hasCasePropertyOfType(
				ctx,
				(p) =>
					isTextShaped(p) ||
					p.data_type === "date" ||
					p.data_type === "datetime",
			),
	},

	// ── Geo ─────────────────────────────────────────────────────────
	"within-distance": {
		kind: "within-distance",
		label: "Is near",
		icon: tablerMapPin,
		description: "Within a distance of a place",
		component: WithinDistanceCard,
		defaultValue: withinDistanceDefault,
		applicable: (ctx) =>
			hasCasePropertyOfType(ctx, (p) => p.data_type === "geopoint"),
	},

	// ── Null / blank ─────────────────────────────────────────────────
	"is-blank": {
		kind: "is-blank",
		label: "Is blank",
		icon: tablerCircleOff,
		description: "Empty or missing entirely",
		component: IsBlankCard,
		defaultValue: isBlankDefault,
		applicable: hasComparableSubject,
	},

	// ── Pattern ──────────────────────────────────────────────────────
	"matches-pattern": {
		kind: "matches-pattern",
		label: "Matches a pattern",
		icon: tablerRegex,
		description: "Fits a regular expression, checked on the device",
		component: MatchesPatternCard,
		defaultValue: matchesPatternDefault,
		/* Only where the slot runs on the device's Pattern engine. A SAVED
		 * pattern match still renders and re-emits wherever it sits;
		 * `applicable` governs the add/replace menus, never round-tripping. */
		applicable: (ctx) =>
			patternMatchingInScope(ctx) && hasComparableSubject(ctx),
	},

	// ── Sentinels ────────────────────────────────────────────────────
	"match-all": {
		kind: "match-all",
		label: "Always match",
		icon: tablerAsterisk,
		description: "Let everything pass this condition",
		component: MatchAllCard,
		defaultValue: () => buildMatchAll(),
		applicable: () => true,
	},
	"match-none": {
		kind: "match-none",
		label: "Never match",
		icon: tablerSlash,
		description: "Let nothing pass this condition",
		component: MatchNoneCard,
		defaultValue: () => buildMatchNone(),
		/* Meaningful wherever "nothing matches" is a real answer: an
		 * empty case list, a Search action deliberately withheld, and
		 * withheld only where the commit gate refuses it. An ALREADY
		 * SAVED `match-none` still renders and re-emits: `applicable`
		 * governs the add/replace menus, never round-tripping. */
		applicable: neverMatchInScope,
	},

	// ── Logical groups (and / or / not, one card) ───────────────────
	and: {
		kind: "and",
		label: "All conditions match",
		icon: tablerLogicAnd,
		description: "Group conditions so every condition must match",
		component: LogicalGroupCard,
		defaultValue: andDefault,
		applicable: hasConditionSeed,
	},
	or: {
		kind: "or",
		label: "Any condition matches",
		icon: tablerLogicOr,
		description: "Group conditions so at least one condition must match",
		component: LogicalGroupCard,
		defaultValue: orDefault,
		applicable: hasConditionSeed,
	},
	not: {
		kind: "not",
		label: "Exclude when",
		icon: tablerLogicNot,
		description: "Exclude cases when the condition inside matches",
		component: LogicalGroupCard,
		defaultValue: notDefault,
		applicable: hasConditionSeed,
	},

	// ── Conditional ──────────────────────────────────────────────────
	"when-input-present": {
		kind: "when-input-present",
		label: "After a search answer",
		icon: tablerFilter,
		description: "Apply the condition only after a search field has an answer",
		component: WhenInputPresentCard,
		defaultValue: whenInputPresentDefault,
		applicable: (ctx) => ctx.knownInputs.length > 0 && hasConditionSeed(ctx),
	},

	// ── Runtime choice ───────────────────────────────────────────────
	if: {
		kind: "if",
		label: "Depends on a condition",
		icon: tablerArrowsSplit,
		description:
			"Use one condition or another, decided by something like a search answer",
		component: ConditionChoiceCard,
		defaultValue: conditionChoiceDefault,
		applicable: conditionChoiceInScope,
	},

	// ── Relational quantifiers ──────────────────────────────────────
	exists: {
		kind: "exists",
		label: "Has a related case",
		icon: tablerLink,
		description: "Require at least one connected case to match",
		component: ExistsCard,
		defaultValue: existsDefault,
		applicable: (ctx) => relatedCaseDataInScope(ctx) && hasRelatedCaseType(ctx),
	},
	missing: {
		kind: "missing",
		label: "Has no related case",
		icon: tablerUnlink,
		description: "Require that no connected case matches",
		component: ExistsCard,
		defaultValue: missingDefault,
		applicable: (ctx) => relatedCaseDataInScope(ctx) && hasRelatedCaseType(ctx),
	},
};

/**
 * Convenience array: every schema in declaration order, used by the
 * kind-picker UI to render the menu.
 */
export const predicateCardSchemaList: readonly PredicateCardSchema<PredicateCardKind>[] =
	Object.values(
		predicateCardSchemas,
	) as readonly PredicateCardSchema<PredicateCardKind>[];
