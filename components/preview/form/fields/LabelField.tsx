"use client";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import type { LabelField as Message } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";
import { useEditMode, usePreviewPlatformRules } from "@/lib/session/hooks";
import { ValidationError } from "./ValidationError";

/**
 * A message's own control: Android's confirmation checkbox where the message
 * asks for one, and the message's validation line. A required confirmation
 * left unchecked and a failing validation show their line on either platform
 * the moment the worker's turn checks them.
 */
export function LabelField({
	field,
	state,
	onChange,
	onBlur,
}: {
	field: Message;
	state: FieldState;
	onChange: (value: string) => void;
	onBlur: () => void;
}) {
	const rules = usePreviewPlatformRules();
	const isEditMode = useEditMode() === "edit";
	const { language } = useBuilderLanguage();
	const confirmable =
		field.askForConfirmation === true &&
		rules.messageConfirmation === "checkbox";
	const showError = state.touched && !state.valid;
	const error =
		showError && state.errorMessage ? (
			<ValidationError message={state.errorMessage} />
		) : null;
	if (!confirmable) return error;
	return (
		<>
			<label className="pv-choice-row inline-flex items-center gap-2 px-2 py-1">
				<input
					type="checkbox"
					className="accent-pv-accent"
					checked={state.value === "OK"}
					disabled={isEditMode}
					aria-invalid={showError || undefined}
					onBlur={onBlur}
					onChange={(event) => onChange(event.target.checked ? "OK" : "")}
				/>
				{runtimeMessage(language, "confirmMessage")}
			</label>
			{error}
		</>
	);
}
