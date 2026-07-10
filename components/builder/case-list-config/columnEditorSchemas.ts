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
// Seven kinds — `plain`, `date`, `phone`, `id-mapping`, `image-map`,
// `interval`, `calculated`. `image-map` mirrors `id-mapping`'s
// value-lookup card with an image slot per row instead of a label. The
// `interval` kind dispatches on its own `display: "always" | "flag"`
// discriminator; one card body covers both modes. The `calculated`
// kind has no `field` slot — the expression IS the source — so its
// card body skips the field picker and mounts `ExpressionCardEditor`
// directly.

import type { IconifyIcon } from "@iconify/react/offline";
import tablerCalendarStats from "@iconify-icons/tabler/calendar-stats";
import tablerHourglass from "@iconify-icons/tabler/hourglass";
import tablerListNumbers from "@iconify-icons/tabler/list-numbers";
import tablerMathFunction from "@iconify-icons/tabler/math-function";
import tablerPhone from "@iconify-icons/tabler/phone";
import tablerPhoto from "@iconify-icons/tabler/photo";
import tablerTextSize from "@iconify-icons/tabler/text-size";
import type { ComponentType } from "react";
import type { CaseProperty, CaseType } from "@/lib/domain";
import {
	type Column,
	type ColumnKind,
	calculatedColumn,
	columnKindAcceptsPropertyType,
	dateColumn,
	effectiveDataType,
	idMappingColumn,
	imageMapColumn,
	intervalColumn,
	isDateTyped,
	isTextShaped,
	phoneColumn,
	plainColumn,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { CalculatedColumnCard } from "./cards/column/CalculatedColumnCard";
import { DateColumnCard } from "./cards/column/DateColumnCard";
import { IdMappingCard } from "./cards/column/IdMappingCard";
import { ImageMapColumnCard } from "./cards/column/ImageMapColumnCard";
import { IntervalCard } from "./cards/column/IntervalCard";
import { PhoneColumnCard } from "./cards/column/PhoneColumnCard";
import { PlainColumnCard } from "./cards/column/PlainColumnCard";
import { newUuid } from "./uuid";

/**
 * Minimum context every `defaultValue(...)` factory and
 * `applicableForProperty(...)` predicate consumes. The case-list
 * column editor always reads against the module's own case type
 * (no relation walks at the column level — those live inside
 * `calculated.expression`), so the context is shallow: the available
 * case-types and the originating scope.
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
 * meaningfully render the supplied case property. Date / Interval
 * require date-typed properties; Phone is text-shaped only; Plain /
 * ID-Mapping accept any. Calculated has no `field` and so always
 * applies regardless of property — the kind picker stays open
 * across every property choice.
 *
 * `applicabilityRequirement` names the kind's property-type
 * requirement in human-readable form. Surfaces in the inline
 * mismatch hint when `applicableForProperty(...)` returns false
 * — e.g. "Interval columns require a date-typed property; "name"
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
		 * Inline error rows surfaced beneath the card's field picker.
		 * The top-level `ColumnEditor` runs the kind-vs-property-type
		 * applicability check and threads the resulting messages
		 * through this prop; cards forward the array to their
		 * `ColumnFieldRow` so the message renders next to the
		 * offending picker. Calculated cards have no field picker —
		 * they receive errors but never render them (the parent's
		 * outer-shell error footer surfaces operator-level
		 * diagnostics).
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
// Per-kind property compatibility — thin arrows over the DOMAIN
// predicate (`lib/domain/columnApplicability.ts`), the same one the
// commit gate's `CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH` rule
// runs, so the menu's offered-set can't drift from the gate's
// accept-set. The verdict is honest-unknown-permissive: a property
// whose `data_type` the effective view leaves absent (neither a
// declaration nor the writing fields pin one) accepts every kind —
// missing metadata never manufactures an error. Same for `undefined`
// from the caller (no property selected yet, or a name the admission
// set doesn't resolve): the kind picker stays open while the user is
// choosing.

/** Thin per-kind arrow over the domain predicate — the kind→family
 *  mapping itself lives ONLY in `columnKindPropertyRequirement`. */
function applicableFor(
	kind: ColumnKind,
): (property: CaseProperty | undefined) => boolean {
	return (property) => columnKindAcceptsPropertyType(kind, property?.data_type);
}

// ── Default-value seeds ───────────────────────────────────────────
//
// Each `defaultValue(ctx)` picks a sensible first property from the
// `currentCaseType` matching the kind's applicability. When no
// property qualifies, the seed emits an empty `field` — the column-
// add UI surfaces an inline error from the type checker so the user
// knows to either pick a property or remove the column.

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
		label: "Text",
		icon: tablerTextSize,
		description: "Show the value exactly as it's stored.",
		component: PlainColumnCard,
		defaultValue: (ctx) => plainColumn(newUuid(), pickFirstAny(ctx), ""),
		applicableForProperty: applicableFor("plain"),
		applicabilityRequirement: null,
	},
	date: {
		kind: "date",
		label: "Date",
		icon: tablerCalendarStats,
		description: "Format a date for easy reading.",
		component: DateColumnCard,
		defaultValue: (ctx) =>
			dateColumn(newUuid(), pickFirstDate(ctx), "", "%Y-%m-%d"),
		applicableForProperty: applicableFor("date"),
		applicabilityRequirement: "a date-typed property",
	},
	phone: {
		kind: "phone",
		label: "Phone Number",
		icon: tablerPhone,
		description: "Tap the number to call it.",
		component: PhoneColumnCard,
		defaultValue: (ctx) => phoneColumn(newUuid(), pickFirstText(ctx), ""),
		applicableForProperty: applicableFor("phone"),
		applicabilityRequirement: "a text-typed property",
	},
	"id-mapping": {
		kind: "id-mapping",
		label: "Value Labels",
		icon: tablerListNumbers,
		description: "Show a friendly label in place of each stored value.",
		component: IdMappingCard,
		defaultValue: (ctx) =>
			idMappingColumn(newUuid(), pickFirstAny(ctx), "", []),
		applicableForProperty: applicableFor("id-mapping"),
		applicabilityRequirement: null,
	},
	"image-map": {
		kind: "image-map",
		label: "Value Images",
		icon: tablerPhoto,
		description: "Show an image in place of each stored value.",
		component: ImageMapColumnCard,
		defaultValue: (ctx) => imageMapColumn(newUuid(), pickFirstAny(ctx), "", []),
		applicableForProperty: applicableFor("image-map"),
		applicabilityRequirement: null,
	},
	interval: {
		kind: "interval",
		label: "Time Since",
		icon: tablerHourglass,
		description: "How long since (or until) the date, with an overdue flag.",
		component: IntervalCard,
		defaultValue: (ctx) =>
			intervalColumn(
				newUuid(),
				pickFirstDate(ctx),
				"",
				7,
				"days",
				"always",
				"",
			),
		applicableForProperty: applicableFor("interval"),
		applicabilityRequirement: "a date-typed property",
	},
	calculated: {
		kind: "calculated",
		label: "Calculated",
		icon: tablerMathFunction,
		description: "Compute what's shown with a formula.",
		component: CalculatedColumnCard,
		defaultValue: () => calculatedColumn(newUuid(), "", term(literal(""))),
		applicableForProperty: applicableFor("calculated"),
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
 *
 * Calculated columns have no `field` slot; callers must guard
 * before invoking this on a calculated value.
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
 *
 * Calculated columns have no `field` slot; callers must guard
 * before invoking this on a calculated value.
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
