// components/builder/case-list-config/columnEditorSchemas.ts
//
// Declarative registry mapping every `ColumnKind` to its card
// component, label, icon, default-value factory, and per-property
// applicability predicate. Mirrors the per-kind shape used by
// `editorSchemas.ts` (the Predicate-side registry) and
// `expressionEditorSchemas.ts` (the ValueExpression-side registry):
// adding a new column kind to `lib/domain/modules.ts`'s
// `ColumnKind` union without a parallel entry here is a compile-
// time error, so the editor can never silently bypass a kind.
//
// Why per-kind entries: a card COMPONENT in `cards/column/` always
// owns one kind, but each kind needs its own picker entry (label,
// icon, default-value, applicability gate) so the kind-replace
// menu reads correctly. Sharing components across kinds is purely
// a code-organization choice; the registry's per-kind keying
// preserves the exhaustivity check independent of file layout.

import type { IconifyIcon } from "@iconify/react/offline";
import tablerCalendarStats from "@iconify-icons/tabler/calendar-stats";
import tablerClockCog from "@iconify-icons/tabler/clock-cog";
import tablerEyeOff from "@iconify-icons/tabler/eye-off";
import tablerHourglass from "@iconify-icons/tabler/hourglass";
import tablerListNumbers from "@iconify-icons/tabler/list-numbers";
import tablerPhone from "@iconify-icons/tabler/phone";
import tablerTextSize from "@iconify-icons/tabler/text-size";
import type { ComponentType } from "react";
import type { CaseProperty, CaseType } from "@/lib/domain";
import {
	type Column,
	type ColumnKind,
	dateColumn,
	effectiveDataType,
	idMappingColumn,
	isDateTyped,
	isTextShaped,
	lateFlagColumn,
	phoneColumn,
	plainColumn,
	searchOnlyColumn,
	timeSinceUntilColumn,
} from "@/lib/domain";
import { DateColumnCard } from "./cards/column/DateColumnCard";
import { IdMappingCard } from "./cards/column/IdMappingCard";
import { LateFlagCard } from "./cards/column/LateFlagCard";
import { PhoneColumnCard } from "./cards/column/PhoneColumnCard";
import { PlainColumnCard } from "./cards/column/PlainColumnCard";
import { SearchOnlyCard } from "./cards/column/SearchOnlyCard";
import { TimeSinceUntilCard } from "./cards/column/TimeSinceUntilCard";

/**
 * Minimum context every `defaultValue(...)` factory and
 * `applicableForProperty(...)` predicate consumes. The case-list
 * column editor always reads against the module's own case type
 * (no relation walks at the column level — those live inside
 * `calculatedColumn.expression`), so the context is shallow:
 * the available case-types and the originating scope.
 *
 * Symmetric in spirit to `PredicateEditContext` /
 * `ExpressionEditContext` but minus the `knownInputs` slot — column
 * editing has no search-input-binding shape to consume.
 */
export interface ColumnEditContext {
	readonly caseTypes: readonly CaseType[];
	/** The case-type the column reads against. */
	readonly currentCaseType: string;
}

/**
 * Per-kind editor schema. Generic over `K` (the column-kind
 * discriminator) so each entry's `component` and `defaultValue`
 * carry the precise per-arm shape — `DateColumnCard`'s component
 * receives the `date`-arm subtype, `IdMappingCard`'s receives the
 * `id-mapping`-arm, etc. The signed exhaustiveness lives at the
 * `columnCardSchemas` declaration (a `Record<ColumnKind, ...>`) —
 * adding a kind without an entry breaks the build.
 *
 * `applicableForProperty(property)` decides whether the kind can
 * meaningfully render the supplied case property. Late Flag /
 * Date / Time-Since-Until require date-typed properties; Phone is
 * text-shaped only; Plain / ID-Mapping / Search-Only accept any.
 * The kind-replace menu and the inline-validity surface both read
 * the predicate; an `undefined` property (no `field` selected yet
 * or the field references a missing property) returns `true` so
 * the kind picker stays open while the user is choosing.
 *
 * `applicabilityRequirement` names the kind's property-type
 * requirement in human-readable form. Surfaces in the inline
 * mismatch hint when `applicableForProperty(...)` returns false
 * — e.g. "Late Flag columns require a date-typed property; "name"
 * is text." For kinds that accept any property, the field is
 * `null` (no requirement, no hint to render).
 */
export interface ColumnCardSchema<K extends ColumnKind> {
	readonly kind: K;
	readonly label: string;
	readonly icon: IconifyIcon;
	readonly description: string;
	readonly component: ComponentType<{
		readonly value: Extract<Column, { kind: K }>;
		readonly onChange: (next: Column) => void;
		readonly ctx: ColumnEditContext;
		/**
		 * Inline error rows surfaced beneath the card's field
		 * picker. The top-level `ColumnEditor` runs the kind-vs-
		 * property-type applicability check and threads the resulting
		 * messages through this prop; cards forward the array to
		 * their `ColumnFieldRow` so the message renders next to the
		 * offending picker.
		 */
		readonly errors?: readonly string[];
	}>;
	readonly defaultValue: (
		ctx: ColumnEditContext,
	) => Extract<Column, { kind: K }>;
	readonly applicableForProperty: (
		property: CaseProperty | undefined,
	) => boolean;
	readonly applicabilityRequirement: string | null;
}

// ── Property applicability ────────────────────────────────────────
//
// Per-kind property compatibility. The case-list column kinds
// fall into three families:
//
//   - **Date-typed only** — Date, Time-Since-Until, Late Flag.
//     Their wire emitters compute calendar arithmetic against the
//     property's value; a non-date property would silently
//     misformat / produce nonsense thresholds.
//   - **Text-shaped** — Phone. The wire emitter renders the
//     value as a tappable telephone link; numeric-typed phone
//     numbers are valid CCHQ practice but the runtime tap binding
//     expects a string. Un-annotated properties fall back to
//     `text` per the type checker's `data_type ?? "text"`
//     convention (encoded by `lib/domain/casePropertyTypes.ts`).
//   - **Universal** — Plain, ID-Mapping, Search-Only. Any
//     property surface is acceptable — the column either renders
//     the raw value (Plain), looks it up in a value→label table
//     (ID-Mapping), or declares searchability without rendering
//     (Search-Only).
//
// `undefined` from the caller (no property selected yet, or the
// field references a property the case type doesn't declare)
// short-circuits to `true` so the kind picker stays open while
// the user is choosing. The picker's own `(unknown)` icon and
// the editor's per-kind applicability error surface the missing-
// property condition; the kind menu stays permissive.

/** Plain / ID-Mapping / Search-Only — accept every property. */
function applicableForAny(_: CaseProperty | undefined): boolean {
	return true;
}

/** Date / Time-Since-Until / Late Flag — require a date-typed
 *  property. Permissive when the field slot is unset so the kind
 *  picker stays available; the inline-validity surface catches
 *  the mismatch once a field is chosen. */
function applicableForDate(property: CaseProperty | undefined): boolean {
	if (property === undefined) return true;
	return isDateTyped(property);
}

/** Phone — require a text-shaped property. Same unset-permissive
 *  contract as `applicableForDate`. */
function applicableForText(property: CaseProperty | undefined): boolean {
	if (property === undefined) return true;
	return isTextShaped(property);
}

// ── Default-value seeds ───────────────────────────────────────────
//
// Each `defaultValue(ctx)` picks a sensible first property from
// the `currentCaseType` matching the kind's applicability. When
// no property qualifies, the seed emits an empty `field` — the
// column-add UI surfaces an inline error from the type checker
// so the user knows to either pick a property or remove the
// column.

function pickFirstProperty(
	ctx: ColumnEditContext,
	predicate: (p: CaseProperty) => boolean,
): string {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	if (ct === undefined) return "";
	const property = ct.properties.find(predicate);
	return property?.name ?? "";
}

function pickFirstDate(ctx: ColumnEditContext): string {
	return pickFirstProperty(ctx, isDateTyped);
}

function pickFirstText(ctx: ColumnEditContext): string {
	return pickFirstProperty(ctx, isTextShaped);
}

function pickFirstAny(ctx: ColumnEditContext): string {
	return pickFirstProperty(ctx, () => true);
}

// ── Registry ──────────────────────────────────────────────────────
//
// Mapped-type keying enforces exhaustivity at the type layer:
// `Record<ColumnKind, ColumnCardSchema<K>>` cannot omit a kind
// without a build break.

/**
 * Per-kind editor schema keyed by `ColumnKind`. The mapped-type
 * shape forces TypeScript to fail compilation if a new kind lands
 * in the `ColumnKind` union without a parallel entry — the
 * registry's exhaustivity is the structural guarantee that the
 * editor never silently bypasses a kind.
 */
export const columnCardSchemas: {
	readonly [K in ColumnKind]: ColumnCardSchema<K>;
} = {
	plain: {
		kind: "plain",
		label: "Plain",
		icon: tablerTextSize,
		description: "Render the property value as plain text",
		component: PlainColumnCard,
		defaultValue: (ctx) => plainColumn(pickFirstAny(ctx), ""),
		applicableForProperty: applicableForAny,
		applicabilityRequirement: null,
	},
	date: {
		kind: "date",
		label: "Date",
		icon: tablerCalendarStats,
		description: "Format a date / datetime property with a preset pattern",
		component: DateColumnCard,
		defaultValue: (ctx) => dateColumn(pickFirstDate(ctx), "", "%Y-%m-%d"),
		applicableForProperty: applicableForDate,
		applicabilityRequirement: "a date-typed property",
	},
	"time-since-until": {
		kind: "time-since-until",
		label: "Time since / until",
		icon: tablerHourglass,
		description: "Render a relative interval against the property's date",
		component: TimeSinceUntilCard,
		defaultValue: (ctx) =>
			timeSinceUntilColumn(pickFirstDate(ctx), "", 7, "days", ""),
		applicableForProperty: applicableForDate,
		applicabilityRequirement: "a date-typed property",
	},
	phone: {
		kind: "phone",
		label: "Phone",
		icon: tablerPhone,
		description: "Render the property as a tappable phone link",
		component: PhoneColumnCard,
		defaultValue: (ctx) => phoneColumn(pickFirstText(ctx), ""),
		applicableForProperty: applicableForText,
		applicabilityRequirement: "a text-typed property",
	},
	"id-mapping": {
		kind: "id-mapping",
		label: "ID mapping",
		icon: tablerListNumbers,
		description: "Look up a label for each property value",
		component: IdMappingCard,
		defaultValue: (ctx) => idMappingColumn(pickFirstAny(ctx), "", []),
		applicableForProperty: applicableForAny,
		applicabilityRequirement: null,
	},
	"late-flag": {
		kind: "late-flag",
		label: "Late flag",
		icon: tablerClockCog,
		description: "Show a flag when the date property exceeds a threshold",
		component: LateFlagCard,
		defaultValue: (ctx) =>
			lateFlagColumn(pickFirstDate(ctx), "", 7, "days", "Overdue"),
		applicableForProperty: applicableForDate,
		applicabilityRequirement: "a date-typed property",
	},
	"search-only": {
		kind: "search-only",
		label: "Search-only",
		icon: tablerEyeOff,
		description: "Declare the property as searchable without displaying it",
		component: SearchOnlyCard,
		defaultValue: (ctx) => searchOnlyColumn(pickFirstAny(ctx), ""),
		applicableForProperty: applicableForAny,
		applicabilityRequirement: null,
	},
};

/**
 * Convenience array — every schema in declaration order. Used by
 * the kind-replace menu to render its option list.
 */
export const columnCardSchemaList: readonly ColumnCardSchema<ColumnKind>[] =
	Object.values(columnCardSchemas) as readonly ColumnCardSchema<ColumnKind>[];

/**
 * Resolve the effective `data_type` of the column's referenced
 * property against the editor context. Returns `undefined` when
 * the field references a property the case type doesn't declare
 * — the inline-validity surface uses this to render an "Unknown
 * property" hint without blocking the kind picker.
 */
export function resolveColumnPropertyDataType(
	ctx: ColumnEditContext,
	field: string,
): string | undefined {
	if (field === "") return undefined;
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	if (ct === undefined) return undefined;
	const property = ct.properties.find((p) => p.name === field);
	if (property === undefined) return undefined;
	return effectiveDataType(property);
}

/**
 * Look up the case property a column references. Returns
 * `undefined` when the case type isn't declared, when the case
 * type has no property by that name, or when the column's `field`
 * is empty. The applicability predicate accepts `undefined` as
 * "no opinion" so the kind picker stays available while the user
 * is choosing a property.
 */
export function resolveColumnProperty(
	ctx: ColumnEditContext,
	field: string,
): CaseProperty | undefined {
	if (field === "") return undefined;
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	if (ct === undefined) return undefined;
	return ct.properties.find((p) => p.name === field);
}
