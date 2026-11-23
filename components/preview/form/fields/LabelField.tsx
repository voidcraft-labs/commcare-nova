"use client";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import type { LabelField as Message } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";
import { useEditMode, usePreviewPlatformRules } from "@/lib/session/hooks";

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
	if (!field.askForConfirmation || rules.messageConfirmation !== "checkbox")
		return null;
	return (
		<label className="pv-choice-row inline-flex items-center gap-2 px-2 py-1">
			<input
				type="checkbox"
				className="accent-pv-accent"
				checked={state.value === "OK"}
				disabled={isEditMode}
				onBlur={onBlur}
				onChange={(event) => onChange(event.target.checked ? "OK" : "")}
			/>
			{runtimeMessage(language, "confirmMessage")}
		</label>
	);
}
