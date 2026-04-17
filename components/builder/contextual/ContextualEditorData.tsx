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
	const { updateField } = useBlueprintMutations();

	const focusHint = useFocusHint(DATA_FIELDS);

	const setCasePropertyOn = useCallback(
		(caseType: string | null) => {
			if (!question.uuid) return;
			// Domain rename: `case_property_on` on the wire-format Question →
			// `case_property` on the domain Field. The patch goes through
			// `updateField` which accepts a `FieldPatch` union-wide partial.
			updateField(asUuid(question.uuid), {
				case_property: caseType ?? undefined,
			});
		},
		[question.uuid, updateField],
	);

	if (!ctx) return null;

	const writableCaseTypes = getModuleCaseTypes(ctx.module.caseType, caseTypes);
	const isCaseName = question.id === "case_name";
	const hasOptions =
		question.kind === "single_select" || question.kind === "multi_select";
	const hasCaseProperty = writableCaseTypes.length > 0 || isCaseName;

	/* Nothing to show — ID lives in the header, and neither case property
	 * dropdown nor options editor applies to this field. The entire
	 * section card is omitted so the parent doesn't need to know what
	 * fields live here. */
	if (!hasCaseProperty && !hasOptions) return null;

	// `case_property` is absent on kinds that can't write to the case
	// (label, group, repeat, and media kinds). Narrow with `in` before
	// reading so the discriminated union stays sound.
	const caseProperty =
		"case_property" in question ? question.case_property : undefined;

	return (
		<div className={SECTION_CARD_CLASS}>
			<SectionLabel label="Data" />
			<div className="space-y-3">
				<div data-field-id="case_property_on">
					<CasePropertyDropdown
						value={caseProperty}
						isCaseName={isCaseName}
						disabled={MEDIA_TYPES.has(question.kind)}
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
								updateField(asUuid(question.uuid), {
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
