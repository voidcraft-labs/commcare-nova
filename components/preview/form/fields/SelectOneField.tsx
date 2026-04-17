"use client";
import type { SingleSelectField } from "@/lib/domain";
import { PreviewMarkdown } from "@/lib/markdown";
import type { FieldState } from "@/lib/preview/engine/types";
import { ValidationError } from "./ValidationError";

interface SelectOneFieldProps {
	/** A single-select field; `options` is required on this kind. */
	question: SingleSelectField;
	state: FieldState;
	onChange: (value: string) => void;
	onBlur: () => void;
}

/**
 * Single-select radio field for form preview. Each option renders a real
 * `<input type="radio">` (visually hidden via sr-only) inside a `<label>`.
 * The outer `<fieldset>` groups the radios semantically and captures `onBlur`
 * for touch tracking.
 */
export function SelectOneField({
	question,
	state,
	onChange,
	onBlur,
}: SelectOneFieldProps) {
	const options = question.options ?? [];
	const showError = state.touched && !state.valid;

	return (
		<fieldset className="m-0 border-none p-0" onBlur={onBlur}>
			<div className="space-y-1.5">
				{options.map((opt) => (
					<label
						key={opt.value}
						className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
							state.value === opt.value
								? "bg-pv-accent/10 border border-pv-accent/30"
								: showError
									? "bg-pv-input-bg border border-nova-rose/30 hover:border-nova-rose/50"
									: "bg-pv-input-bg border border-pv-input-border hover:border-pv-input-focus"
						}`}
					>
						<input
							type="radio"
							name={state.path}
							value={opt.value}
							checked={state.value === opt.value}
							onChange={() => onChange(opt.value)}
							className="sr-only"
						/>
						<div
							className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
								state.value === opt.value
									? "border-pv-accent"
									: "border-nova-text-muted"
							}`}
						>
							{state.value === opt.value && (
								<div className="w-2 h-2 rounded-full bg-pv-accent" />
							)}
						</div>
						<span className="preview-markdown text-sm text-nova-text">
							<PreviewMarkdown inline>{opt.label}</PreviewMarkdown>
						</span>
					</label>
				))}
			</div>
			{showError && state.errorMessage && (
				<ValidationError message={state.errorMessage} />
			)}
		</fieldset>
	);
}
