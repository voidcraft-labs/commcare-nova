"use client";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { DecimalField, IntField } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { usePreviewPlatformRules } from "@/lib/session/hooks";
import { ValidationError } from "./ValidationError";
import { workerKeyboard } from "./WorkerKeyboard";

interface NumberFieldProps {
	/** The answer type also selects the mobile keyboard. */
	field: IntField | DecimalField;
	state: FieldState;
	/** Visible question label rendered by InteractiveFormRenderer. */
	labelledBy?: string;
	onChange: (value: string) => void;
	onBlur: () => void;
}

export function NumberField({
	field,
	state,
	labelledBy,
	onChange,
	onBlur,
}: NumberFieldProps) {
	const rules = usePreviewPlatformRules();
	const project = useProseProjection();
	const hint = field.extended_hint ?? field.hint;
	const showError = state.touched && !state.valid;

	return (
		<div>
			<input
				{...workerKeyboard(field, rules.keyboardAction)}
				type="text"
				inputMode={field.kind === "int" ? "numeric" : "decimal"}
				aria-labelledby={labelledBy}
				aria-invalid={showError || undefined}
				// Keep incomplete answers visible. Native number inputs can turn
				// malformed text into an empty value before the engine sees it.
				value={state.value}
				onChange={(e) => onChange(e.target.value)}
				onBlur={onBlur}
				placeholder={
					rules.hintPlacement === "as-authored" &&
					field.hintPlacement === "placeholder" &&
					hint
						? (state.resolvedHint ?? project(hint))
						: undefined
				}
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
