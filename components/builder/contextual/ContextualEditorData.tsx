"use client";
import { useCallback } from "react";
import { EditableText } from "@/components/builder/EditableText";
import { useSaveQuestion } from "@/hooks/useSaveQuestion";
import { CasePropertyDropdown } from "./CasePropertyDropdown";
import { OptionsEditor } from "./OptionsEditor";
import {
	getModuleCaseTypes,
	MEDIA_TYPES,
	type QuestionEditorProps,
} from "./shared";

export function ContextualEditorData({
	question,
	builder,
}: QuestionEditorProps) {
	const selected = builder.selected;
	const mb = builder.mb;

	const _saveQuestion = useSaveQuestion(builder);

	const setCasePropertyOn = useCallback(
		(caseType: string | null) => {
			if (
				!selected ||
				!mb ||
				selected.formIndex === undefined ||
				!selected.questionPath
			)
				return;
			mb.updateQuestion(
				selected.moduleIndex,
				selected.formIndex,
				selected.questionPath,
				{
					case_property_on: caseType,
				},
			);
			builder.notifyBlueprintChanged();
		},
		[mb, selected, builder],
	);

	const renameQuestion = useCallback(
		(newId: string) => {
			if (
				!selected ||
				!mb ||
				selected.formIndex === undefined ||
				!selected.questionPath ||
				!newId
			)
				return;
			const { newPath } = mb.renameQuestion(
				selected.moduleIndex,
				selected.formIndex,
				selected.questionPath,
				newId,
			);
			builder.select({ ...selected, questionPath: newPath });
			builder.notifyBlueprintChanged();
		},
		[mb, selected, builder],
	);

	if (!selected || !mb) return null;

	return (
		<div className="space-y-3">
			<EditableText
				label="ID"
				value={question.id}
				onSave={(v) => {
					renameQuestion(v);
					builder.clearNewQuestion();
				}}
				mono
				color="text-nova-violet-bright"
				selectAll={
					!!selected.questionPath &&
					builder.isNewQuestion(selected.questionPath)
				}
			/>
			<CasePropertyDropdown
				value={question.case_property_on}
				isCaseName={question.id === "case_name"}
				disabled={MEDIA_TYPES.has(question.type)}
				caseTypes={getModuleCaseTypes(mb, selected.moduleIndex)}
				onChange={setCasePropertyOn}
			/>
			{(question.type === "single_select" ||
				question.type === "multi_select") && (
				<OptionsEditor
					options={question.options ?? []}
					onSave={(options) => {
						if (selected.formIndex === undefined || !selected.questionPath)
							return;
						mb.updateQuestion(
							selected.moduleIndex,
							selected.formIndex,
							selected.questionPath,
							{
								options: options.length > 0 ? options : null,
							},
						);
						builder.notifyBlueprintChanged();
					}}
				/>
			)}
		</div>
	);
}
