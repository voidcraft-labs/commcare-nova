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
import type { CaseProperty, CaseType } from "@/lib/domain";
import { isOrdered, isTextShaped } from "@/lib/domain";
import {
	matchAll as buildMatchAll,
	matchNone as buildMatchNone,
	type ComparisonKind,
	type Predicate,
	type SearchInputDecl,
	type SlotConstraint,
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

/**
 * Inputs available at the time `defaultValue` and `applicable` run.
 * The factories pick a sensible default property / case type when
 * possible; the applicability predicate narrows the kind picker so
 * authors see only the kinds whose semantics fit the current scope
 * (e.g. `multi-select-contains` is only applicable when the case
 * type has a multi_select-typed property).
 */
export interface PredicateEditContext {
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly SearchInputDecl[];
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

function hasAnyProperty(ctx: PredicateEditContext): boolean {
	const ct = getCurrentCaseType(ctx);
	return ct !== undefined && ct.properties.length > 0;
}

function hasPropertyOfType(
	ctx: PredicateEditContext,
	predicate: (p: CaseProperty) => boolean,
): boolean {
	const ct = getCurrentCaseType(ctx);
	if (ct === undefined) return false;
	return ct.properties.some(predicate);
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
		label: "Is",
		icon: tablerEqual,
		description: "The property is exactly a value",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("eq", ctx),
		applicable: hasAnyProperty,
	},
	neq: {
		kind: "neq",
		label: "Is not",
		icon: tablerEqualNot,
		description: "The property is anything except a value",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("neq", ctx),
		applicable: hasAnyProperty,
	},
	lt: {
		kind: "lt",
		label: "Is less than",
		icon: tablerMathLower,
		description: "Below a value — ordered by number or date",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("lt", ctx),
		applicable: (ctx) => hasPropertyOfType(ctx, isOrdered),
	},
	lte: {
		kind: "lte",
		label: "Is at most",
		icon: tablerMathLower,
		description: "A value or below",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("lte", ctx),
		applicable: (ctx) => hasPropertyOfType(ctx, isOrdered),
	},
	gt: {
		kind: "gt",
		label: "Is more than",
		icon: tablerMathGreater,
		description: "Above a value — ordered by number or date",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("gt", ctx),
		applicable: (ctx) => hasPropertyOfType(ctx, isOrdered),
	},
	gte: {
		kind: "gte",
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
		label: "Is any of",
		icon: tablerListCheck,
		description: "Matches one value from a list",
		component: InCard,
		defaultValue: inDefault,
		applicable: hasAnyProperty,
	},
	between: {
		kind: "between",
		label: "Is between",
		icon: tablerArrowsHorizontal,
		description: "Falls inside a range — either end optional",
		component: BetweenCard,
		defaultValue: betweenDefault,
		applicable: (ctx) => hasPropertyOfType(ctx, isOrdered),
	},

	// ── Multi-select containment ────────────────────────────────────
	"multi-select-contains": {
		kind: "multi-select-contains",
		label: "Includes options",
		icon: tablerCheckbox,
		description: "A multi-choice list includes any (or all) of the options",
		component: MultiSelectContainsCard,
		defaultValue: multiSelectContainsDefault,
		applicable: (ctx) =>
			hasPropertyOfType(ctx, (p) => p.data_type === "multi_select"),
	},

	// ── Text match (4 modes, one card) ──────────────────────────────
	match: {
		kind: "match",
		label: "Matches text",
		icon: tablerTextRecognition,
		description: "Fuzzy, starts-with, or sounds-like matching",
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
		label: "Was never recorded",
		icon: tablerCircleDashed,
		description: "Strictly absent — an empty value still counts as recorded",
		component: IsNullCard,
		defaultValue: isNullDefault,
		applicable: hasAnyProperty,
	},
	"is-blank": {
		kind: "is-blank",
		label: "Is blank",
		icon: tablerCircleOff,
		description: "Empty, or missing entirely",
		component: IsBlankCard,
		defaultValue: isBlankDefault,
		applicable: hasAnyProperty,
	},

	// ── Sentinels ────────────────────────────────────────────────────
	"match-all": {
		kind: "match-all",
		label: "Always true",
		icon: tablerAsterisk,
		description: "Always passes — a placeholder to build from",
		component: MatchAllCard,
		defaultValue: () => buildMatchAll(),
		applicable: () => true,
	},
	"match-none": {
		kind: "match-none",
		label: "Always false",
		icon: tablerSlash,
		description: "Never passes — an explicit off switch",
		component: MatchNoneCard,
		defaultValue: () => buildMatchNone(),
		applicable: () => true,
	},

	// ── Logical groups (and / or / not, one card) ───────────────────
	and: {
		kind: "and",
		label: "All of these",
		icon: tablerLogicAnd,
		description: "A group — every condition inside must match",
		component: LogicalGroupCard,
		defaultValue: andDefault,
		applicable: () => true,
	},
	or: {
		kind: "or",
		label: "Any of these",
		icon: tablerLogicOr,
		description: "A group — at least one condition inside must match",
		component: LogicalGroupCard,
		defaultValue: orDefault,
		applicable: () => true,
	},
	not: {
		kind: "not",
		label: "Not",
		icon: tablerLogicNot,
		description: "Flips the condition inside — matches when it doesn't",
		component: LogicalGroupCard,
		defaultValue: notDefault,
		applicable: () => true,
	},

	// ── Conditional ──────────────────────────────────────────────────
	"when-input-present": {
		kind: "when-input-present",
		label: "When a search field is filled",
		icon: tablerFilter,
		description: "Applies the condition inside only while a field has a value",
		component: WhenInputPresentCard,
		defaultValue: whenInputPresentDefault,
		applicable: (ctx) => ctx.knownInputs.length > 0,
	},

	// ── Relational quantifiers ──────────────────────────────────────
	exists: {
		kind: "exists",
		label: "Has a related case",
		icon: tablerLink,
		description: "At least one connected case satisfies a condition",
		component: ExistsCard,
		defaultValue: () => existsDefault(),
		applicable: () => true,
	},
	missing: {
		kind: "missing",
		label: "No related case",
		icon: tablerUnlink,
		description: "No related case satisfies a condition",
		component: ExistsCard,
		defaultValue: () => missingDefault(),
		applicable: () => true,
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
