"use client";
import type {
	DateField as DateFieldEntity,
	DatetimeField,
	TimeField,
} from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { ValidationError } from "./ValidationError";

interface DateFieldProps {
	/** Any of the three datetime-family kinds; the input type maps 1-to-1. */
	field: DateFieldEntity | TimeField | DatetimeField;
	state: FieldState;
	onChange: (value: string) => void;
	onBlur: () => void;
}

export function DateField({ field, state, onChange, onBlur }: DateFieldProps) {
	// `kind` replaces wire `type`. The three kinds map to their native
	// HTML input types; `datetime` uses `datetime-local` because the
	// plain `datetime` type is obsolete.
	const inputType =
		field.kind === "time"
			? "time"
			: field.kind === "datetime"
				? "datetime-local"
				: "date";
	const showError = state.touched && !state.valid;

	return (
		<div>
			<input
				type={inputType}
				value={state.value}
				onChange={(e) => onChange(e.target.value)}
				onBlur={onBlur}
				autoComplete="off"
				data-1p-ignore
				className={`w-full px-3 py-2 rounded-lg bg-pv-input-bg border text-sm text-nova-text focus:outline-none transition-colors ${
					showError
						? "border-nova-rose/50 focus:border-nova-rose"
						: "border-pv-input-border focus:border-pv-input-focus"
				}`}
			/>
			{showError && state.errorMessage && (
				<ValidationError message={state.errorMessage} />
			)}
		</div>
	);
}
