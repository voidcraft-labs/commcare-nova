"use client";
import { EditableText } from "@/components/builder/EditableText";
import {
	SECTION_CARD_CLASS,
	SectionLabel,
} from "@/components/builder/InlineSettingsPanel";
import { useBuilderStore } from "@/hooks/useBuilder";
import { useSaveQuestion } from "@/hooks/useSaveQuestion";
import type { Question } from "@/lib/schemas/blueprint";
import type { QuestionPath } from "@/lib/services/questionPath";
import { AddPropertyButton } from "./AddPropertyButton";
import {
	addableTextFields,
	type FocusableFieldKey,
	fieldSupportedForType,
	type QuestionEditorProps,
	useAddableField,
	useFocusHint,
} from "./shared";

/** Field keys owned by the Appearance section. */
const UI_FIELDS = new Set<FocusableFieldKey>(["hint"]);

/**
 * Appearance section — hint field and add-hint button.
 * Self-contained: wraps its own section card and returns null when the
 * question type has no applicable appearance fields (hidden, label,
 * group, repeat). Mirrors `ContextualEditorData`'s visibility pattern.
 */
export function ContextualEditorUI({ question }: QuestionEditorProps) {
	const selected = useBuilderStore((s) => s.selected);
	const saveQuestion = useSaveQuestion();
	const { activeField, activate, clear } = useAddableField(
		selected?.questionPath ?? ("" as QuestionPath),
	);

	const focusHint = useFocusHint(UI_FIELDS);

	if (!selected) return null;

	/* Hint only applies to user-input types — labels are display-only,
	 * groups/repeats are containers, hidden fields aren't visible. */
	if (!fieldSupportedForType("hint", question.type)) return null;

	/** Text fields not yet set on this question, available to add. */
	const missingTextFields = addableTextFields.filter(
		(f) =>
			f.field === "hint" &&
			!question[f.field as keyof Question] &&
			activeField !== f.field &&
			focusHint !== "hint",
	);

	return (
		<div className={SECTION_CARD_CLASS}>
			<SectionLabel label="Appearance" />
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
		</div>
	);
}
