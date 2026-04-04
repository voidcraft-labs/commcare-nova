"use client";
import { PreviewMarkdown } from "@/lib/markdown";
import type { QuestionState } from "@/lib/preview/engine/types";
import type { Question } from "@/lib/schemas/blueprint";
import { ValidationError } from "./ValidationError";

interface SelectMultiFieldProps {
	question: Question;
	state: QuestionState;
	onChange: (value: string) => void;
	onBlur: () => void;
}

/**
 * Multi-select checkbox field for form preview. Each option renders a real
 * `<input type="checkbox">` (visually hidden via sr-only) inside a `<label>`,
 * so native click-to-toggle and keyboard interaction work without custom
 * onClick handlers. The outer `<fieldset>` groups the checkboxes semantically
 * and captures `onBlur` for touch tracking.
 */
export function SelectMultiField({
	question,
	state,
	onChange,
	onBlur,
}: SelectMultiFieldProps) {
	const options = question.options ?? [];
	const selected = new Set(state.value ? state.value.split(" ") : []);
	const showError = state.touched && !state.valid;

	const toggle = (optValue: string) => {
		const next = new Set(selected);
		if (next.has(optValue)) next.delete(optValue);
		else next.add(optValue);
		onChange([...next].join(" "));
	};

	return (
		<fieldset className="m-0 border-none p-0" onBlur={onBlur}>
			<div className="space-y-1.5">
				{options.map((opt) => {
					const checked = selected.has(opt.value);
					const inputId = `${state.path}-${opt.value}`;
					return (
						<label
							key={opt.value}
							htmlFor={inputId}
							className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
								checked
									? "bg-pv-accent/10 border border-pv-accent/30"
									: showError
										? "bg-pv-input-bg border border-nova-rose/30 hover:border-nova-rose/50"
										: "bg-pv-input-bg border border-pv-input-border hover:border-pv-input-focus"
							}`}
						>
							<input
								id={inputId}
								type="checkbox"
								checked={checked}
								onChange={() => toggle(opt.value)}
								className="sr-only"
								autoComplete="off"
								data-1p-ignore
							/>
							<div
								className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${
									checked
										? "border-pv-accent bg-pv-accent"
										: "border-nova-text-muted"
								}`}
							>
								{checked && (
									<svg
										aria-hidden="true"
										width="10"
										height="10"
										viewBox="0 0 10 10"
										fill="none"
									>
										<path
											d="M2 5L4 7L8 3"
											stroke="white"
											strokeWidth="1.5"
											strokeLinecap="round"
											strokeLinejoin="round"
										/>
									</svg>
								)}
							</div>
							<span className="preview-markdown text-sm text-nova-text">
								<PreviewMarkdown inline>{opt.label}</PreviewMarkdown>
							</span>
						</label>
					);
				})}
			</div>
			{showError && state.errorMessage && (
				<ValidationError message={state.errorMessage} />
			)}
		</fieldset>
	);
}
