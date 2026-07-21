"use client";

import { Icon } from "@iconify/react/offline";
import tablerCalendar from "@iconify-icons/tabler/calendar";
import tablerX from "@iconify-icons/tabler/x";
import { format, isValid, parseISO } from "date-fns";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Calendar } from "@/components/shadcn/calendar";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { cn } from "@/lib/utils";

/** Wire-form date shape — the literal `date-fns` format string the picker
 *  emits. Matches the pattern the case-data binding layer enforces
 *  (`lib/preview/engine/runtimeBindings`'s `ISO_DATE_PATTERN`); a drift
 *  between the two would silently drop values at parsing. */
const ISO_DATE_FORMAT = "yyyy-MM-dd";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Human-facing calendar-date format. Nova's authored interface copy is
 * currently English, so pinning the formatter to `en-US` keeps the server and
 * browser projection hydration-stable while long month names avoid exposing
 * the wire representation as interface copy. */
const READABLE_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	month: "long",
	year: "numeric",
});

interface DatePickerProps {
	/** ISO `yyyy-MM-dd` string, or `""` for no selection. */
	value: string;
	onValueChange: (next: string) => void;
	/** Trigger button id — wire a `<label htmlFor>` to it. */
	id?: string;
	placeholder?: string;
	disabled?: boolean;
	/** Show the Clear footer while a date is selected (default true). */
	clearable?: boolean;
	/** Merged onto the trigger button (width, text size). */
	className?: string;
	"aria-label"?: string;
	"aria-invalid"?: boolean;
	"aria-describedby"?: string;
}

/**
 * Single-date picker — the shadcn date-picker composition (outline Button
 * trigger + Popover + `mode="single"` Calendar) as ONE component, so feature
 * code never assembles the popover itself and never reaches for a native
 * `<input type="date">` (whose browser picker pops over Nova's theme).
 *
 * The trigger reads a long-form date or the placeholder; the value contract
 * stays wire-form ISO: `date-fns` `format(..., "yyyy-MM-dd")` lands at
 * local-time midnight for `onValueChange`, so the round-trip through
 * `parseISO` has no timezone drift (`new Date("2024-01-01")` would parse as
 * UTC midnight and shift negative offsets back a day).
 *
 * Inbound values pass two gates before formatting:
 *
 *   - The shape gate (`ISO_DATE_PATTERN.test`) accepts only `YYYY-MM-DD`
 *     strings; everything else renders as no selection.
 *   - The calendar-validity gate (`isValid(parseISO(...))`) catches
 *     shape-conforming-but-calendar-invalid values like `"2024-13-45"` that
 *     `parseISO` returns as Invalid Date — `format(invalidDate, ...)` throws
 *     `RangeError` and would crash the surrounding tree; the regex alone
 *     isn't enough.
 */
function DatePicker({
	value,
	onValueChange,
	id,
	placeholder = "Pick a date",
	disabled,
	clearable = true,
	className,
	"aria-label": ariaLabel,
	"aria-invalid": ariaInvalid,
	"aria-describedby": ariaDescribedBy,
}: DatePickerProps) {
	const parsed = ISO_DATE_PATTERN.test(value) ? parseISO(value) : undefined;
	const selected = parsed !== undefined && isValid(parsed) ? parsed : undefined;
	// `open` is lifted into local state so a day-pick or Clear can close the
	// popover programmatically. Base UI's Popover dismisses on outside-press /
	// escape / close-press / focus-out only — none fire when a descendant
	// updates its own state, so an uncontrolled popover stays open after a
	// pick, blocking the user's reach to the next control.
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				id={id}
				aria-label={ariaLabel}
				aria-invalid={ariaInvalid}
				aria-describedby={ariaDescribedBy}
				disabled={disabled}
				render={
					<Button
						data-slot="date-picker"
						variant="outline"
						className={cn(
							"min-h-11 min-w-0 justify-between text-left text-[14px] leading-snug font-normal whitespace-normal data-placeholder:text-muted-foreground",
							className,
						)}
						data-placeholder={selected === undefined ? "" : undefined}
					/>
				}
			>
				<span className="min-w-0 break-words">
					{selected === undefined
						? placeholder
						: READABLE_DATE_FORMATTER.format(selected)}
				</span>
				<Icon
					icon={tablerCalendar}
					className="ml-auto size-3.5"
					aria-hidden="true"
				/>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				collisionPadding={8}
				className="max-h-[var(--available-height)] w-auto overflow-y-auto overscroll-contain p-0"
			>
				<Calendar
					mode="single"
					selected={selected}
					onSelect={(next) => {
						onValueChange(
							next === undefined ? "" : format(next, ISO_DATE_FORMAT),
						);
						setOpen(false);
					}}
					autoFocus
				/>
				{clearable && selected !== undefined && (
					<div className="flex justify-end border-t border-border p-1.5">
						<Button
							type="button"
							variant="ghost"
							size="xl"
							onClick={() => {
								onValueChange("");
								setOpen(false);
							}}
						>
							<Icon icon={tablerX} aria-hidden="true" />
							Clear
						</Button>
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}

export { DatePicker };
