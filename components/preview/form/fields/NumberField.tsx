"use client";
import type { DecimalField, IntField } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { ValidationError } from "./ValidationError";

interface NumberFieldProps {
	/** Either an int or decimal field. `step` derives from the kind. */
	field: IntField | DecimalField;
	state: FieldState;
	onChange: (value: string) => void;
	onBlur: () => void;
}

export function NumberField({
	field,
	state,
	onChange,
	onBlur,
}: NumberFieldProps) {
	const showError = state.touched && !state.valid;

	return (
		<div>
			<input
				type="number"
				// Integer fields only accept whole numbers; decimal fields
				// accept any precision. `kind` replaces the legacy wire-format
				// `type` discriminant.
				step={field.kind === "int" ? "1" : "any"}
				value={state.value}
				onChange={(e) => onChange(e.target.value)}
				onBlur={onBlur}
				placeholder=""
				autoComplete="off"
				data-1p-ignore
				className={`w-full px-3 py-2 rounded-lg bg-pv-input-bg border text-sm text-nova-text placeholder:text-nova-text-muted focus:outline-none transition-colors ${
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
