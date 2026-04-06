"use client";
import { useCallback } from "react";
import { EditableText } from "@/components/builder/EditableText";
import {
	useBuilderEngine,
	useBuilderStore,
	useModule,
} from "@/hooks/useBuilder";
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

export function ContextualEditorData({ question }: QuestionEditorProps) {
	const engine = useBuilderEngine();
	const selected = useBuilderStore((s) => s.selected);
	const caseTypes = useBuilderStore((s) => s.caseTypes);
	const mod = useModule(selected?.moduleIndex ?? 0);
	const updateQuestion = useBuilderStore((s) => s.updateQuestion);
	const renameQuestionAction = useBuilderStore((s) => s.renameQuestion);

	const _saveQuestion = useSaveQuestion();
	const focusHint = useFocusHint(DATA_FIELDS);

	const setCasePropertyOn = useCallback(
		(caseType: string | null) => {
			if (
				!selected ||
				selected.formIndex === undefined ||
				!selected.questionPath
			)
				return;
			updateQuestion(
				selected.moduleIndex,
				selected.formIndex,
				selected.questionPath,
				{
					case_property_on: caseType,
				},
			);
		},
		[selected, updateQuestion],
	);

	const handleRename = useCallback(
		(newId: string) => {
			if (
				!selected ||
				selected.formIndex === undefined ||
				!selected.questionPath ||
				!newId
			)
				return;
			const { newPath } = renameQuestionAction(
				selected.moduleIndex,
				selected.formIndex,
				selected.questionPath,
				newId,
			);
			engine.select({ ...selected, questionPath: newPath });
		},
		[selected, renameQuestionAction, engine],
	);

	if (!selected) return null;

	return (
		<div className="space-y-3">
			<EditableText
				label="ID"
				dataFieldId="id"
				value={question.id}
				onSave={(v) => {
					handleRename(v);
					engine.clearNewQuestion();
				}}
				mono
				color="text-nova-violet-bright"
				autoFocus={focusHint === "id"}
				selectAll={
					!!selected.questionUuid && engine.isNewQuestion(selected.questionUuid)
				}
			/>
			<div data-field-id="case_property_on">
				<CasePropertyDropdown
					value={question.case_property_on}
					isCaseName={question.id === "case_name"}
					disabled={MEDIA_TYPES.has(question.type)}
					caseTypes={getModuleCaseTypes(mod?.caseType, caseTypes)}
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
							if (
								!selected ||
								selected.formIndex === undefined ||
								!selected.questionPath
							)
								return;
							updateQuestion(
								selected.moduleIndex,
								selected.formIndex,
								selected.questionPath,
								{ options: options.length > 0 ? options : null },
							);
						}}
					/>
				</div>
			)}
		</div>
	);
}
