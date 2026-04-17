"use client";
import { EditableText } from "@/components/builder/EditableText";
import {
	SECTION_CARD_CLASS,
	SectionLabel,
} from "@/components/builder/InlineSettingsPanel";
import { useSaveQuestion } from "@/hooks/useSaveQuestion";
import { useSelectedQuestion } from "@/lib/routing/hooks";
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
 * field kind has no applicable appearance fields (hidden, label, group,
 * repeat). Mirrors `ContextualEditorData`'s visibility pattern.
 */
export function ContextualEditorUI({ question }: QuestionEditorProps) {
	const selected = useSelectedQuestion();
	const saveQuestion = useSaveQuestion(selected?.uuid);
	const { activeField, activate, clear } = useAddableField(
		selected?.uuid ?? "",
	);

	const focusHint = useFocusHint(UI_FIELDS);

	if (!selected) return null;

	/* Hint only applies to user-input kinds — labels are display-only,
	 * groups/repeats are containers, hidden fields aren't visible. */
	if (!fieldSupportedForType("hint", question.kind)) return null;

	// `hint` is absent from structural kinds (group/repeat/label/hidden).
	// Narrow with `in` so the read is sound; structural kinds already bail
	// above via `fieldSupportedForType`, so this guard is belt-and-braces.
	const currentHint =
		"hint" in question && typeof question.hint === "string"
			? question.hint
			: undefined;

	/** Text fields not yet set on this field, available to add. */
	const missingTextFields = addableTextFields.filter(
		(f) =>
			f.field === "hint" &&
			!currentHint &&
			activeField !== f.field &&
			focusHint !== "hint",
	);

	return (
		<div className={SECTION_CARD_CLASS}>
			<SectionLabel label="Appearance" />
			<div className="space-y-3">
				{(currentHint || activeField === "hint" || focusHint === "hint") && (
					<EditableText
						label="Hint"
						dataFieldId="hint"
						value={currentHint ?? ""}
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
