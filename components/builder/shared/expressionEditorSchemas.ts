// components/builder/shared/expressionEditorSchemas.ts
//
// Declarative registry mapping every ValueExpression kind to its
// card component, label, icon, default-value factory. Mirrors `editorSchemas.ts` (the
// Predicate-side registry): both registries follow the same
// per-kind shape so a single mapped-type guard catches a kind
// added to the AST without a parallel UI entry.
//
// Why per-kind entries (instead of per-card-file entries): a card
// COMPONENT can serve multiple ValueExpression kinds: `TodayCard`
// + `NowCard` share `DateConstantCards.tsx`, `DateCoerceCard` +
// `DatetimeCoerceCard` share `DateCoerceCard.tsx`, but each kind
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
import tablerGitMerge from "@iconify-icons/tabler/git-merge";
import tablerHash from "@iconify-icons/tabler/hash";
import tablerLink from "@iconify-icons/tabler/link";
import tablerListSearch from "@iconify-icons/tabler/list-search";
import tablerSwitch from "@iconify-icons/tabler/switch";
import tablerUser from "@iconify-icons/tabler/user";
import tablerUserOff from "@iconify-icons/tabler/user-off";
import tablerVariable from "@iconify-icons/tabler/variable";
import type { ComponentType } from "react";
import type { CaseType, UserProperty, Uuid } from "@/lib/domain";
import type {
	SearchInputDecl,
	SlotConstraint,
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
import { IdOfCard, idOfDefault } from "./cards/expression/IdOfCard";
import { IfCard, ifDefault } from "./cards/expression/IfCard";
import {
	ActingUserCard,
	actingUserDefault,
	UnownedCard,
	unownedDefault,
} from "./cards/expression/OwnerValueCards";
import { SwitchCard, switchDefault } from "./cards/expression/SwitchCard";
import {
	TableLookupCard,
	tableLookupDefault,
} from "./cards/expression/TableLookupCard";
import { TermCard, termDefault } from "./cards/expression/TermCard";
import type { EvaluationTarget } from "./editorSchemas";
import type { EditorFormFieldDecl } from "./formFieldPresentation";
import type {
	EditorLookupTableDecl,
	EditorLookupTableScope,
} from "./lookupTablePresentation";

/**
 * Inputs available at the time `defaultValue` runs.
 * Reuses the same context shape as the Predicate-side editor, the
 * editor's React context provides values in this shape via
 * `usePredicateEditContext`. Reusing the type lets either editor
 * mount over the other's context without translation.
 */
export interface ExpressionEditContext {
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly SearchInputDecl[];
	/** Custom worker information available to identity-backed user terms:
	 *  the catalog a saved `session-user-property` read resolves through. */
	readonly userProperties?: readonly UserProperty[];
	/** Form answers this slot may read, already narrowed to the ones its
	 *  surface admits. Absent means the slot reads no form answers. */
	readonly formFields?: readonly EditorFormFieldDecl[];
	readonly lookupTables?: readonly EditorLookupTableDecl[];
	readonly tableScope?: EditorLookupTableScope;
	/** Present only inside a case operation, where the submission's own
	 *  vocabulary: the acting user, no owner, and the case an earlier
	 *  create made: is available. `creates` lists the operations already
	 *  in scope, in execution order. */
	readonly operationScope?: OperationValueScope;
	/** Present only for the owner facet of a case operation. */
	readonly ownerValues?: boolean;
	/** Runtime that evaluates this value. Absent stays strict on-device. */
	readonly evaluationTarget?: EvaluationTarget;
}

/** The submission-local vocabulary a case-operation expression may use. */
export interface OperationValueScope {
	readonly creates: readonly { readonly uuid: Uuid; readonly label: string }[];
}

/**
 * One registry entry. Generic over `K` (the ValueExpression kind
 * discriminator) so each entry's `component` and `defaultValue`
 * carry the precise per-arm shape: `ArithCard`'s component
 * receives the `arith`-arm subtype, `IfCard`'s receives the
 * `if`-arm, etc. The signed exhaustiveness lives at the
 * `expressionCardSchemas` declaration (a `Record<ValueExpression["kind"],
 * ...>`): adding a kind without an entry breaks the build.
 *
 * Contextual availability lives in isAuthorableExpressionKind and the actual
 * slot-choice planner in ExpressionPicker, without a parallel type oracle.
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
		/** The slot's type constraint: the card computes its inner
		 *  slots' constraints from it ("depends" kinds propagate it; the
		 *  hard-typed kinds fix their operands). Defaults to
		 *  `ANY_CONSTRAINT` when the dispatch shell omits it. */
		readonly constraint?: SlotConstraint;
	}>;
	readonly defaultValue: (
		ctx: ExpressionEditContext,
	) => Extract<ValueExpression, { kind: K }>;
}

// ── Registry ────────────────────────────────────────────────────────────

/**
 * Per-kind editor schema keyed by `ValueExpression["kind"]`. The
 * mapped-type shape forces TypeScript to fail compilation if a new
 * kind lands in the ValueExpression union without a parallel entry:
 * the registry's exhaustivity is the structural guarantee that
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
		description: "Enter a value or use information already in the app",
		component: TermCard,
		defaultValue: termDefault,
	},
	"id-of": {
		kind: "id-of",
		label: "Created case ID",
		icon: tablerLink,
		description: "Use the case created by an earlier operation",
		component: IdOfCard,
		defaultValue: idOfDefault,
	},
	"acting-user": {
		kind: "acting-user",
		label: "Person using the app",
		icon: tablerUser,
		description: "Assign the case to the person using the app",
		component: ActingUserCard,
		defaultValue: actingUserDefault,
	},
	unowned: {
		kind: "unowned",
		label: "No owner",
		icon: tablerUserOff,
		description: "Leave the case without an owner",
		component: UnownedCard,
		defaultValue: unownedDefault,
	},

	// ── Date / time constants ────────────────────────────────────────
	today: {
		kind: "today",
		label: "Today's date",
		icon: tablerCalendarEvent,
		description: "Use the date when the app runs",
		component: TodayCard,
		defaultValue: todayDefault,
	},
	now: {
		kind: "now",
		label: "Current date and time",
		icon: tablerClock,
		description: "Use the date and time when the app runs",
		component: NowCard,
		defaultValue: nowDefault,
	},

	// ── Date arithmetic / coercion ───────────────────────────────────
	"date-add": {
		kind: "date-add",
		label: "Adjust a date",
		icon: tablerCalendarPlus,
		description: "Move a date or time forward or backward",
		component: DateAddCard,
		defaultValue: dateAddDefault,
	},
	"date-coerce": {
		kind: "date-coerce",
		label: "Read as a date",
		icon: tablerCalendarStats,
		description: "Treat a text value as a date",
		component: DateCoerceCard,
		defaultValue: dateCoerceDefault,
	},
	"datetime-coerce": {
		kind: "datetime-coerce",
		label: "Read as a date and time",
		icon: tablerCalendarStats,
		description: "Treat a text value as a date and time",
		component: DateCoerceCard,
		defaultValue: datetimeCoerceDefault,
	},

	// ── Numeric ──────────────────────────────────────────────────────
	double: {
		kind: "double",
		label: "Read as a number",
		icon: tablerHash,
		description: "Treat a value as a number",
		component: DoubleCard,
		defaultValue: doubleDefault,
	},
	arith: {
		kind: "arith",
		label: "Math",
		icon: tablerCalculator,
		description: "Add, subtract, multiply, or divide two values",
		component: ArithCard,
		defaultValue: arithDefault,
	},

	// ── Text ─────────────────────────────────────────────────────────
	concat: {
		kind: "concat",
		label: "Combine text",
		icon: tablerAbc,
		description: "Join several pieces of text into one",
		component: ConcatCard,
		defaultValue: concatDefault,
	},

	// ── Conditional / dispatch ───────────────────────────────────────
	coalesce: {
		kind: "coalesce",
		label: "First available value",
		icon: tablerCopy,
		description: "The first value in the list that isn't blank",
		component: CoalesceCard,
		defaultValue: coalesceDefault,
	},
	if: {
		kind: "if",
		label: "Choose by condition",
		icon: tablerGitMerge,
		description: "One value when a condition holds, another when it doesn't",
		component: IfCard,
		defaultValue: ifDefault,
	},
	switch: {
		kind: "switch",
		label: "Choose by matching",
		icon: tablerSwitch,
		description: "Use a different value for each match",
		component: SwitchCard,
		defaultValue: switchDefault,
	},

	// ── Aggregation ──────────────────────────────────────────────────
	count: {
		kind: "count",
		label: "Count related cases",
		icon: tablerListSearch,
		description: "How many connected cases match a condition",
		component: CountCard,
		defaultValue: countDefault,
	},

	// ── Project data lookup ──────────────────────────────────────────
	"table-lookup": {
		kind: "table-lookup",
		label: "Look up a table value",
		icon: tablerListSearch,
		description: "Use a column from the first matching Project data row",
		component: TableLookupCard,
		defaultValue: tableLookupDefault,
	},

	// ── Date formatting ──────────────────────────────────────────────
	"format-date": {
		kind: "format-date",
		label: "Write a date as text",
		icon: tablerArrowsShuffle,
		description: "Write a date as text in a format you choose",
		component: FormatDateCard,
		defaultValue: formatDateDefault,
	},
};

/**
 * Convenience array: every schema in declaration order, used by the
 * kind-picker UI to render the menu.
 */
export const expressionCardSchemaList: readonly ExpressionCardSchema<
	ValueExpression["kind"]
>[] = Object.values(expressionCardSchemas) as readonly ExpressionCardSchema<
	ValueExpression["kind"]
>[];

/** Contextual vocabulary boundary for the three submission-local leaves and
 * table lookup. Every other registered kind is authorable everywhere its type
 * and execution target admit it. */
export function isAuthorableExpressionKind(
	kind: ValueExpression["kind"],
	ctx?: Pick<
		ExpressionEditContext,
		"operationScope" | "ownerValues" | "lookupTables" | "tableScope"
	>,
): boolean {
	if (kind === "id-of") {
		return (ctx?.operationScope?.creates.length ?? 0) > 0;
	}
	if (kind === "acting-user" || kind === "unowned") {
		return ctx?.ownerValues === true;
	}
	if (kind === "table-lookup") {
		return (
			ctx?.tableScope === undefined &&
			(ctx?.lookupTables ?? []).some((table) => table.columns.length > 0)
		);
	}
	return true;
}
