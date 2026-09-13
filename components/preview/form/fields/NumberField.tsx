"use client";
import type { DecimalField, IntField } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { ValidationError } from "./ValidationError";

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
	const showError = state.touched && !state.valid;

	return (
		<div>
			<input
				type="text"
				inputMode={field.kind === "int" ? "numeric" : "decimal"}
				aria-labelledby={labelledBy}
				aria-invalid={showError || undefined}
				// Keep incomplete answers visible. Native number inputs can turn
				// malformed text into an empty value before the engine sees it.
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
				<ValidationError
					message={state.errorMessage}
					media={
						"validate_msg_media" in field ? field.validate_msg_media : undefined
					}
				/>
			)}
		</div>
	);
}
