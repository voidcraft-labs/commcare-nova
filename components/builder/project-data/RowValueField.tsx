/**
 * One typed cell, as the control its column's type deserves.
 *
 * This is the whole reason the row is edited in the rail rather than inline in
 * the grid: a date column needs `DatePicker` and a time column needs
 * `TimeField`, both of which open floating surfaces, and neither survives a
 * dense scrolling cell with a 44px target. Here each one has room.
 *
 * Text deliberately keeps `""` distinct from an absent UUID key. The server
 * model supports both, and silently collapsing an authored empty string (or
 * leading/trailing spaces) into absence would make the editor lossy. For the
 * other types, clearing the control still means absence.
 */
"use client";

import { useId } from "react";
import { DatePicker } from "@/components/shadcn/date-picker";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import { TimeField } from "@/components/shadcn/time-field";
import type { LookupColumn } from "@/lib/lookup/types";
import {
	COLUMN_TYPE_LABELS,
	editRowDraftCellText,
	type RowDraftCell,
	temporalDraftTextHiddenByControl,
} from "./projectDataModel";

export function RowValueField({
	column,
	value,
	invalid,
	disabled = false,
	onChange,
}: {
	column: LookupColumn;
	/** Raw author text plus any hidden temporal offset needed for storage. */
	value: RowDraftCell | undefined;
	/** A per-cell refusal from the last save attempt, in the author's words. */
	invalid?: string;
	disabled?: boolean;
	onChange: (next: RowDraftCell) => void;
}) {
	const fieldId = useId();
	const errorId = useId();
	const retainedRawId = useId();
	const text = value?.text ?? "";
	const retainedRaw = temporalDraftTextHiddenByControl(
		column.dataType,
		value?.text,
	);
	const describedBy =
		[
			invalid === undefined ? undefined : errorId,
			retainedRaw === undefined ? undefined : retainedRawId,
		]
			.filter((id): id is string => id !== undefined)
			.join(" ") || undefined;
	/* Keep the immutable source spelling beside every intermediate edit.
	 * `rowDraftToValues` uses it ONLY when the visible value is exactly back at
	 * `originalText`. */
	const commit = (next: string) =>
		onChange(editRowDraftCellText(value, column.dataType, next));

	return (
		<div className="min-w-0">
			<Label
				htmlFor={fieldId}
				className="flex flex-wrap items-baseline gap-x-2"
			>
				<span className="text-[13px] text-nova-text [overflow-wrap:anywhere]">
					{column.label}
				</span>
				<span className="text-[12px] font-normal text-nova-text-muted">
					{COLUMN_TYPE_LABELS[column.dataType]}
				</span>
			</Label>
			<div className="mt-1">
				{column.dataType === "date" ? (
					<DatePicker
						id={fieldId}
						value={text}
						onValueChange={commit}
						disabled={disabled}
						aria-invalid={invalid !== undefined}
						aria-describedby={describedBy}
					/>
				) : column.dataType === "time" ? (
					<TimeField
						id={fieldId}
						value={text}
						onValueChange={commit}
						disabled={disabled}
						aria-label={`${column.label} time`}
						aria-invalid={invalid !== undefined}
						aria-describedby={describedBy}
					/>
				) : column.dataType === "datetime" ? (
					<DateTimeField
						fieldId={fieldId}
						columnLabel={column.label}
						value={text}
						onChange={commit}
						disabled={disabled}
						invalid={invalid !== undefined}
						describedBy={describedBy}
					/>
				) : (
					<Input
						id={fieldId}
						disabled={disabled}
						/* `inputMode` rather than `type="number"`: a number input
						 * silently discards what it cannot parse while you type, so a
						 * mid-edit value can vanish. The server is the authority on
						 * whether a value fits its column, and it says so in words. */
						inputMode={
							column.dataType === "int"
								? "numeric"
								: column.dataType === "decimal"
									? "decimal"
									: undefined
						}
						value={text}
						autoComplete="off"
						data-1p-ignore
						aria-invalid={invalid !== undefined}
						aria-describedby={describedBy}
						onChange={(event) => commit(event.target.value)}
						className="h-11"
					/>
				)}
			</div>
			{retainedRaw !== undefined && (
				<div
					id={retainedRawId}
					className="mt-2 rounded-lg border border-nova-amber/30 bg-nova-amber/[0.06] px-3 py-2 text-[12px] leading-relaxed text-nova-text-secondary"
				>
					<p>
						This retained value does not fit the new{" "}
						{COLUMN_TYPE_LABELS[column.dataType].toLocaleLowerCase()} control.
						It remains copyable until you deliberately pick a replacement.
					</p>
					<code className="mt-1 block select-text whitespace-pre-wrap font-mono text-nova-text [overflow-wrap:anywhere]">
						{retainedRaw}
					</code>
				</div>
			)}
			{invalid !== undefined && (
				<p id={errorId} className="mt-1 text-[12px] text-nova-rose">
					{invalid}
				</p>
			)}
		</div>
	);
}

/**
 * Date and time as two controls over one stored value.
 *
 * The wire stores a single date-time string, but a person enters a date and a
 * time as separate things — and the repo's own rule is that each half uses its
 * real primitive rather than a native `datetime-local`, whose browser picker
 * pops over Nova's theme.
 */
function DateTimeField({
	fieldId,
	columnLabel,
	value,
	onChange,
	disabled,
	invalid,
	describedBy,
}: {
	fieldId: string;
	columnLabel: string;
	value: string;
	onChange: (next: string) => void;
	disabled: boolean;
	invalid: boolean;
	describedBy?: string;
}) {
	const timeId = useId();
	const [datePart = "", timePart = ""] = value.split("T");
	/* A HALF-filled date-time is kept, as `date` + `T` + `time` with one side
	 * blank. Emitting `""` for a half value instead — the obvious reading of
	 * "only a complete date-time is valid" — deletes the draft cell, which
	 * resets both controls and discards the half the author just entered, so
	 * the field could never be filled in at all. The draft holds text; only
	 * `rowDraftToValues` decides what is storable, and it refuses a half
	 * date-time with words rather than by erasing it. Both halves empty is a
	 * genuinely empty cell. */
	const emit = (nextDate: string, nextTime: string) =>
		onChange(
			nextDate === "" && nextTime === "" ? "" : `${nextDate}T${nextTime}`,
		);

	return (
		<div className="flex flex-wrap gap-2">
			<DatePicker
				id={fieldId}
				value={datePart}
				onValueChange={(next) => emit(next, timePart)}
				disabled={disabled}
				aria-invalid={invalid}
				aria-describedby={describedBy}
			/>
			<TimeField
				id={timeId}
				aria-label={`${columnLabel} time`}
				value={timePart}
				onValueChange={(next) => emit(datePart, next)}
				disabled={disabled}
				aria-invalid={invalid}
				aria-describedby={describedBy}
			/>
		</div>
	);
}
