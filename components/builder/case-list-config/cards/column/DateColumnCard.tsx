// components/builder/case-list-config/cards/column/DateColumnCard.tsx
//
// Renders the `date` Column kind — formats a date / datetime
// property through a CCHQ format-date pattern.
//
// Slots:
//   - `field` — case-property name. Filtered to `date` /
//     `datetime` typed properties.
//   - `header` — column display label.
//   - `pattern` — non-empty CCHQ wire-form date pattern. The
//     pattern slot surfaces through the shared
//     `CustomDatePatternInput` primitive
//     (`primitives/CustomDatePatternInput.tsx`): segmented preset
//     toggle row + free-text custom input + empty-pattern signal.
//     The primitive is mounted by both this card and the
//     ValueExpression-side `FormatDateCard` so polish-passes apply
//     once.
//
// Preset commits: this card supplies the canonical wire-form
// pattern values for each preset (`"short"`, `"long"`,
// `"%Y-%m-%d"` for ISO) — the column schema flattens the union to
// `z.string().min(1)`, so each preset commits a wire-form string
// directly. The ValueExpression-side `FormatDateCard` commits the
// preset enum names instead since its schema retains the
// preset-vs-custom discriminator.

"use client";
import type { Column } from "@/lib/domain";
import { dateColumn, isDateTyped } from "@/lib/domain";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import {
	CustomDatePatternInput,
	type DatePatternPreset,
} from "../../primitives/CustomDatePatternInput";
import { ColumnFieldRow } from "./ColumnFieldRow";

/**
 * Preset table for the column's date pattern. Labels are CCHQ's
 * canonical preset names; `pattern` values are the wire forms
 * each preset compiles to in CommCare's format-date implementation
 * — the column schema admits any non-empty string, so the wire
 * form is what flows through the AST.
 */
const COLUMN_DATE_PRESET_TABLE: readonly DatePatternPreset[] = [
	{ id: "short", label: "Short", pattern: "short" },
	{ id: "long", label: "Long", pattern: "long" },
	{ id: "iso", label: "ISO", pattern: "%Y-%m-%d" },
];

interface DateColumnCardProps {
	readonly value: Extract<Column, { kind: "date" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

export function DateColumnCard({
	value,
	onChange,
	errors,
}: DateColumnCardProps) {
	const setField = (next: string) =>
		onChange(dateColumn(next, value.header, value.pattern));
	const setHeader = (next: string) =>
		onChange(dateColumn(value.field, next, value.pattern));
	const setPattern = (next: string) =>
		onChange(dateColumn(value.field, value.header, next));

	return (
		<div className="space-y-2">
			<ColumnFieldRow
				field={value.field}
				onFieldChange={setField}
				header={value.header}
				onHeaderChange={setHeader}
				propertyFilter={isDateTyped}
				errors={errors}
			/>
			<div className="space-y-1.5">
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider">
					Pattern
				</div>
				<CustomDatePatternInput
					value={value.pattern}
					onChange={setPattern}
					presets={COLUMN_DATE_PRESET_TABLE}
				/>
			</div>
		</div>
	);
}
