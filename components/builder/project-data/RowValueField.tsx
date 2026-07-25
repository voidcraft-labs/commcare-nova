/**
 * One typed cell, as the control its column's type deserves.
 *
 * This is the whole reason the row is edited in the rail rather than inline in
 * the grid: a date column needs `DatePicker` and a time column needs
 * `TimeField`, both of which open floating surfaces, and neither survives a
 * dense scrolling cell with a 44px target. Here each one has room.
 *
 * An empty control means the cell is ABSENT, not empty text. `lib/lookup`
 * treats a missing UUID key as a missing cell, and the two are different
 * things at the boundary — an empty CSV cell omits the key, so the editor
 * matches that rather than writing "" and inventing a value.
 */
"use client";

import { useId } from "react";
import { DatePicker } from "@/components/shadcn/date-picker";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import { TimeField } from "@/components/shadcn/time-field";
import type { LookupColumn } from "@/lib/lookup/types";
import { COLUMN_TYPE_LABELS } from "./projectDataModel";

export function RowValueField({
	column,
	value,
	invalid,
	onChange,
}: {
	column: LookupColumn;
	/** The cell as text, or `undefined` when the row has no value for it. */
	value: string | undefined;
	/** A per-cell refusal from the last save attempt, in the author's words. */
	invalid?: string;
	onChange: (next: string | undefined) => void;
}) {
	const fieldId = useId();
	const errorId = useId();
	const text = value ?? "";
	/* One place decides "typing nothing means no cell", so every control agrees
	 * and a cleared date behaves like a cleared number. */
	const commit = (next: string) => onChange(next === "" ? undefined : next);

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
						aria-describedby={invalid ? errorId : undefined}
					/>
				) : column.dataType === "time" ? (
					<TimeField
						id={fieldId}
						value={text}
						onValueChange={commit}
						aria-describedby={invalid ? errorId : undefined}
					/>
				) : column.dataType === "datetime" ? (
					<DateTimeField
						fieldId={fieldId}
						value={text}
						onChange={commit}
						describedBy={invalid ? errorId : undefined}
					/>
				) : (
					<Input
						id={fieldId}
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
						aria-describedby={invalid ? errorId : undefined}
						onChange={(event) => commit(event.target.value)}
						className="h-11"
					/>
				)}
			</div>
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
	value,
	onChange,
	describedBy,
}: {
	fieldId: string;
	value: string;
	onChange: (next: string) => void;
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
				aria-describedby={describedBy}
			/>
			<TimeField
				id={timeId}
				aria-label="Time"
				value={timePart}
				onValueChange={(next) => emit(datePart, next)}
				aria-describedby={describedBy}
			/>
		</div>
	);
}
