"use client";
import type { SecretField, TextField as TextFieldEntity } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { ValidationError } from "./ValidationError";

interface TextFieldProps {
	/** Plain text or secret field. The DOM input type differs by kind. */
	question: TextFieldEntity | SecretField;
	state: FieldState;
	onChange: (value: string) => void;
	onBlur: () => void;
}

export function TextField({
	question,
	state,
	onChange,
	onBlur,
}: TextFieldProps) {
	// `secret` kind renders a password-masked input; `text` is plain.
	const inputType = question.kind === "secret" ? "password" : "text";
	const showError = state.touched && !state.valid;

	return (
		<div>
			<input
				type={inputType}
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
