"use client";
import { EditableText } from "@/components/builder/EditableText";
import { useSaveQuestion } from "@/hooks/useSaveQuestion";
import type { Question } from "@/lib/schemas/blueprint";
import type { QuestionPath } from "@/lib/services/questionPath";
import { AddPropertyButton } from "./AddPropertyButton";
import {
	addableTextFields,
	type FocusableFieldKey,
	type QuestionEditorProps,
	useAddableField,
	useFocusHint,
} from "./shared";

/** Field keys owned by the Appearance section. */
const UI_FIELDS = new Set<FocusableFieldKey>(["hint"]);

/**
 * Appearance section — hint field and add-hint button.
 * Hidden questions never render this component; the parent
 * `InlineSettingsPanel` skips the section entirely for them.
 */
export function ContextualEditorUI({ question, builder }: QuestionEditorProps) {
	const selected = builder.selected;
	const saveQuestion = useSaveQuestion(builder);
	const { activeField, activate, clear } = useAddableField(
		selected?.questionPath ?? ("" as QuestionPath),
	);

	const focusHint = useFocusHint(builder, UI_FIELDS);

	if (!selected) return null;

	/** Text fields not yet set on this question, available to add. */
	const missingTextFields = addableTextFields.filter(
		(f) =>
			f.field === "hint" &&
			!question[f.field as keyof Question] &&
			activeField !== f.field &&
			focusHint !== "hint",
	);

	return (
		<div className="space-y-3">
			{(question.hint || activeField === "hint" || focusHint === "hint") && (
				<EditableText
					label="Hint"
					dataFieldId="hint"
					value={question.hint ?? ""}
					onSave={(v) => {
						saveQuestion("hint", v || null);
						clear();
					}}
					autoFocus={activeField === "hint" || focusHint === "hint"}
					onEmpty={activeField === "hint" ? clear : undefined}
				/>
			)}
			{missingTextFields.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{missingTextFields.map(({ field, label }) => (
						<AddPropertyButton
							key={field}
							label={label}
							onClick={() => activate(field)}
						/>
					))}
				</div>
			)}
		</div>
	);
}
