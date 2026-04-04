"use client";
import type { Question } from "@/lib/schemas/blueprint";
import type { QuestionState } from "@/lib/preview/engine/types";
import { ValidationError } from "./ValidationError";

interface TextFieldProps {
	question: Question;
	state: QuestionState;
	onChange: (value: string) => void;
	onBlur: () => void;
}

export function TextField({
	question,
	state,
	onChange,
	onBlur,
}: TextFieldProps) {
	const inputType = question.type === "secret" ? "password" : "text";
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
