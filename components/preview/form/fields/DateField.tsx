"use client";
import { DatePicker } from "@/components/shadcn/date-picker";
import { TimeField as ClockTimeField } from "@/components/shadcn/time-field";
import type {
	DateField as DateFieldEntity,
	DatetimeField,
	TimeField,
} from "@/lib/domain";
import {
	paddedTimeOfDay,
	storageDatetimeValue,
	storageTimeValue,
} from "@/lib/domain/temporalValues";
import { viewerTimeZone } from "@/lib/preview/engine/caseDataBindingClient";
import type { FieldState } from "@/lib/preview/engine/types";
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
 * browser-offset provider). An answer that already carries an offset keeps
 * it, and its wall clock is displayed exactly as stored, so an answer
 * entered on some other device reads as the clock that was entered there,
 * and moving its date does not quietly relocate it to the author's zone.
 * The offset belongs to the answer; only a clock the person types here is
 * this viewer's to stamp.
 */
export function DateField({
	field,
	state,
	labelledBy,
	onChange,
	onBlur,
}: DateFieldProps) {
	const showError = state.touched && !state.valid;
	const stored = state.value;
	const errorSlot = showError && state.errorMessage && (
		<ValidationError
			message={state.errorMessage}
			media={
				"validate_msg_media" in field ? field.validate_msg_media : undefined
			}
		/>
	);

	if (field.kind === "date") {
		return (
			<div>
				<DatePicker
					value={stored}
					onValueChange={(next) => {
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
					value={formatClockTime(stored) ?? stored}
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
	const separator = stored.indexOf("T");
	const datePart = separator === -1 ? stored : stored.slice(0, separator);
	const timePart = separator === -1 ? "" : stored.slice(separator + 1);

	/**
	 * Commit the two halves as one answer. Each arm produces a value the
	 * split above can read back, and none of them invents a half nobody
	 * entered: the join has to survive being HALF filled in, because that
	 * is the state a person passes through on the way to filling it.
	 *
	 * A bare date is deliberately left bare rather than extended to its own
	 * midnight here. It is already a readable datetime that the storage
	 * boundary reads as midnight, so leaving it alone keeps an empty clock
	 * box honest ("you have not set a time") instead of answering the
	 * question on the person's behalf with a 12:00 AM they never chose and
	 * cannot clear: clearing it would just put it straight back.
	 */
	const commit = (date: string, time: string): void => {
		const clock = parseClockTime(time) ?? time.trim();
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
				<DatePicker
					value={datePart}
					onValueChange={(next) => {
						commit(next, timePart);
						onBlur();
					}}
					onBlur={onBlur}
					aria-label="Date"
					aria-invalid={showError || undefined}
					className={`min-w-0 flex-1 ${PV_TRIGGER}`}
				/>
				<ClockTimeField
					value={formatClockTime(timePart) ?? timePart}
					onValueChange={(next) =>
						// Both halves empty is an empty answer, not the `T` that
						// joining two empty strings would leave behind: a value
						// no schema accepts and no person typed.
						onChange(
							next === "" && datePart === "" ? "" : `${datePart}T${next}`,
						)
					}
					onBlur={(text) => {
						commit(datePart, text);
						onBlur();
					}}
					aria-label="Time"
					aria-invalid={showError || undefined}
					className={PV_INPUT}
				/>
			</fieldset>
			{errorSlot}
		</div>
	);
}
