// components/builder/case-list-config/cards/column/IntervalCard.tsx
//
// Renders the `interval` Column kind — a relative interval against
// a date property, with a `display` discriminator that picks between
// two cell shapes:
//
//   - `display: "always"` — always show the relative interval
//     (e.g. "3 days ago"). The `text` slot is the runtime label
//     that decorates rows whose interval has crossed the threshold.
//   - `display: "flag"` — show `text` only when the threshold is
//     exceeded; otherwise the cell renders empty.
//
// One card, two modes — the user picks `display` via a segmented
// toggle and the `text` slot's label adjusts to match. Threshold +
// unit + the field reference shape are identical across both modes.
//
// Slots:
//   - `field` — case-property name. Filtered to `date` /
//     `datetime` typed properties.
//   - `header` — column display label.
//   - `threshold` (number) + `unit` (`days` / `weeks` / `months`
//     / `years`) — the interval at which the row crosses from
//     "fine" to "flagged."
//   - `display` — `"always"` (interval) or `"flag"` (flag-text).
//   - `text` — the runtime label whose role flips by `display`.

"use client";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import type { Column, IntervalDisplay, TimeSinceUnit } from "@/lib/domain";
import { intervalColumn, isDateTyped } from "@/lib/domain";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import { SegmentedRow } from "../../inspector/inspectorChrome";
import { ColumnFieldRow } from "./ColumnFieldRow";
import { IntervalThresholdRow } from "./IntervalThresholdRow";

interface IntervalCardProps {
	readonly value: Extract<Column, { kind: "interval" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

/**
 * Per-display copy. The `text` slot's affordance changes role with
 * `display`: in "always" mode it decorates threshold-exceeded rows;
 * in "flag" mode it IS the flag text. The label / placeholder shift
 * accordingly so the role at the wire layer stays self-evident in
 * the editor.
 */
const DISPLAY_COPY: Record<
	IntervalDisplay,
	{ readonly textLabel: string; readonly textPlaceholder: string }
> = {
	always: {
		textLabel: "Text when overdue",
		textPlaceholder: "Shown next to the interval once a row is overdue",
	},
	flag: {
		textLabel: "Flag text",
		textPlaceholder:
			"Shown when a row is overdue — otherwise the cell stays empty",
	},
};

const DISPLAY_LABELS: Record<IntervalDisplay, string> = {
	always: "Show Interval",
	flag: "Flag When Overdue",
};

export function IntervalCard({ value, onChange, errors }: IntervalCardProps) {
	const setField = (next: string) =>
		onChange(
			intervalColumn(
				value.uuid,
				next,
				value.header,
				value.threshold,
				value.unit,
				value.display,
				value.text,
				slotsFrom(value),
			),
		);
	const setHeader = (next: string) =>
		onChange(
			intervalColumn(
				value.uuid,
				value.field,
				next,
				value.threshold,
				value.unit,
				value.display,
				value.text,
				slotsFrom(value),
			),
		);
	const setThreshold = (next: number) =>
		onChange(
			intervalColumn(
				value.uuid,
				value.field,
				value.header,
				next,
				value.unit,
				value.display,
				value.text,
				slotsFrom(value),
			),
		);
	const setUnit = (next: TimeSinceUnit) =>
		onChange(
			intervalColumn(
				value.uuid,
				value.field,
				value.header,
				value.threshold,
				next,
				value.display,
				value.text,
				slotsFrom(value),
			),
		);
	const setDisplay = (next: IntervalDisplay) =>
		onChange(
			intervalColumn(
				value.uuid,
				value.field,
				value.header,
				value.threshold,
				value.unit,
				next,
				value.text,
				slotsFrom(value),
			),
		);
	const setText = (next: string) =>
		onChange(
			intervalColumn(
				value.uuid,
				value.field,
				value.header,
				value.threshold,
				value.unit,
				value.display,
				next,
				slotsFrom(value),
			),
		);

	const copy = DISPLAY_COPY[value.display];

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
				thresholdLabel="Overdue after"
			/>
			<DisplayToggle value={value.display} onChange={setDisplay} />
			<div>
				<div className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted mb-1.5">
					{copy.textLabel}
				</div>
				<BlurCommitTextInput
					value={value.text}
					onCommit={setText}
					placeholder={copy.textPlaceholder}
					ariaLabel={copy.textLabel}
				/>
			</div>
		</div>
	);
}

interface DisplayToggleProps {
	readonly value: IntervalDisplay;
	readonly onChange: (next: IntervalDisplay) => void;
}

/**
 * Two-state segmented toggle picking between the two interval
 * display modes — the shared `SegmentedRow`, so both options stay
 * visible at full size.
 */
function DisplayToggle({ value, onChange }: DisplayToggleProps) {
	return (
		<div>
			<div className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted mb-1.5">
				Display
			</div>
			<SegmentedRow
				legend="Interval display mode"
				options={[
					{ value: "always", label: DISPLAY_LABELS.always },
					{ value: "flag", label: DISPLAY_LABELS.flag },
				]}
				value={value}
				onChange={onChange}
			/>
		</div>
	);
}

/** Re-extract the column's optional common slots so each builder call
 *  threads through them verbatim. The schema's strip-mode parse omits
 *  absent keys; the builder's `slots` object preserves whichever slots
 *  the value already carries (sort, visibleInList, visibleInDetail). */
function slotsFrom(value: Extract<Column, { kind: "interval" }>): {
	sort?: typeof value.sort;
	visibleInList?: typeof value.visibleInList;
	visibleInDetail?: typeof value.visibleInDetail;
} {
	return {
		sort: value.sort,
		visibleInList: value.visibleInList,
		visibleInDetail: value.visibleInDetail,
	};
}
