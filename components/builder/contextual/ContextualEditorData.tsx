"use client";
import { useCallback } from "react";
import {
	SECTION_CARD_CLASS,
	SectionLabel,
} from "@/components/builder/InlineSettingsPanel";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { asUuid } from "@/lib/doc/types";
import { useSelectedFormContext } from "@/lib/routing/hooks";
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
	const ctx = useSelectedFormContext();
	const caseTypes = useCaseTypes();
	const { updateQuestion } = useBlueprintMutations();

	const focusHint = useFocusHint(DATA_FIELDS);

	const setCasePropertyOn = useCallback(
		(caseType: string | null) => {
			if (!question.uuid) return;
			updateQuestion(asUuid(question.uuid), {
				case_property_on: caseType ?? undefined,
			});
		},
		[question.uuid, updateQuestion],
	);

	if (!ctx) return null;

	const writableCaseTypes = getModuleCaseTypes(ctx.module.caseType, caseTypes);
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
								if (!question.uuid) return;
								updateQuestion(asUuid(question.uuid), {
									options: options.length > 0 ? options : undefined,
								});
							}}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
