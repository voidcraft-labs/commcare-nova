// components/builder/case-list-config/cards/column/TimeSinceUntilCard.tsx
//
// Renders the `time-since-until` Column kind — surfaces the time
// remaining or elapsed against a date property, with a per-row
// "is this overdue?" decision driven by the threshold.
//
// Slots:
//   - `field` — case-property name. Filtered to date / datetime
//     typed properties.
//   - `header` — column display label.
//   - `threshold` (number) + `unit` (`days` / `weeks` / `months`
//     / `years`) — the interval at which the row crosses from
//     "fine" to "flagged."
//   - `displayLabel` — text rendered when the threshold is
//     exceeded.

"use client";
import type { CaseProperty, Column, TimeSinceUnit } from "@/lib/domain";
import { timeSinceUntilColumn } from "@/lib/domain";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import { BlurCommitTextInput, ColumnFieldRow } from "./ColumnFieldRow";
import { IntervalThresholdRow } from "./IntervalThresholdRow";

const DATE_DATA_TYPES = new Set<string>(["date", "datetime"]);
function isDateTyped(p: CaseProperty): boolean {
	return DATE_DATA_TYPES.has(p.data_type ?? "text");
}

interface TimeSinceUntilCardProps {
	readonly value: Extract<Column, { kind: "time-since-until" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

export function TimeSinceUntilCard({
	value,
	onChange,
	errors,
}: TimeSinceUntilCardProps) {
	const setField = (next: string) =>
		onChange(
			timeSinceUntilColumn(
				next,
				value.header,
				value.threshold,
				value.unit,
				value.displayLabel,
			),
		);
	const setHeader = (next: string) =>
		onChange(
			timeSinceUntilColumn(
				value.field,
				next,
				value.threshold,
				value.unit,
				value.displayLabel,
			),
		);
	const setThreshold = (next: number) =>
		onChange(
			timeSinceUntilColumn(
				value.field,
				value.header,
				next,
				value.unit,
				value.displayLabel,
			),
		);
	const setUnit = (next: TimeSinceUnit) =>
		onChange(
			timeSinceUntilColumn(
				value.field,
				value.header,
				value.threshold,
				next,
				value.displayLabel,
			),
		);
	const setDisplayLabel = (next: string) =>
		onChange(
			timeSinceUntilColumn(
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
				thresholdLabel="Threshold"
			/>
			<div>
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
					Display label
				</div>
				<BlurCommitTextInput
					value={value.displayLabel}
					onChange={setDisplayLabel}
					placeholder="Rendered when threshold is exceeded"
					ariaLabel="Display label"
				/>
			</div>
		</div>
	);
}
