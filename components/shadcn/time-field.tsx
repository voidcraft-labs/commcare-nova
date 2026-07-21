"use client";

import { Input } from "@/components/shadcn/input";
import { cn } from "@/lib/utils";

interface TimeFieldProps {
	/** The raw typed text — parsing belongs to the caller's commit boundary. */
	value: string;
	onValueChange: (next: string) => void;
	id?: string;
	disabled?: boolean;
	className?: string;
	onFocus?: () => void;
	onBlur?: () => void;
	"aria-label"?: string;
	"aria-invalid"?: boolean;
	"aria-describedby"?: string;
}

/**
 * Clock-time entry — a themed text field people type a time into, in the
 * locale's own clock (the example reads "2:30 PM", never a 24-hour spelling
 * worn as theme). It deliberately is NOT a native `<input type="time">`:
 * the browser control brings its own picker chrome over Nova's theme.
 *
 * The field owns the entry UX only; the value contract is the raw typed
 * text. A hand-typed clock needs a strict parse at the caller's commit
 * boundary — `lib/ui/clockTime.ts::parseClockTime` is the canonical
 * parser (typed text → 24-hour `HH:MM:SS`, 12-hour and bare 24-hour
 * spellings, shape + ranges checked).
 */
function TimeField({
	value,
	onValueChange,
	id,
	disabled,
	className,
	onFocus,
	onBlur,
	"aria-label": ariaLabel,
	"aria-invalid": ariaInvalid,
	"aria-describedby": ariaDescribedBy,
}: TimeFieldProps) {
	return (
		<Input
			data-slot="time-field"
			autoComplete="off"
			data-1p-ignore
			id={id}
			disabled={disabled}
			value={value}
			onChange={(event) => onValueChange(event.target.value)}
			onFocus={onFocus}
			onBlur={onBlur}
			placeholder="2:30 PM"
			aria-label={ariaLabel}
			aria-invalid={ariaInvalid}
			aria-describedby={ariaDescribedBy}
			className={cn("min-h-11 w-32", className)}
		/>
	);
}

export { TimeField };
