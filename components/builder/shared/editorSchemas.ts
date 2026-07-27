// components/builder/shared/editorSchemas.ts
//
// Declarative registry mapping every Predicate kind to its card
// component, label, icon, default-value factory, and applicability
// predicate. Mirrors the field-editor pattern at
// `components/builder/editor/fieldEditorSchemas.ts` — adding a new
// Predicate kind requires one entry here, and TypeScript flags the
// omission at compile time via the `Record<Predicate["kind"], ...>`
// shape.
//
// Why per-kind entries (instead of per-card-file entries): a card
// COMPONENT can serve multiple Predicate kinds — `ComparisonCard`
// serves the six comparison kinds, `LogicalGroupCard` serves
// `and` / `or` / `not`, `ExistsCard` serves `exists` and `missing`,
// `SentinelCards` serves `match-all` / `match-none` — but each
// kind needs its own picker entry (label, icon, default-value,
// applicability filter) so the kind-picker menu reads correctly.
// Sharing a component across kinds is purely a code-organization
// choice; the registry's per-kind keying preserves the
// exhaustivity check independent of file layout.

import type { IconifyIcon } from "@iconify/react/offline";
import tablerArrowsHorizontal from "@iconify-icons/tabler/arrows-horizontal";
import tablerAsterisk from "@iconify-icons/tabler/asterisk";
import tablerCheckbox from "@iconify-icons/tabler/checkbox";
import tablerCircleDashed from "@iconify-icons/tabler/circle-dashed";
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
import tablerSlash from "@iconify-icons/tabler/slash";
import tablerTextRecognition from "@iconify-icons/tabler/text-recognition";
import tablerUnlink from "@iconify-icons/tabler/unlink";
import type { ComponentType } from "react";
import type { CaseProperty, CaseType, UserProperty } from "@/lib/domain";
import { effectiveDataType, isOrdered, isTextShaped } from "@/lib/domain";
import {
	acceptsType,
	matchAll as buildMatchAll,
	matchNone as buildMatchNone,
	type ComparisonKind,
	expressionReadsCaseData,
	expressionReadsRelatedCaseData,
	inSubjectConstraint,
	type Predicate,
	type SlotConstraint,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { BetweenCard, betweenDefault } from "./cards/BetweenCard";
import { ComparisonCard, comparisonDefault } from "./cards/ComparisonCard";
import { ExistsCard, existsDefault, missingDefault } from "./cards/ExistsCard";
import { InCard, inDefault } from "./cards/InCard";
import { IsBlankCard, isBlankDefault } from "./cards/IsBlankCard";
import { IsNullCard, isNullDefault } from "./cards/IsNullCard";
import {
	andDefault,
	LogicalGroupCard,
	notDefault,
	orDefault,
} from "./cards/LogicalGroupCard";
import { MatchCard, matchDefault } from "./cards/MatchCard";
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
import { hasRelatedCaseType } from "./relationSeed";
import type { EditorSearchInputDecl } from "./searchInputPresentation";

/**
 * When a slot's expression is evaluated relative to a case row.
 *
 *   - `"per-case"` — the ordinary scope: the expression runs against a
 *     case (a Results row, a search candidate), so case-property and
 *     relationship reads are meaningful.
 *   - `"selected-case"` — the expression runs against ONE already-chosen
 *     case and can see nothing else: a form's display condition on a
 *     module where everyone picks a case first. CommCare evaluates it on
 *     the case-list screen, where the chosen case is the whole world, so
 *     the commit gate rejects related-case reads, counts, and presence
 *     tests (`FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE`).
 *   - `"global"` — the expression resolves ONCE, before any case is
 *     selected (a search input's starting value, the search-button
 *     display condition, a module's display condition). There is no row
 *     to read: the commit gate rejects case-data reads there
 *     (`CASE_LIST_SEARCH_INPUT_DEFAULT_CASE_DATA_UNAVAILABLE` /
 *     `CASE_SEARCH_BUTTON_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE` /
 *     `MODULE_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE`), so the pickers
 *     must not offer them.
 */
export type CaseDataScope = "per-case" | "selected-case" | "global";

/** One shared disabled-choice reason for every case-data-dependent
 *  pick in a global slot — sources, verbs, and calculated kinds all
 *  read the same sentence so the vocabulary can't drift. */
export const GLOBAL_SCOPE_CASE_DATA_REASON =
	"This is decided before a case is selected, so it can use only fixed values and current-user information";

/** Why a never-matching rule is withheld from a display condition. */
export const NEVER_MATCH_UNAVAILABLE_REASON =
	"Nobody could ever reach this item, so remove the item itself rather than hiding it from everyone";

/** The `"selected-case"` twin of `GLOBAL_SCOPE_CASE_DATA_REASON`: the
 *  chosen case's own information is available, everything reached
 *  through a connection is not. */
export const SELECTED_CASE_SCOPE_RELATED_DATA_REASON =
	"This is decided for one already-chosen case, so it can read that case's own information but not connected cases or their counts";

/**
 * Inputs available at the time `defaultValue` and `applicable` run.
 * The factories pick a sensible default property / case type when
 * possible; the applicability predicate narrows the kind picker so
 * authors see only the kinds whose semantics fit the current scope
 * (e.g. `multi-select-contains` is only applicable when the case
 * type has a multi_select-typed property).
 *
 * `caseDataScope` is REQUIRED (not defaulted) so every construction
 * site states which evaluation scope its slot runs in — a surface
 * that silently dropped the axis would offer case reads into a
 * global slot and bounce off the commit gate.
 */
export interface PredicateEditContext {
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly EditorSearchInputDecl[];
	readonly caseDataScope: CaseDataScope;
	/** Custom worker information available to identity-backed user terms.
	 *  Carried here — not just on the React context — because a card's
	 *  cascade reseed resolves types against this shape, and a missing
	 *  catalog would resolve a saved worker-information read to nothing. */
	readonly userProperties?: readonly UserProperty[];
	/** Form answers this slot may read, already narrowed to the ones its
	 *  surface admits. Absent means the slot reads no form answers. */
	readonly formFields?: readonly EditorFormFieldDecl[];
	/** Present only inside a case operation — see `ExpressionEditContext`. */
	readonly operationScope?: OperationValueScope;
	/**
	 * Whether a rule that can never match is meaningful in this slot.
	 *
	 * Defaults to true, because for most carriers it is: a case-list
	 * filter matching nothing is a real query, and the Search action's
	 * condition is deliberately allowed to be `match-none` —
	 * `lib/domain/CLAUDE.md` records that projection as valid authored
	 * data an existing document may already hold, never normalized away.
	 * It is FALSE only for a navigation display condition, where "never"
	 * means nobody could ever open the item and the commit gate refuses
	 * it (`DISPLAY_CONDITION_ALWAYS_FALSE`).
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
}

/** Whether case-property / relationship reads are meaningful in this
 *  editor scope. */
export function caseDataInScope(ctx: PredicateEditContext): boolean {
	return ctx.caseDataScope !== "global";
}

/** Whether a never-matching rule is meaningful in this slot. */
export function neverMatchInScope(ctx: PredicateEditContext): boolean {
	return ctx.allowsNeverMatch ?? true;
}

/** Whether the scope can reach past the case being evaluated —
 *  relationship walks, relationship counts, relationship presence. Only
 *  the ordinary per-case scope can. */
export function relatedCaseDataInScope(ctx: PredicateEditContext): boolean {
	return ctx.caseDataScope === "per-case";
}

/** The truth value an unchosen global placeholder must hold in this
 *  editor scope (see `PredicateEditContext.globalPlaceholderHolds`). */
export function globalPlaceholderTruth(ctx: PredicateEditContext): boolean {
	return ctx.globalPlaceholderHolds ?? true;
}

export type ScopeAdmission =
	| { readonly admitted: true }
	| { readonly admitted: false; readonly reason: string };

/**
 * Whether an evaluation scope lets a value be committed into a slot.
 *
 * `PredicateEditProvider` composes this in FRONT of any caller-supplied
 * oracle so every value-source and calculated-kind menu disables an
 * out-of-scope read with one shared reason. It lives here, as a pure
 * function of the scope alone, so a test can drive the exact rule the
 * running editor applies rather than a re-derivation of it.
 */
export function caseDataScopeAdmission(
	scope: CaseDataScope,
	next: ValueExpression,
): ScopeAdmission {
	if (scope === "per-case") return { admitted: true };
	const readsOutOfScope =
		scope === "global"
			? expressionReadsCaseData
			: expressionReadsRelatedCaseData;
	if (!readsOutOfScope(next)) return { admitted: true };
	return {
		admitted: false,
		reason:
			scope === "global"
				? GLOBAL_SCOPE_CASE_DATA_REASON
				: SELECTED_CASE_SCOPE_RELATED_DATA_REASON,
	};
}

/**
 * Resolve a per-kind precise predicate shape, falling back to a
 * structural `{ kind: K }`-compatible shape when `Extract<Predicate,
 * { kind: K }>` resolves to `never`. The fallback handles the six
 * comparison kinds, where the schema collapses all into one arm
 * via `z.enum(COMPARISON_KINDS)` — `Extract<Predicate, { kind:
 * "eq" }>` is structurally `never` because `"eq"` is narrower
 * than the schema's declared `kind: ComparisonKind`. The fallback
 * mirrors the `ComparisonPredicate<K>` shape in
 * `lib/domain/predicate/builders.ts`.
 */
type PredicateOfKind<K extends Predicate["kind"]> = [
	Extract<Predicate, { kind: K }>,
] extends [never]
	? Extract<Predicate, { kind: ComparisonKind }> & { kind: K }
	: Extract<Predicate, { kind: K }>;

/**
 * One registry entry. Generic over `K` (the Predicate kind discriminator)
 * so each entry's `component` and `defaultValue` carry the precise
 * per-arm shape — `ComparisonCard`'s component receives the
 * comparison-arm subtype, `LogicalGroupCard`'s receives the and/or/not
 * arm, etc. The signed exhaustiveness lives at the
 * `predicateCardSchemas` declaration (a `Record<Predicate["kind"],
 * ...>`) — adding a kind without an entry breaks the build.
 *
 * `icon` carries imported `IconifyIcon` data (the object literal
 * shape exported by `@iconify-icons/tabler/*` and the project's
 * `tablerExtras` file). Mirrors the `FieldKindMetadata` shape in
 * `lib/domain/kinds.ts`.
 */
export interface PredicateCardSchema<K extends Predicate["kind"]> {
	readonly kind: K;
	/** Product-level vocabulary boundary. `roundTripOnly` predicates remain
	 * fully editable when imported, but no add/change surface may create one. */
	readonly authoring: "authorable" | "roundTripOnly";
	readonly label: string;
	readonly icon: IconifyIcon;
	readonly description: string;
	readonly component: ComponentType<{
		readonly value: PredicateOfKind<K>;
		readonly onChange: (next: Predicate) => void;
		readonly path: readonly (string | number)[];
		/** The slot's type constraint — threaded by the dispatch shell
		 *  for signature uniformity with the expression registry. A
		 *  Predicate has no result type, so predicate cards compute
		 *  their own child constraints from `useResolvedType` and ignore
		 *  the incoming one (always `ANY_CONSTRAINT`). */
		readonly constraint?: SlotConstraint;
	}>;
	readonly defaultValue: (ctx: PredicateEditContext) => PredicateOfKind<K>;
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
	if (!caseDataInScope(ctx)) return true;
	return hasAnyProperty(ctx);
}

function hasAnyProperty(ctx: PredicateEditContext): boolean {
	const ct = getCurrentCaseType(ctx);
	return ct !== undefined && ct.properties.length > 0;
}

function hasMembershipProperty(ctx: PredicateEditContext): boolean {
	// Session values are text-shaped, and text is a legal `in` subject —
	// a global slot always has one.
	if (!caseDataInScope(ctx)) return true;
	const constraint = inSubjectConstraint();
	return hasPropertyOfType(ctx, (property) =>
		acceptsType(constraint, effectiveDataType(property)),
	);
}

function hasPropertyOfType(
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

/** Actionable copy for condition choices that cannot yet produce a valid
 * predicate in the current scope. Menus share this wording so authors never
 * get a generic search-field instruction for an unrelated case relationship
 * or data-type requirement. */
export function predicateUnavailableReason(
	kind: Predicate["kind"],
	ctx: PredicateEditContext,
): string {
	if (kind === "match-none" && !neverMatchInScope(ctx)) {
		return NEVER_MATCH_UNAVAILABLE_REASON;
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
			return "Add number, date, or time case information first";
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
// Keyed by `Predicate["kind"]` so the discriminator union forces an
// entry for every kind. Six comparison kinds share `ComparisonCard`,
// `match-all` / `match-none` share `SentinelCards`, `and` / `or` /
// `not` share `LogicalGroupCard`, `exists` / `missing` share
// `ExistsCard`. Each kind's entry retains its own label / icon /
// description / factory so the kind-picker UI reads each as a
// distinct option even when the component is shared.

/**
 * Per-kind editor schema keyed by `Predicate["kind"]`. The
 * mapped-type shape forces TypeScript to fail compilation if a new
 * kind lands in the Predicate union without a parallel entry — the
 * registry's exhaustivity is the structural guarantee that the
 * editor never silently bypasses a kind.
 */
export const predicateCardSchemas: {
	readonly [K in Predicate["kind"]]: PredicateCardSchema<K>;
} = {
	// ── Comparison (6 kinds, one card) ──────────────────────────────
	eq: {
		kind: "eq",
		authoring: "authorable",
		label: "Is",
		icon: tablerEqual,
		description: "The property is exactly a value",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("eq", ctx),
		applicable: hasComparableSubject,
	},
	neq: {
		kind: "neq",
		authoring: "authorable",
		label: "Isn’t",
		icon: tablerEqualNot,
		description: "The property is anything except a value",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("neq", ctx),
		applicable: hasComparableSubject,
	},
	lt: {
		kind: "lt",
		authoring: "authorable",
		label: "Is less than",
		icon: tablerMathLower,
		description: "Below a number or date",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("lt", ctx),
		applicable: (ctx) => hasPropertyOfType(ctx, isOrdered),
	},
	lte: {
		kind: "lte",
		authoring: "authorable",
		label: "Is at most",
		icon: tablerMathLower,
		description: "A value or below",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("lte", ctx),
		applicable: (ctx) => hasPropertyOfType(ctx, isOrdered),
	},
	gt: {
		kind: "gt",
		authoring: "authorable",
		label: "Is more than",
		icon: tablerMathGreater,
		description: "Above a number or date",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("gt", ctx),
		applicable: (ctx) => hasPropertyOfType(ctx, isOrdered),
	},
	gte: {
		kind: "gte",
		authoring: "authorable",
		label: "Is at least",
		icon: tablerMathGreater,
		description: "A value or above",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("gte", ctx),
		applicable: (ctx) => hasPropertyOfType(ctx, isOrdered),
	},

	// ── Membership / range ──────────────────────────────────────────
	in: {
		kind: "in",
		authoring: "authorable",
		label: "Is any of",
		icon: tablerListCheck,
		description: "Matches one value from a list",
		component: InCard,
		defaultValue: inDefault,
		applicable: hasMembershipProperty,
	},
	between: {
		kind: "between",
		authoring: "authorable",
		label: "Is between",
		icon: tablerArrowsHorizontal,
		description: "Falls inside a range with either end left open if needed",
		component: BetweenCard,
		defaultValue: betweenDefault,
		applicable: (ctx) => hasPropertyOfType(ctx, isOrdered),
	},

	// ── Multi-select containment ────────────────────────────────────
	"multi-select-contains": {
		kind: "multi-select-contains",
		authoring: "authorable",
		label: "Includes options",
		icon: tablerCheckbox,
		description: "Includes one or every option you choose",
		component: MultiSelectContainsCard,
		defaultValue: multiSelectContainsDefault,
		applicable: (ctx) =>
			hasPropertyOfType(ctx, (p) => p.data_type === "multi_select"),
	},

	// ── Text match (4 modes, one card) ──────────────────────────────
	match: {
		kind: "match",
		authoring: "authorable",
		label: "Matches text",
		icon: tablerTextRecognition,
		description:
			"Match by similar spelling, the beginning of text, sound, or a flexible date",
		component: MatchCard,
		defaultValue: matchDefault,
		applicable: (ctx) =>
			hasPropertyOfType(
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
		authoring: "authorable",
		label: "Is near",
		icon: tablerMapPin,
		description: "Within a distance of a place",
		component: WithinDistanceCard,
		defaultValue: withinDistanceDefault,
		applicable: (ctx) =>
			hasPropertyOfType(ctx, (p) => p.data_type === "geopoint"),
	},

	// ── Null / blank ─────────────────────────────────────────────────
	"is-null": {
		kind: "is-null",
		authoring: "roundTripOnly",
		label: "Was never recorded",
		icon: tablerCircleDashed,
		description: "The value was never recorded; an empty value still counts",
		component: IsNullCard,
		defaultValue: isNullDefault,
		applicable: hasAnyProperty,
	},
	"is-blank": {
		kind: "is-blank",
		authoring: "authorable",
		label: "Is blank",
		icon: tablerCircleOff,
		description: "Empty or missing entirely",
		component: IsBlankCard,
		defaultValue: isBlankDefault,
		applicable: hasComparableSubject,
	},

	// ── Sentinels ────────────────────────────────────────────────────
	"match-all": {
		kind: "match-all",
		authoring: "authorable",
		label: "Always match",
		icon: tablerAsterisk,
		description: "Let everything pass this condition",
		component: MatchAllCard,
		defaultValue: () => buildMatchAll(),
		applicable: () => true,
	},
	"match-none": {
		kind: "match-none",
		authoring: "authorable",
		label: "Never match",
		icon: tablerSlash,
		description: "Let nothing pass this condition",
		component: MatchNoneCard,
		defaultValue: () => buildMatchNone(),
		/* Meaningful wherever "nothing matches" is a real answer — an
		 * empty case list, a Search action deliberately withheld — and
		 * withheld only where the commit gate refuses it. An ALREADY
		 * SAVED `match-none` still renders and re-emits: `applicable`
		 * governs the add/replace menus, never round-tripping. */
		applicable: neverMatchInScope,
	},

	// ── Logical groups (and / or / not, one card) ───────────────────
	and: {
		kind: "and",
		authoring: "authorable",
		label: "All conditions match",
		icon: tablerLogicAnd,
		description: "Group conditions so every condition must match",
		component: LogicalGroupCard,
		defaultValue: andDefault,
		applicable: hasConditionSeed,
	},
	or: {
		kind: "or",
		authoring: "authorable",
		label: "Any condition matches",
		icon: tablerLogicOr,
		description: "Group conditions so at least one condition must match",
		component: LogicalGroupCard,
		defaultValue: orDefault,
		applicable: hasConditionSeed,
	},
	not: {
		kind: "not",
		authoring: "authorable",
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
		authoring: "authorable",
		label: "After a search answer",
		icon: tablerFilter,
		description: "Apply the condition only after a search field has an answer",
		component: WhenInputPresentCard,
		defaultValue: whenInputPresentDefault,
		applicable: (ctx) => ctx.knownInputs.length > 0 && hasConditionSeed(ctx),
	},

	// ── Relational quantifiers ──────────────────────────────────────
	exists: {
		kind: "exists",
		authoring: "authorable",
		label: "Has a related case",
		icon: tablerLink,
		description: "Require at least one connected case to match",
		component: ExistsCard,
		defaultValue: existsDefault,
		applicable: (ctx) => relatedCaseDataInScope(ctx) && hasRelatedCaseType(ctx),
	},
	missing: {
		kind: "missing",
		authoring: "authorable",
		label: "Has no related case",
		icon: tablerUnlink,
		description: "Require that no connected case matches",
		component: ExistsCard,
		defaultValue: missingDefault,
		applicable: (ctx) => relatedCaseDataInScope(ctx) && hasRelatedCaseType(ctx),
	},
};

/**
 * Convenience array — every schema in declaration order, used by the
 * kind-picker UI to render the menu.
 */
export const predicateCardSchemaList: readonly PredicateCardSchema<
	Predicate["kind"]
>[] = Object.values(predicateCardSchemas) as readonly PredicateCardSchema<
	Predicate["kind"]
>[];

/** Product-level authoring boundary shared by every predicate add/change
 * menu. Callers keep the current round-trip-only kind visible as a recovery
 * source, but exclude it from every new-target list. */
export function isAuthorablePredicateKind(kind: Predicate["kind"]): boolean {
	return predicateCardSchemas[kind].authoring === "authorable";
}
