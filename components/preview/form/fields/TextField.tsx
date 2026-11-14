"use client";
import type { SecretField, TextField as TextFieldEntity } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { ValidationError } from "./ValidationError";

interface TextFieldProps {
	/** Plain text or secret field. The DOM input type differs by kind. */
	field: TextFieldEntity | SecretField;
	state: FieldState;
	/** Visible question label rendered by InteractiveFormRenderer. */
	labelledBy?: string;
	onChange: (value: string) => void;
	onBlur: () => void;
}

export function TextField({
	field,
	state,
	labelledBy,
	onChange,
	onBlur,
}: TextFieldProps) {
	// `secret` kind renders a password-masked input; `text` is plain.
	const inputType = field.kind === "secret" ? "password" : "text";
	// A Text question with a number keypad asks a phone for its telephone
	// keypad, as Web Apps' `PhoneEntry` does; on both platforms the engine
	// decides what the answer keeps.
	const numberKeypad = field.kind === "text" && field.keypad !== undefined;
	const showError = state.touched && !state.valid;

	return (
		<div>
			<input
				type={inputType}
				inputMode={numberKeypad ? "tel" : undefined}
				aria-labelledby={labelledBy}
				aria-invalid={showError || undefined}
				value={state.value}
				onChange={(e) => onChange(e.target.value)}
				onBlur={onBlur}
				placeholder=""
				autoComplete="off"
				data-1p-ignore
				className={`nova-focusable w-full h-11 px-3 rounded-lg bg-pv-input-bg border text-sm text-nova-text placeholder:text-nova-text-muted outline-none transition-colors ${
					showError ? "border-nova-rose/50" : "border-pv-input-border"
				}`}
			/>
			{showError && state.errorMessage && (
				<ValidationError message={state.errorMessage} />
			)}
		</div>
	);
}
