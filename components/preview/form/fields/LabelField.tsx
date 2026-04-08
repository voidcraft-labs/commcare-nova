"use client";
import { useEditContext } from "@/hooks/useEditContext";
import { useTextEditSave } from "@/hooks/useTextEditSave";
import type { QuestionState } from "@/lib/preview/engine/types";
import { LabelContent } from "@/lib/references/LabelContent";
import type { Question } from "@/lib/schemas/blueprint";
import type { QuestionPath } from "@/lib/services/questionPath";
import { FIELD_STYLES } from "../fieldStyles";
import { TextEditable } from "../TextEditable";

export function LabelField({
	question,
	questionPath,
	state,
}: {
	question: Question;
	questionPath?: QuestionPath;
	state: QuestionState;
}) {
	const ctx = useEditContext();
	const isEditMode = ctx?.mode === "edit";
	/* questionPath is undefined when rendered from QuestionField (dead path —
	 * FormRenderer handles labels separately — but TypeScript checks it). */
	const saveField = useTextEditSave(questionPath);

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
