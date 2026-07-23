// components/builder/shared/expressionEditorSchemas.ts
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
import tablerLink from "@iconify-icons/tabler/link";
import tablerListSearch from "@iconify-icons/tabler/list-search";
import tablerSwitch from "@iconify-icons/tabler/switch";
import tablerUser from "@iconify-icons/tabler/user";
import tablerUserOff from "@iconify-icons/tabler/user-off";
import tablerVariable from "@iconify-icons/tabler/variable";
import { type ComponentType, createElement } from "react";
import type {
	CaseProperty,
	CaseType,
	LookupColumnId,
	LookupTableId,
} from "@/lib/domain";
import {
	isDateTyped,
	NUMERIC_DATA_TYPES,
	TEXT_SHAPED_DATA_TYPES,
} from "@/lib/domain";
import type {
	ResolvedType,
	SearchInputDecl,
	SlotConstraint,
	ValueExpression,
} from "@/lib/domain/predicate";
import { and } from "@/lib/domain/predicate";
import { ArithCard, arithDefault } from "./cards/expression/ArithCard";
import { CoalesceCard, coalesceDefault } from "./cards/expression/CoalesceCard";
import { ConcatCard, concatDefault } from "./cards/expression/ConcatCard";
import {
	CountCard,
	countDefault,
	hasCountableRelation,
} from "./cards/expression/CountCard";
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
import { IdOfCard, idOfDefault } from "./cards/expression/IdOfCard";
import { IfCard, ifDefault } from "./cards/expression/IfCard";
import {
	ActingUserCard,
	actingUserDefault,
	UnownedCard,
	unownedDefault,
} from "./cards/expression/OwnerValueCards";
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
 * `applicable(ctx, expectedType?)` reports whether the kind can
 * structurally produce the expected type (e.g. `today` declines an
 * `int` slot). The kind picker NO LONGER consumes it: the
 * valid-by-construction `ExpressionPicker` gates on the slot's
 * `SlotConstraint` via `admitsValueExpressionKind` (a kind whose
 * result class can't satisfy the constraint is disabled with a reason,
 * never dimmed). `applicable` is retained as the result-class oracle
 * `valueExpressionKindResultClass` cites and the registry tests pin —
 * the kind-result mapping in one tested place — so it must stay in
 * lockstep with the constraint admission.
 */
export interface ExpressionCardSchema<K extends ValueExpression["kind"]> {
	readonly kind: K;
	/** Whether people can create this kind in Nova. `roundTripOnly`
	 *  kinds never appear as a replacement target; most remain editable
	 *  when imported, while dormant carriers render an inert compatibility
	 *  fallback until their owning slice opens. This is intentionally separate from
	 *  `applicable`: applicability answers whether a result type fits a
	 *  slot, while authorability is a product-level vocabulary boundary. */
	readonly authoring: "authorable" | "roundTripOnly";
	readonly label: string;
	readonly icon: IconifyIcon;
	readonly description: string;
	readonly component: ComponentType<{
		readonly value: Extract<ValueExpression, { kind: K }>;
		readonly onChange: (next: ValueExpression) => void;
		readonly path: readonly (string | number)[];
		/** The slot's type constraint — the card computes its inner
		 *  slots' constraints from it ("depends" kinds propagate it; the
		 *  hard-typed kinds fix their operands). Defaults to
		 *  `ANY_CONSTRAINT` when the dispatch shell omits it. */
		readonly constraint?: SlotConstraint;
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
	return NUMERIC_DATA_TYPES.has(expectedType);
}

/**
 * Date-only kinds (`today`) — applicable strictly when the slot
 * accepts `date` (or has no expected type, or accepts the null-
 * compatibility `_any` sentinel). `today` always resolves to `date`,
 * so a `datetime` slot rejects it at the picker without further
 * gating.
 */
function applicableForDate(
	_ctx: ExpressionEditContext,
	expectedType?: ResolvedType,
): boolean {
	if (expectedType === undefined) return true;
	if (expectedType === "_any") return true;
	return expectedType === "date";
}

/**
 * Datetime-only kinds (`now`) — symmetric with `applicableForDate`.
 * `now` always resolves to `datetime`.
 */
function applicableForDatetime(
	_ctx: ExpressionEditContext,
	expectedType?: ResolvedType,
): boolean {
	if (expectedType === undefined) return true;
	if (expectedType === "_any") return true;
	return expectedType === "datetime";
}

/**
 * Date-or-datetime kinds — applicable for either temporal slot type.
 *
 * Used by the kind whose result type follows its operand:
 *
 *   - `date-add` — result type follows `date.kind`, so
 *     `dateAdd(today(), "days", literal(7))` resolves to `date`
 *     while `dateAdd(now(), "hours", literal(1))` resolves to
 *     `datetime` (per `checkExpression`'s `case "date-add":`). The
 *     kind picker surfaces it for either temporal slot — the
 *     operand picker drives which side the type checker validates
 *     against.
 */
function applicableForDateOrDatetime(
	_ctx: ExpressionEditContext,
	expectedType?: ResolvedType,
): boolean {
	if (expectedType === undefined) return true;
	if (expectedType === "_any") return true;
	return expectedType === "date" || expectedType === "datetime";
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
	return TEXT_SHAPED_DATA_TYPES.has(expectedType);
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

const DORMANT_LOOKUP_TABLE_ID =
	"00000000-0000-7000-8000-000000000000" as LookupTableId;
const DORMANT_LOOKUP_COLUMN_ID =
	"00000000-0000-7000-8000-000000000001" as LookupColumnId;

function dormantTableLookupDefault(): Extract<
	ValueExpression,
	{ kind: "table-lookup" }
> {
	return {
		kind: "table-lookup",
		tableId: DORMANT_LOOKUP_TABLE_ID,
		resultColumnId: DORMANT_LOOKUP_COLUMN_ID,
		where: and(),
	};
}

function DormantTableLookupCard() {
	return createElement(
		"div",
		{
			className:
				"rounded-lg border border-nova-border px-3 py-2 text-sm text-nova-text-muted",
			role: "note",
		},
		"This saved value cannot be edited yet.",
	);
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
		authoring: "authorable",
		label: "Value",
		icon: tablerVariable,
		description: "Enter a value or use information already in the app",
		component: TermCard,
		defaultValue: termDefault,
		applicable: applicableAlways,
	},
	"id-of": {
		kind: "id-of",
		authoring: "roundTripOnly",
		label: "Created case ID",
		icon: tablerLink,
		description: "Use the case created by an earlier operation",
		component: IdOfCard,
		defaultValue: idOfDefault,
		applicable: applicableAlways,
	},
	"acting-user": {
		kind: "acting-user",
		authoring: "roundTripOnly",
		label: "Person using the app",
		icon: tablerUser,
		description: "Assign the case to the person using the app",
		component: ActingUserCard,
		defaultValue: actingUserDefault,
		applicable: applicableForText,
	},
	unowned: {
		kind: "unowned",
		authoring: "roundTripOnly",
		label: "No owner",
		icon: tablerUserOff,
		description: "Leave the case without an owner",
		component: UnownedCard,
		defaultValue: unownedDefault,
		applicable: applicableForText,
	},

	// ── Date / time constants ────────────────────────────────────────
	today: {
		kind: "today",
		authoring: "authorable",
		label: "Today's date",
		icon: tablerCalendarEvent,
		description: "Use the date when the app runs",
		component: TodayCard,
		defaultValue: todayDefault,
		applicable: applicableForDate,
	},
	now: {
		kind: "now",
		authoring: "authorable",
		label: "Current date and time",
		icon: tablerClock,
		description: "Use the date and time when the app runs",
		component: NowCard,
		defaultValue: nowDefault,
		applicable: applicableForDatetime,
	},

	// ── Date arithmetic / coercion ───────────────────────────────────
	"date-add": {
		kind: "date-add",
		authoring: "authorable",
		label: "Adjust a date",
		icon: tablerCalendarPlus,
		description: "Move a date or time forward or backward",
		component: DateAddCard,
		defaultValue: dateAddDefault,
		// `date-add`'s result type follows the `date` operand —
		// `dateAdd(today(), ...)` resolves to `date`,
		// `dateAdd(now(), ...)` resolves to `datetime`. Applicable for
		// either temporal slot type; the operand picker drives which
		// side the type checker validates against.
		applicable: applicableForDateOrDatetime,
	},
	"date-coerce": {
		kind: "date-coerce",
		authoring: "authorable",
		label: "Read as a date",
		icon: tablerCalendarStats,
		description: "Treat a text value as a date",
		component: DateCoerceCard,
		defaultValue: dateCoerceDefault,
		// The twin replacement preserves the operand, but this arm's result is
		// still fixed: only a date-result slot may select it.
		applicable: applicableForDate,
	},
	"datetime-coerce": {
		kind: "datetime-coerce",
		authoring: "authorable",
		label: "Read as a date and time",
		icon: tablerCalendarStats,
		description: "Treat a text value as a date and time",
		component: DateCoerceCard,
		defaultValue: datetimeCoerceDefault,
		applicable: applicableForDatetime,
	},

	// ── Numeric ──────────────────────────────────────────────────────
	double: {
		kind: "double",
		authoring: "authorable",
		label: "Read as a number",
		icon: tablerHash,
		description: "Treat a value as a number",
		component: DoubleCard,
		defaultValue: doubleDefault,
		applicable: applicableForNumeric,
	},
	arith: {
		kind: "arith",
		authoring: "authorable",
		label: "Math",
		icon: tablerCalculator,
		description: "Add, subtract, multiply, or divide two values",
		component: ArithCard,
		defaultValue: arithDefault,
		applicable: applicableForNumeric,
	},

	// ── Text ─────────────────────────────────────────────────────────
	concat: {
		kind: "concat",
		authoring: "authorable",
		label: "Combine text",
		icon: tablerAbc,
		description: "Join several pieces of text into one",
		component: ConcatCard,
		defaultValue: concatDefault,
		applicable: applicableForText,
	},

	// ── Conditional / dispatch ───────────────────────────────────────
	coalesce: {
		kind: "coalesce",
		authoring: "authorable",
		label: "First available value",
		icon: tablerCopy,
		description: "The first value in the list that isn't blank",
		component: CoalesceCard,
		defaultValue: coalesceDefault,
		applicable: applicableAlways,
	},
	if: {
		kind: "if",
		authoring: "authorable",
		label: "Choose by condition",
		icon: tablerGitMerge,
		description: "One value when a condition holds, another when it doesn't",
		component: IfCard,
		defaultValue: ifDefault,
		applicable: applicableAlways,
	},
	switch: {
		kind: "switch",
		authoring: "authorable",
		label: "Choose by matching",
		icon: tablerSwitch,
		description: "Use a different value for each match",
		component: SwitchCard,
		defaultValue: switchDefault,
		applicable: applicableAlways,
	},

	// ── Aggregation ──────────────────────────────────────────────────
	count: {
		kind: "count",
		authoring: "authorable",
		label: "Count related cases",
		icon: tablerListSearch,
		description: "How many connected cases match a condition",
		component: CountCard,
		defaultValue: countDefault,
		applicable: (ctx, expectedType) => {
			// `count` always returns `int`; gate on numeric expected types
			// when set. The case-type schema must declare at least one
			// related case type for the usual count workflow. `count(self)`
			// is also a valid explicit 1 (or filtered 0/1), and the relation
			// editor keeps that option available.
			if (expectedType !== undefined && expectedType !== "_any") {
				if (!NUMERIC_DATA_TYPES.has(expectedType)) return false;
			}
			return hasCountableRelation(ctx);
		},
	},

	// ── Dormant compatibility carrier ────────────────────────────────
	"table-lookup": {
		kind: "table-lookup",
		authoring: "roundTripOnly",
		label: "Unavailable saved value",
		icon: tablerListSearch,
		description: "A saved value this editor cannot open yet",
		component: DormantTableLookupCard,
		defaultValue: dormantTableLookupDefault,
		applicable: () => false,
	},

	// ── Sequence (round-trip-only) ───────────────────────────────────
	"unwrap-list": {
		kind: "unwrap-list",
		authoring: "roundTripOnly",
		label: "Saved selections",
		icon: tablerForklift,
		description: "Read several saved selections from one value",
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
		authoring: "authorable",
		label: "Write a date as text",
		icon: tablerArrowsShuffle,
		description: "Write a date as text in a format you choose",
		component: FormatDateCard,
		defaultValue: formatDateDefault,
		applicable: (ctx, expectedType) => {
			if (!hasPropertyOfType(ctx, isDateTyped)) {
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

/** Product-level authoring boundary for kind-replacement menus. Keep
 *  the current `roundTripOnly` kind visible as a recovery source, but
 *  call sites must exclude it from all new-target lists. */
export function isAuthorableExpressionKind(
	kind: ValueExpression["kind"],
): boolean {
	return expressionCardSchemas[kind].authoring === "authorable";
}
