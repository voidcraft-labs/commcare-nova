// components/builder/case-list-config/cards/column/LateFlagCard.tsx
//
// Renders the `late-flag` Column kind — surfaces a flag string
// (`flagDisplayValue`) when the date property exceeds the
// threshold; otherwise the cell renders empty. Used for "overdue"
// / "follow-up needed" signals on the case list.
//
// Slots:
//   - `field` — case-property name. Filtered to date / datetime
//     typed properties.
//   - `header` — column display label.
//   - `threshold` (number) + `unit` (`days` / `weeks` / `months`
//     / `years`) — the interval beyond which the row is flagged.
//   - `flagDisplayValue` — text rendered when the threshold is
//     exceeded.
//
// Symmetric in shape to `TimeSinceUntilCard` — both kinds share
// the same `(threshold, unit)` pair AND a per-kind text slot
// (`displayLabel` here vs `flagDisplayValue` there). The cards
// stay separate because the SLOT NAMES differ — sharing a single
// generic card would force a discriminated dispatch on every
// onChange.

"use client";
import type { Column, TimeSinceUnit } from "@/lib/domain";
import { lateFlagColumn } from "@/lib/domain";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import { BlurCommitTextInput } from "../../primitives/BlurCommitTextInput";
import { isDateTyped } from "../../propertyTypeSets";
import { ColumnFieldRow } from "./ColumnFieldRow";
import { IntervalThresholdRow } from "./IntervalThresholdRow";

interface LateFlagCardProps {
	readonly value: Extract<Column, { kind: "late-flag" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

export function LateFlagCard({ value, onChange, errors }: LateFlagCardProps) {
	const setField = (next: string) =>
		onChange(
			lateFlagColumn(
				next,
				value.header,
				value.threshold,
				value.unit,
				value.flagDisplayValue,
			),
		);
	const setHeader = (next: string) =>
		onChange(
			lateFlagColumn(
				value.field,
				next,
				value.threshold,
				value.unit,
				value.flagDisplayValue,
			),
		);
	const setThreshold = (next: number) =>
		onChange(
			lateFlagColumn(
				value.field,
				value.header,
				next,
				value.unit,
				value.flagDisplayValue,
			),
		);
	const setUnit = (next: TimeSinceUnit) =>
		onChange(
			lateFlagColumn(
				value.field,
				value.header,
				value.threshold,
				next,
				value.flagDisplayValue,
			),
		);
	const setFlagDisplayValue = (next: string) =>
		onChange(
			lateFlagColumn(
				value.field,
				value.header,
				value.threshold,
				value.unit,
				next,
			),
		);

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
			<IntervalThresholdRow
				threshold={value.threshold}
				onThresholdChange={setThreshold}
				unit={value.unit}
				onUnitChange={setUnit}
				thresholdLabel="Late after"
			/>
			<div>
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
					Flag value
				</div>
				<BlurCommitTextInput
					value={value.flagDisplayValue}
					onCommit={setFlagDisplayValue}
					placeholder="Rendered when overdue"
					ariaLabel="Flag display value"
				/>
			</div>
		</div>
	);
}
