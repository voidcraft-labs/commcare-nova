// components/builder/case-list-config/editorSchemas.ts
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
import {
	matchAll as buildMatchAll,
	matchNone as buildMatchNone,
	type ComparisonKind,
	type Predicate,
	type SearchInputDecl,
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

const TEXT_SHAPED = new Set<string>(["text", "single_select", "multi_select"]);

const ORDERED = new Set<string>(["int", "decimal", "date", "datetime", "time"]);

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
		label: "Equals",
		icon: tablerEqual,
		description: "Property equals a value",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("eq", ctx),
		applicable: hasAnyProperty,
	},
	neq: {
		kind: "neq",
		label: "Not equals",
		icon: tablerEqualNot,
		description: "Property does not equal a value",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("neq", ctx),
		applicable: hasAnyProperty,
	},
	lt: {
		kind: "lt",
		label: "Less than",
		icon: tablerMathLower,
		description: "Property is less than a value",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("lt", ctx),
		applicable: (ctx) =>
			hasPropertyOfType(ctx, (p) => ORDERED.has(p.data_type ?? "text")),
	},
	lte: {
		kind: "lte",
		label: "Less than or equal",
		icon: tablerMathLower,
		description: "Property is at most a value",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("lte", ctx),
		applicable: (ctx) =>
			hasPropertyOfType(ctx, (p) => ORDERED.has(p.data_type ?? "text")),
	},
	gt: {
		kind: "gt",
		label: "Greater than",
		icon: tablerMathGreater,
		description: "Property is greater than a value",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("gt", ctx),
		applicable: (ctx) =>
			hasPropertyOfType(ctx, (p) => ORDERED.has(p.data_type ?? "text")),
	},
	gte: {
		kind: "gte",
		label: "Greater than or equal",
		icon: tablerMathGreater,
		description: "Property is at least a value",
		component: ComparisonCard,
		defaultValue: (ctx) => comparisonDefault("gte", ctx),
		applicable: (ctx) =>
			hasPropertyOfType(ctx, (p) => ORDERED.has(p.data_type ?? "text")),
	},

	// ── Membership / range ──────────────────────────────────────────
	in: {
		kind: "in",
		label: "Is one of",
		icon: tablerListCheck,
		description: "Property matches any of a list of values",
		component: InCard,
		defaultValue: inDefault,
		applicable: hasAnyProperty,
	},
	between: {
		kind: "between",
		label: "Is between",
		icon: tablerArrowsHorizontal,
		description: "Property falls within a range",
		component: BetweenCard,
		defaultValue: betweenDefault,
		applicable: (ctx) =>
			hasPropertyOfType(ctx, (p) => ORDERED.has(p.data_type ?? "text")),
	},

	// ── Multi-select containment ────────────────────────────────────
	"multi-select-contains": {
		kind: "multi-select-contains",
		label: "Contains tokens",
		icon: tablerCheckbox,
		description: "Multi-select property contains any/all of these tokens",
		component: MultiSelectContainsCard,
		defaultValue: multiSelectContainsDefault,
		applicable: (ctx) =>
			hasPropertyOfType(ctx, (p) => p.data_type === "multi_select"),
	},

	// ── Text match (4 modes, one card) ──────────────────────────────
	match: {
		kind: "match",
		label: "Text match",
		icon: tablerTextRecognition,
		description: "Approximate match (fuzzy / phonetic / starts-with)",
		component: MatchCard,
		defaultValue: matchDefault,
		applicable: (ctx) =>
			hasPropertyOfType(
				ctx,
				(p) =>
					TEXT_SHAPED.has(p.data_type ?? "text") ||
					p.data_type === "date" ||
					p.data_type === "datetime",
			),
	},

	// ── Geo ─────────────────────────────────────────────────────────
	"within-distance": {
		kind: "within-distance",
		label: "Within distance",
		icon: tablerMapPin,
		description: "Geopoint within a radius of a center",
		component: WithinDistanceCard,
		defaultValue: withinDistanceDefault,
		applicable: (ctx) =>
			hasPropertyOfType(ctx, (p) => p.data_type === "geopoint"),
	},

	// ── Null / blank ─────────────────────────────────────────────────
	"is-null": {
		kind: "is-null",
		label: "Is empty (strict)",
		icon: tablerCircleDashed,
		description: "Property is absent (strict — does not match empty string)",
		component: IsNullCard,
		defaultValue: isNullDefault,
		applicable: hasAnyProperty,
	},
	"is-blank": {
		kind: "is-blank",
		label: "Is empty",
		icon: tablerCircleOff,
		description: "Property is absent or empty",
		component: IsBlankCard,
		defaultValue: isBlankDefault,
		applicable: hasAnyProperty,
	},

	// ── Sentinels ────────────────────────────────────────────────────
	"match-all": {
		kind: "match-all",
		label: "Match all cases",
		icon: tablerAsterisk,
		description: "Always true — matches every case",
		component: MatchAllCard,
		defaultValue: () => buildMatchAll(),
		applicable: () => true,
	},
	"match-none": {
		kind: "match-none",
		label: "Match no cases",
		icon: tablerSlash,
		description: "Always false — matches no case",
		component: MatchNoneCard,
		defaultValue: () => buildMatchNone(),
		applicable: () => true,
	},

	// ── Logical groups (and / or / not, one card) ───────────────────
	and: {
		kind: "and",
		label: "All of (AND)",
		icon: tablerLogicAnd,
		description: "Every nested clause must match",
		component: LogicalGroupCard,
		defaultValue: andDefault,
		applicable: () => true,
	},
	or: {
		kind: "or",
		label: "Any of (OR)",
		icon: tablerLogicOr,
		description: "At least one nested clause must match",
		component: LogicalGroupCard,
		defaultValue: orDefault,
		applicable: () => true,
	},
	not: {
		kind: "not",
		label: "Not",
		icon: tablerLogicNot,
		description: "Inverts the inner clause",
		component: LogicalGroupCard,
		defaultValue: notDefault,
		applicable: () => true,
	},

	// ── Conditional ──────────────────────────────────────────────────
	"when-input-present": {
		kind: "when-input-present",
		label: "When input is set",
		icon: tablerFilter,
		description: "Only apply the inner clause when a search input has a value",
		component: WhenInputPresentCard,
		defaultValue: whenInputPresentDefault,
		applicable: (ctx) => ctx.knownInputs.length > 0,
	},

	// ── Relational quantifiers ──────────────────────────────────────
	exists: {
		kind: "exists",
		label: "Has a related case",
		icon: tablerLink,
		description: "At least one related case satisfies a condition",
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
