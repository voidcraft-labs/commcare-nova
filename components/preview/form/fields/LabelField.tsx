"use client";
import { useEditContext } from "@/hooks/useEditContext";
import { useTextEditSave } from "@/hooks/useTextEditSave";
import type { QuestionState } from "@/lib/preview/engine/types";
import { LabelContent } from "@/lib/references/LabelContent";
import type { Question } from "@/lib/schemas/blueprint";
import { FIELD_STYLES } from "../fieldStyles";
import { TextEditable } from "../TextEditable";

export function LabelField({
	question,
	state,
}: {
	question: Question;
	state: QuestionState;
}) {
	const ctx = useEditContext();
	const isEditMode = ctx?.mode === "edit";
	const saveField = useTextEditSave(question.uuid);

	return (
		<div className="py-1">
			<TextEditable
				value={question.label ?? ""}
				onSave={saveField ? (v) => saveField("label", v) : undefined}
				fieldType="label"
			>
				<LabelContent
					label={question.label ?? ""}
					resolvedLabel={state.resolvedLabel}
					isEditMode={isEditMode}
					className={FIELD_STYLES.label}
				/>
			</TextEditable>
			{question.hint && (
				<div className="mt-0.5">
					<TextEditable
						value={question.hint}
						onSave={saveField ? (v) => saveField("hint", v) : undefined}
						fieldType="hint"
					>
						<LabelContent
							label={question.hint}
							resolvedLabel={state.resolvedHint}
							isEditMode={isEditMode}
							className={FIELD_STYLES.hint}
						/>
					</TextEditable>
				</div>
			)}
		</div>
	);
}
