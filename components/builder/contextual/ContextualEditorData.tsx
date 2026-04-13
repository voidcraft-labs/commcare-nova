"use client";
import { useCallback } from "react";
import {
	SECTION_CARD_CLASS,
	SectionLabel,
} from "@/components/builder/InlineSettingsPanel";
import { useBuilderStore, useModule } from "@/hooks/useBuilder";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
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
const DATA_FIELDS = new Set<FocusableFieldKey>(["case_property_on", "options"]);

export function ContextualEditorData({ question }: QuestionEditorProps) {
	const selected = useBuilderStore((s) => s.selected);
	const caseTypes = useBlueprintDoc((s) => s.caseTypes ?? []);
	const mod = useModule(selected?.moduleIndex ?? 0);
	const { updateQuestion } = useBlueprintMutations();

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

	if (!selected) return null;

	const writableCaseTypes = getModuleCaseTypes(mod?.caseType, caseTypes);
	const isCaseName = question.id === "case_name";
	const hasOptions =
		question.type === "single_select" || question.type === "multi_select";
	const hasCaseProperty = writableCaseTypes.length > 0 || isCaseName;

	/* Nothing to show — ID lives in the header, and neither case property
	 * dropdown nor options editor applies to this question. The entire
	 * section card is omitted so the parent doesn't need to know what
	 * fields live here. */
	if (!hasCaseProperty && !hasOptions) return null;

	return (
		<div className={SECTION_CARD_CLASS}>
			<SectionLabel label="Data" />
			<div className="space-y-3">
				<div data-field-id="case_property_on">
					<CasePropertyDropdown
						value={question.case_property_on}
						isCaseName={isCaseName}
						disabled={MEDIA_TYPES.has(question.type)}
						caseTypes={writableCaseTypes}
						onChange={setCasePropertyOn}
						autoFocus={focusHint === "case_property_on"}
					/>
				</div>
				{hasOptions && (
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
		</div>
	);
}
