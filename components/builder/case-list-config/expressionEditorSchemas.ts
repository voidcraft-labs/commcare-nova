// components/builder/case-list-config/expressionEditorSchemas.ts
//
// Declarative registry mapping every ValueExpression kind to its
// card component, label, icon, default-value factory, and
// applicability predicate. Mirrors `editorSchemas.ts` (the
// Predicate-side registry) — both registries follow the same
// per-kind shape so a single mapped-type guard catches a kind
// added to the AST without a parallel UI entry.
//
// Why per-kind entries (instead of per-card-file entries): a card
// COMPONENT can serve multiple ValueExpression kinds — `TodayCard`
// + `NowCard` share `DateConstantCards.tsx`, `DateCoerceCard` +
// `DatetimeCoerceCard` share `DateCoerceCard.tsx` — but each kind
// needs its own picker entry (label, icon, default-value,
// applicability filter) so the kind-picker menu reads correctly.
// Sharing a component across kinds is purely a code-organization
// choice; the registry's per-kind keying preserves the
// exhaustivity check independent of file layout.

import type { IconifyIcon } from "@iconify/react/offline";
import tablerAbc from "@iconify-icons/tabler/abc";
import tablerArrowsShuffle from "@iconify-icons/tabler/arrows-shuffle";
import tablerCalculator from "@iconify-icons/tabler/calculator";
import tablerCalendarEvent from "@iconify-icons/tabler/calendar-event";
import tablerCalendarPlus from "@iconify-icons/tabler/calendar-plus";
import tablerCalendarStats from "@iconify-icons/tabler/calendar-stats";
import tablerClock from "@iconify-icons/tabler/clock";
import tablerCopy from "@iconify-icons/tabler/copy";
import tablerForklift from "@iconify-icons/tabler/forklift";
import tablerGitMerge from "@iconify-icons/tabler/git-merge";
import tablerHash from "@iconify-icons/tabler/hash";
import tablerListSearch from "@iconify-icons/tabler/list-search";
import tablerSwitch from "@iconify-icons/tabler/switch";
import tablerVariable from "@iconify-icons/tabler/variable";
import type { ComponentType } from "react";
import type { CaseProperty, CaseType } from "@/lib/domain";
import type {
	ResolvedType,
	SearchInputDecl,
	ValueExpression,
} from "@/lib/domain/predicate";
import { ArithCard, arithDefault } from "./cards/expression/ArithCard";
import { CoalesceCard, coalesceDefault } from "./cards/expression/CoalesceCard";
import { ConcatCard, concatDefault } from "./cards/expression/ConcatCard";
import { CountCard, countDefault } from "./cards/expression/CountCard";
import { DateAddCard, dateAddDefault } from "./cards/expression/DateAddCard";
import {
	DateCoerceCard,
	dateCoerceDefault,
	datetimeCoerceDefault,
} from "./cards/expression/DateCoerceCard";
import {
	NowCard,
	nowDefault,
	TodayCard,
	todayDefault,
} from "./cards/expression/DateConstantCards";
import { DoubleCard, doubleDefault } from "./cards/expression/DoubleCard";
import {
	FormatDateCard,
	formatDateDefault,
} from "./cards/expression/FormatDateCard";
import { IfCard, ifDefault } from "./cards/expression/IfCard";
import { SwitchCard, switchDefault } from "./cards/expression/SwitchCard";
import { TermCard, termDefault } from "./cards/expression/TermCard";
import {
	UnwrapListCard,
	unwrapListDefault,
} from "./cards/expression/UnwrapListCard";

/**
 * Inputs available at the time `defaultValue` and `applicable` run.
 * Reuses the same context shape as the Predicate-side editor — the
 * editor's React context provides values in this shape via
 * `usePredicateEditContext`. Reusing the type lets either editor
 * mount over the other's context without translation.
 */
export interface ExpressionEditContext {
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly SearchInputDecl[];
}

/**
 * One registry entry. Generic over `K` (the ValueExpression kind
 * discriminator) so each entry's `component` and `defaultValue`
 * carry the precise per-arm shape — `ArithCard`'s component
 * receives the `arith`-arm subtype, `IfCard`'s receives the
 * `if`-arm, etc. The signed exhaustiveness lives at the
 * `expressionCardSchemas` declaration (a `Record<ValueExpression["kind"],
 * ...>`) — adding a kind without an entry breaks the build.
 *
 * `applicable(ctx, expectedType?)` receives the optional caller-side
 * type expectation; entries can de-emphasize themselves when they're
 * structurally incapable of producing the expected type (e.g.
 * `today` declines an `int` slot). The shape returns a boolean to
 * keep the surface symmetric with the Predicate-side `applicable`
 * — the kind-picker UI can render an inapplicable entry with a
 * de-emphasized appearance rather than hide it outright (the
 * round-trip preservation contract demands every kind stay
 * representable across edits).
 */
export interface ExpressionCardSchema<K extends ValueExpression["kind"]> {
	readonly kind: K;
	readonly label: string;
	readonly icon: IconifyIcon;
	readonly description: string;
	readonly component: ComponentType<{
		readonly value: Extract<ValueExpression, { kind: K }>;
		readonly onChange: (next: ValueExpression) => void;
		readonly path: readonly (string | number)[];
	}>;
	readonly defaultValue: (
		ctx: ExpressionEditContext,
	) => Extract<ValueExpression, { kind: K }>;
	readonly applicable: (
		ctx: ExpressionEditContext,
		expectedType?: ResolvedType,
	) => boolean;
}

// ── Applicability helpers ───────────────────────────────────────────────
//
// Each kind's `applicable` flags whether the kind can structurally
// produce a value of the expected type. Returning `true` from
// `applicable` does NOT guarantee the type checker will accept every
// authoring of the kind — it only signals the kind is a reasonable
// authoring choice for the slot. The kind-picker UI uses the verdict
// to de-emphasize unlikely choices.
//
// Inputs / kinds that can produce ANY type (Term, If, Switch, Count,
// Coalesce, the kind we can't reason about without inspecting their
// inputs) always return `true` — the type checker's verdict on the
// authored expression decides validity. Per the advisor's guidance,
// strict expectedType filtering would hide kinds whose result type
// depends on inputs.

function getCurrentCaseType(ctx: ExpressionEditContext): CaseType | undefined {
	return ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
}

function hasPropertyOfType(
	ctx: ExpressionEditContext,
	predicate: (p: CaseProperty) => boolean,
): boolean {
	const ct = getCurrentCaseType(ctx);
	if (ct === undefined) return false;
	return ct.properties.some(predicate);
}

const TEXT_SHAPED = new Set<string>(["text", "single_select", "multi_select"]);

const NUMERIC = new Set<string>(["int", "decimal"]);

const DATE_OR_DATETIME = new Set<string>(["date", "datetime"]);

/**
 * Numeric-typed kind (`arith`, `double`) — applicable when the slot
 * either has no expected type OR the expected type is numeric. The
 * `_any` sentinel widens against everything; the helper short-
 * circuits there to mirror `typesCompatible`'s null-as-universal
 * rule.
 */
function applicableForNumeric(
	_ctx: ExpressionEditContext,
	expectedType?: ResolvedType,
): boolean {
	if (expectedType === undefined) return true;
	if (expectedType === "_any") return true;
	return NUMERIC.has(expectedType);
}

/**
 * Date-typed kind (`today`, `date-add`, `date-coerce`) — applicable
 * for date or `_any` expected types. Some date kinds produce
 * `datetime` instead of `date`; their entries override accordingly.
 */
function applicableForDate(
	_ctx: ExpressionEditContext,
	expectedType?: ResolvedType,
): boolean {
	if (expectedType === undefined) return true;
	if (expectedType === "_any") return true;
	return expectedType === "date";
}

function applicableForDatetime(
	_ctx: ExpressionEditContext,
	expectedType?: ResolvedType,
): boolean {
	if (expectedType === undefined) return true;
	if (expectedType === "_any") return true;
	return expectedType === "datetime";
}

/**
 * Text-typed kind (`concat`, `format-date`) — applicable for
 * text-shaped expected types. Authors who concatenate into a
 * non-text slot get a type-checker error inline; the applicability
 * gate keeps the kind picker focused on plausible authoring.
 */
function applicableForText(
	_ctx: ExpressionEditContext,
	expectedType?: ResolvedType,
): boolean {
	if (expectedType === undefined) return true;
	if (expectedType === "_any") return true;
	return TEXT_SHAPED.has(expectedType);
}

/**
 * Result-type-depends-on-inputs kinds — Term, If, Switch, Coalesce.
 * Always applicable; the type checker validates the full tree
 * against `expectedType` once authored. Hiding these would make
 * whole authoring patterns unreachable from a typed slot. `Count`
 * is NOT in this set — its result type is always `int`, so its
 * registry entry uses a custom predicate that gates on numeric
 * `expectedType` plus the case-type-availability check.
 */
function applicableAlways(): boolean {
	return true;
}

// ── Registry ────────────────────────────────────────────────────────────

/**
 * Per-kind editor schema keyed by `ValueExpression["kind"]`. The
 * mapped-type shape forces TypeScript to fail compilation if a new
 * kind lands in the ValueExpression union without a parallel entry
 * — the registry's exhaustivity is the structural guarantee that
 * the editor never silently bypasses a kind.
 */
export const expressionCardSchemas: {
	readonly [K in ValueExpression["kind"]]: ExpressionCardSchema<K>;
} = {
	// ── Term lift (universal value carrier) ─────────────────────────
	term: {
		kind: "term",
		label: "Value",
		icon: tablerVariable,
		description: "A property, search input, session field, or literal value",
		component: TermCard,
		defaultValue: termDefault,
		applicable: applicableAlways,
	},

	// ── Date / time constants ────────────────────────────────────────
	today: {
		kind: "today",
		label: "Today",
		icon: tablerCalendarEvent,
		description: "Project-timezone ISO date at evaluation time",
		component: TodayCard,
		defaultValue: todayDefault,
		applicable: applicableForDate,
	},
	now: {
		kind: "now",
		label: "Now",
		icon: tablerClock,
		description: "UTC ISO datetime at evaluation time",
		component: NowCard,
		defaultValue: nowDefault,
		applicable: applicableForDatetime,
	},

	// ── Date arithmetic / coercion ───────────────────────────────────
	"date-add": {
		kind: "date-add",
		label: "Date arithmetic",
		icon: tablerCalendarPlus,
		description: "Date plus an interval × quantity",
		component: DateAddCard,
		defaultValue: dateAddDefault,
		applicable: applicableForDate,
	},
	"date-coerce": {
		kind: "date-coerce",
		label: "Date coerce",
		icon: tablerCalendarStats,
		description: "Coerce a text value to a typed date",
		component: DateCoerceCard,
		defaultValue: dateCoerceDefault,
		applicable: applicableForDate,
	},
	"datetime-coerce": {
		kind: "datetime-coerce",
		label: "Datetime coerce",
		icon: tablerCalendarStats,
		description: "Coerce a text value to a typed datetime",
		component: DateCoerceCard,
		defaultValue: datetimeCoerceDefault,
		applicable: applicableForDatetime,
	},

	// ── Numeric ──────────────────────────────────────────────────────
	double: {
		kind: "double",
		label: "Numeric coerce",
		icon: tablerHash,
		description: "Forced numeric coercion via CSQL's double()",
		component: DoubleCard,
		defaultValue: doubleDefault,
		applicable: applicableForNumeric,
	},
	arith: {
		kind: "arith",
		label: "Arithmetic",
		icon: tablerCalculator,
		description: "Five-op binary numeric arithmetic (+, -, *, div, mod)",
		component: ArithCard,
		defaultValue: arithDefault,
		applicable: applicableForNumeric,
	},

	// ── Text ─────────────────────────────────────────────────────────
	concat: {
		kind: "concat",
		label: "Concatenate",
		icon: tablerAbc,
		description: "Variadic string concatenation",
		component: ConcatCard,
		defaultValue: concatDefault,
		applicable: applicableForText,
	},

	// ── Conditional / dispatch ───────────────────────────────────────
	coalesce: {
		kind: "coalesce",
		label: "Coalesce",
		icon: tablerCopy,
		description: "First non-empty value in a fallback chain",
		component: CoalesceCard,
		defaultValue: coalesceDefault,
		applicable: applicableAlways,
	},
	if: {
		kind: "if",
		label: "If / else",
		icon: tablerGitMerge,
		description: "Boolean conditional with eager evaluation of both branches",
		component: IfCard,
		defaultValue: ifDefault,
		applicable: applicableAlways,
	},
	switch: {
		kind: "switch",
		label: "Switch",
		icon: tablerSwitch,
		description: "Value-driven multi-case selector with fallback",
		component: SwitchCard,
		defaultValue: switchDefault,
		applicable: applicableAlways,
	},

	// ── Aggregation ──────────────────────────────────────────────────
	count: {
		kind: "count",
		label: "Count related",
		icon: tablerListSearch,
		description: "Count cases reachable along a relation walk",
		component: CountCard,
		defaultValue: countDefault,
		applicable: (ctx, expectedType) => {
			// `count` always returns `int`; gate on numeric expected types
			// when set. The case-type schema must declare at least one
			// related case type for the count to mean anything; bare
			// `count(self)` is rejected at type-check time and the editor
			// disallows it via the relation-path builder, but mounting
			// is still allowed for round-trip preservation.
			if (expectedType !== undefined && expectedType !== "_any") {
				if (!NUMERIC.has(expectedType)) return false;
			}
			return ctx.caseTypes.length > 0;
		},
	},

	// ── Sequence (round-trip-only) ───────────────────────────────────
	"unwrap-list": {
		kind: "unwrap-list",
		label: "Unwrap list",
		icon: tablerForklift,
		description:
			"Pull a JSON-encoded array from a property as a sequence (CSQL only)",
		component: UnwrapListCard,
		defaultValue: unwrapListDefault,
		// Sequence-typed; never compatible with a scalar expectedType. The
		// kind exists in the registry only for round-trip preservation —
		// authors don't pick `unwrap-list` from the menu (no scalar slot
		// consumes a sequence), but a saved AST that carries one MUST
		// round-trip through the editor.
		applicable: (_ctx, expectedType) => {
			if (expectedType === undefined) return false;
			return expectedType === "_sequence";
		},
	},

	// ── Date formatting ──────────────────────────────────────────────
	"format-date": {
		kind: "format-date",
		label: "Format date",
		icon: tablerArrowsShuffle,
		description: "Render a date or datetime as text",
		component: FormatDateCard,
		defaultValue: formatDateDefault,
		applicable: (ctx, expectedType) => {
			if (
				!hasPropertyOfType(ctx, (p) =>
					DATE_OR_DATETIME.has(p.data_type ?? "text"),
				)
			) {
				// No date / datetime property to format — the kind isn't
				// useful in this scope. Authors who pass a `today()` /
				// `now()` expression to format-date can still get there
				// through the operand editor; the picker entry stays off.
				return false;
			}
			return applicableForText(ctx, expectedType);
		},
	},
};

/**
 * Convenience array — every schema in declaration order, used by the
 * kind-picker UI to render the menu.
 */
export const expressionCardSchemaList: readonly ExpressionCardSchema<
	ValueExpression["kind"]
>[] = Object.values(expressionCardSchemas) as readonly ExpressionCardSchema<
	ValueExpression["kind"]
>[];
