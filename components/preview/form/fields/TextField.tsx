"use client";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { SecretField, TextField as TextFieldEntity } from "@/lib/domain";
import { usesNumberKeypad } from "@/lib/domain/questionDisplay";
import type { FieldState } from "@/lib/preview/engine/types";
import {
	usePreviewPlatform,
	usePreviewPlatformRules,
} from "@/lib/session/hooks";
import { ValidationError } from "./ValidationError";
import { workerKeyboard } from "./WorkerKeyboard";

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
	const platform = usePreviewPlatform();
	const rules = usePreviewPlatformRules();
	const project = useProseProjection();
	const numberKeypad = usesNumberKeypad(field, platform);
	const inputType =
		field.kind === "secret" &&
		!(rules.secretKeypad === "visible" && numberKeypad)
			? "password"
			: "text";
	const hint = field.extended_hint ?? field.hint;
	const showError = state.touched && !state.valid;

	return (
		<div>
			<input
				{...workerKeyboard(field, rules.keyboardAction)}
				type={inputType}
				inputMode={numberKeypad ? "tel" : undefined}
				aria-labelledby={labelledBy}
				aria-invalid={showError || undefined}
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
