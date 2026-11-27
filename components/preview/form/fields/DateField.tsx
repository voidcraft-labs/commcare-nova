"use client";
import { useRef, useState } from "react";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { AlternateDatePicker } from "@/components/preview/shared/AlternateDatePicker";
import { WorkerDatePicker } from "@/components/preview/shared/WorkerDatePicker";
import { TimeField as ClockTimeField } from "@/components/shadcn/time-field";
import type {
	DateField as DateFieldEntity,
	DatetimeField,
	TimeField,
} from "@/lib/domain";
import { hasOtherDisplay } from "@/lib/domain/questionDisplay";
import {
	isReadableTemporalValue,
	paddedTimeOfDay,
	storageDatetimeValue,
	storageTimeValue,
	storedWallClock,
} from "@/lib/domain/temporalValues";
import { viewerTimeZone } from "@/lib/preview/engine/caseDataBindingClient";
import type { FieldState } from "@/lib/preview/engine/types";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";
import { androidCalendarCanBeEmpty } from "@/lib/preview/workerCalendar";
import { usePreviewPlatformRules } from "@/lib/session/hooks";
import { formatClockTime, parseClockTime } from "@/lib/ui/clockTime";
import { ValidationError } from "./ValidationError";

/**
 * Preview-theme skin for the two design-system controls this question
 * composes. The previewed app is the USER's app and wears its own `--pv-*`
 * palette, so a control that arrived styled for Nova chrome has to be
 * re-pointed at those tokens or it reads as a different component family
 * sitting next to the text and number questions.
 *
 * The `dark:` duplication is not redundancy: `app/layout.tsx` puts `dark`
 * on `<html>` permanently, so the primitives' own `dark:` rules are always
 * live and a bare `bg-*` from here would lose to them. Everything the
 * theme already agrees on is deliberately absent: `--ring` and
 * `--destructive` resolve to the same violet and rose the preview uses, so
 * focus and error states need no override at all.
 *
 * A remap of the shadcn tokens themselves inside `.preview-theme` would
 * retire these strings; it would also restyle the Nova chrome that shares
 * that wrapper, so it is its own change.
 */
const PV_TRIGGER =
	"border-pv-input-border bg-pv-input-bg not-disabled:hover:bg-pv-elevated aria-expanded:bg-pv-elevated dark:border-pv-input-border dark:bg-pv-input-bg dark:not-disabled:hover:bg-pv-elevated";
const PV_INPUT =
	"border-pv-input-border bg-pv-input-bg text-sm placeholder:text-nova-text-muted dark:bg-pv-input-bg";

interface DateFieldProps {
	/** Any of the three datetime-family kinds; each composes its own controls. */
	field: DateFieldEntity | TimeField | DatetimeField;
	state: FieldState;
	/** Visible question label rendered by InteractiveFormRenderer. */
	labelledBy?: string;
	onChange: (value: string) => void;
	onBlur: () => void;
}

/**
 * The date / time / datetime question, drawn from the design system rather
 * than from the browser: `DatePicker` for the calendar half and the
 * locale-clock `TimeField` for the clock half, so no native picker chrome
 * pops over the previewed app's theme.
 *
 * ## The value it holds is the value the case store holds
 *
 * `state.value` is the wire-and-storage shape end to end: `2026-01-15`,
 * `14:30:00.000Z`, `2026-01-15T14:30:00.000-05:00` (`lib/domain/temporalValues.ts`
 * owns all three). That is what preload writes into the instance and what
 * typed case-property reads return, so the widget renders and returns the same
 * spelling rather than a private one, which is also why the native
 * `<input type="datetime-local">` this replaces could not stay: it silently
 * blanks any value carrying a zone designator, so every preloaded datetime
 * showed up empty.
 *
 * The two directions:
 *
 *   - **Reading**, a value that was written by a machine is projected to
 *     human text and a value the person is typing is left alone, the line
 *     drawn by `storedWallClock` on marks hand-typing cannot leave.
 *     Reformatting across it would rewrite "2:30" into "2:30 AM" under
 *     someone still reaching for PM: the one thing a live-formatting
 *     field must not do.
 *   - **Writing**, every commit boundary canonicalizes: a calendar pick
 *     (which closes its own popover, so it IS a commit) and the clock
 *     field's blur. Canonicalization is idempotent, so a focus-and-blur
 *     that changed nothing rewrites nothing: a value that merely predates
 *     the millisecond rule is repaired to the spelling submission would
 *     have given it anyway, and half-finished text survives to be named in
 *     the engine's shape error rather than being mangled toward a shape it
 *     never had.
 *
 *     That commit reads the field's CURRENT text rather than the last value
 *     this component rendered. They are not the same thing: the final
 *     keystroke and the blur can land in one batch, and a handler closing
 *     over its own render would then write back the value the person had
 *     just replaced.
 *
 * A NEWLY entered datetime takes the offset of the viewer's zone, matching
 * the device stamping its own (`DateTimeData::uncast`, and Web Apps'
 * browser-offset provider). Web Apps displays an existing offset and wall
 * clock as stored. Android shows the instant on the device's own clock and
 * saves the displayed day and minute in the zone of that selected day.
 */
export function DateField({
	field,
	state,
	labelledBy,
	onChange,
	onBlur,
}: DateFieldProps) {
	const rules = usePreviewPlatformRules();
	const clearable = rules.datePicker === "clearable";
	const { language } = useBuilderLanguage();
	const [blankClockDraft, setBlankClockDraft] = useState(false);
	const lastPickerAnswer = useRef<string | undefined>(undefined);
	const showError = state.touched && !state.valid;
	const stored = state.value;
	const errorSlot = showError && state.errorMessage && (
		<ValidationError message={state.errorMessage} />
	);

	if (field.kind === "date") {
		const calendar = field.calendar;
		const displayed = stored || state.androidPickerDay || "";
		const usesCalendar =
			calendar === "ethiopian"
				? rules.alternateCalendar === "ethiopian" ||
					!hasOtherDisplay(field, "calendar")
				: !!calendar && rules.alternateCalendar === "authored";
		if (usesCalendar && calendar)
			return (
				<div>
					<AlternateDatePicker
						calendar={
							calendar === "gregorian-with-clear" ? "gregorian" : calendar
						}
						showClearButton={calendar === "gregorian-with-clear"}
						canClearInCalendar={
							clearable || androidCalendarCanBeEmpty(calendar)
						}
						value={displayed}
						onChange={onChange}
						onBlur={onBlur}
						invalid={!!showError}
						labelledBy={labelledBy}
					/>
					{errorSlot}
				</div>
			);

		return (
			<div>
				<WorkerDatePicker
					clearable={clearable}
					value={displayed}
					onValueChange={(next) => {
						if (!next && !clearable) return;
						onChange(next);
						onBlur();
					}}
					onBlur={onBlur}
					aria-labelledby={labelledBy}
					aria-invalid={showError || undefined}
					className={`w-full ${PV_TRIGGER}`}
				/>
				{errorSlot}
			</div>
		);
	}

	if (field.kind === "time") {
		return (
			<div>
				<ClockTimeField
					placeholder={
						rules.timeClock === "as-authored" && !field.clock
							? "14:30"
							: "2:30 PM"
					}
					value={
						formatClockTime(
							stored,
							rules.timeClock === "device" || field.clock === "twelve-hour",
						) ?? stored
					}
					onValueChange={onChange}
					onBlur={(text) => {
						onChange(storageTimeValue(parseClockTime(text) ?? text));
						onBlur();
					}}
					aria-labelledby={labelledBy}
					aria-invalid={showError || undefined}
					className={`w-full ${PV_INPUT}`}
				/>
				{errorSlot}
			</div>
		);
	}

	// A datetime is edited as its two halves and stored as one string, so
	// either control can lead. The split is textual, and each half is then
	// read on its own terms: a stored datetime's clock half is by
	// construction in the stored TIME shape, so the same reader the
	// standalone time question uses projects it, and it keeps doing so
	// while the other half is missing or half-typed.
	const editingClock =
		state.edited &&
		stored.includes("T") &&
		storedWallClock(stored.slice(stored.indexOf("T") + 1)) === null;
	const displayed = editingClock
		? stored
		: (state.androidPickerDatetime ?? stored);
	const separator = displayed.indexOf("T");
	const datePart = separator === -1 ? displayed : displayed.slice(0, separator);
	const timePart = separator === -1 ? "" : displayed.slice(separator + 1);

	/**
	 * Android saves a complete local minute. A blank clock input is a draft
	 * for editing the picker. Web Apps can save the halves independently.
	 */
	const commit = (date: string, time: string): void => {
		const parsedClock = parseClockTime(time);
		const clock = parsedClock ?? time.trim();
		if (!clearable) {
			const minute = storedWallClock(time) ?? parsedClock;
			const zone = viewerTimeZone();
			if (date === "" || clock === "") return;
			if (minute !== null) {
				onChange(storageDatetimeValue(`${date}T${minute.slice(0, 5)}`, zone));
				return;
			}
		}
		if (date === "" && clock === "") {
			onChange("");
			return;
		}
		if (clock === "") {
			onChange(date);
			return;
		}
		if (date === "") {
			// No date yet. The clock is padded so it still reads back as a
			// clock while the person goes to pick the date, and keeps whatever
			// zone it already had: a `Z` tag added here would later be
			// mistaken for the whole answer's real offset. The engine's shape
			// gate is what asks them for the date.
			onChange(`T${paddedTimeOfDay(clock)}`);
			return;
		}
		onChange(storageDatetimeValue(`${date}T${clock}`, viewerTimeZone()));
	};

	return (
		// Two controls under one question label: the group carries the
		// label and each control names its own half, rather than both
		// answering to the same name.
		<div>
			<fieldset
				aria-labelledby={labelledBy}
				className="flex min-w-0 flex-wrap gap-2"
			>
				<WorkerDatePicker
					clearable={clearable}
					value={datePart}
					onValueChange={(next) => {
						if (!next && !clearable) return;
						commit(next, timePart);
						onBlur();
					}}
					onBlur={onBlur}
					aria-label={runtimeMessage(language, "dateLabel")}
					aria-invalid={showError || undefined}
					className={`min-w-0 flex-1 ${PV_TRIGGER}`}
				/>
				<ClockTimeField
					value={blankClockDraft ? "" : (formatClockTime(timePart) ?? timePart)}
					onValueChange={(next) => {
						if (!clearable) {
							const pickerAnswer = isReadableTemporalValue("datetime", stored)
								? stored
								: state.androidPickerDatetime;
							if (pickerAnswer !== undefined && !editingClock)
								lastPickerAnswer.current = pickerAnswer;
							const blank = next.trim() === "";
							setBlankClockDraft(blank);
							if (blank) {
								// Erasing the browser text does not operate Android's
								// Clear action. Discard any incomplete clock text and
								// keep the last complete answer for screen exit.
								if (editingClock && lastPickerAnswer.current !== undefined)
									onChange(lastPickerAnswer.current);
								return;
							}
						}
						onChange(
							next === "" && datePart === "" ? "" : `${datePart}T${next}`,
						);
					}}
					onBlur={(text) => {
						// Merely focusing and leaving the displayed clock keeps the
						// suggested answer local until the worker leaves this screen.
						if (
							(clearable || text.trim() !== "") &&
							(editingClock ||
								state.androidPickerDatetime === undefined ||
								text !== (formatClockTime(timePart) ?? timePart))
						)
							commit(datePart, text);
						onBlur();
					}}
					aria-label={runtimeMessage(language, "timeLabel")}
					aria-invalid={showError || undefined}
					className={PV_INPUT}
				/>
			</fieldset>
			{errorSlot}
		</div>
	);
}
