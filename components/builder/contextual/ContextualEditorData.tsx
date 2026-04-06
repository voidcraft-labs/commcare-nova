"use client";
import { useCallback } from "react";
import { EditableText } from "@/components/builder/EditableText";
import { useSaveQuestion } from "@/hooks/useSaveQuestion";
import { CasePropertyDropdown } from "./CasePropertyDropdown";
import { OptionsEditor } from "./OptionsEditor";
import {
	type FocusableFieldKey,
	getModuleCaseTypes,
	MEDIA_TYPES,
	type QuestionEditorProps,
	useFocusHint,
} from "./shared";

/** Field keys owned by the Data section — only these trigger focusHint clearing. */
const DATA_FIELDS = new Set<FocusableFieldKey>([
	"id",
	"case_property_on",
	"options",
]);

export function ContextualEditorData({
	question,
	builder,
}: QuestionEditorProps) {
	const selected = builder.selected;
	const mb = builder.mb;

	const _saveQuestion = useSaveQuestion(builder);
	const focusHint = useFocusHint(builder, DATA_FIELDS);

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
				dataFieldId="id"
				value={question.id}
				onSave={(v) => {
					renameQuestion(v);
					builder.clearNewQuestion();
				}}
				mono
				color="text-nova-violet-bright"
				autoFocus={focusHint === "id"}
				selectAll={
					!!selected.questionUuid &&
					builder.isNewQuestion(selected.questionUuid)
				}
			/>
			<div data-field-id="case_property_on">
				<CasePropertyDropdown
					value={question.case_property_on}
					isCaseName={question.id === "case_name"}
					disabled={MEDIA_TYPES.has(question.type)}
					caseTypes={getModuleCaseTypes(mb, selected.moduleIndex)}
					onChange={setCasePropertyOn}
					autoFocus={focusHint === "case_property_on"}
				/>
			</div>
			{(question.type === "single_select" ||
				question.type === "multi_select") && (
				<div data-field-id="options">
					<OptionsEditor
						options={question.options ?? []}
						autoFocus={focusHint === "options"}
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
				</div>
			)}
		</div>
	);
}
