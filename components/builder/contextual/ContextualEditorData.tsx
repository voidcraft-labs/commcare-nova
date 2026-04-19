"use client";
import { useCallback } from "react";
import { CasePropertyDropdown } from "@/components/builder/editor/fields/CasePropertyEditor";
import { OptionsEditorWidget } from "@/components/builder/editor/fields/OptionsEditor";
import {
	SECTION_CARD_CLASS,
	SectionLabel,
} from "@/components/builder/editor/sectionChrome";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { asUuid } from "@/lib/doc/types";
import { type FieldKind, getModuleCaseTypes } from "@/lib/domain";
import { useSelectedFormContext } from "@/lib/routing/hooks";
import {
	type FieldEditorProps,
	type FocusableFieldKey,
	useFocusHint,
} from "./shared";

/** Field keys owned by the Data section — only these trigger focusHint clearing. */
const DATA_FIELDS = new Set<FocusableFieldKey>(["case_property_on", "options"]);

/** Binary/media kinds whose value can't be a case property. */
const MEDIA_TYPES = new Set<FieldKind>([
	"image",
	"audio",
	"video",
	"signature",
]);

export function ContextualEditorData({ field }: FieldEditorProps) {
	const ctx = useSelectedFormContext();
	const caseTypes = useCaseTypes();
	const { updateField } = useBlueprintMutations();

	const focusHint = useFocusHint(DATA_FIELDS);

	const setCasePropertyOn = useCallback(
		(caseType: string | null) => {
			if (!field.uuid) return;
			// Domain rename: `case_property_on` on the wire-format Question →
			// `case_property` on the domain Field. The patch goes through
			// `updateField` which accepts a `FieldPatch` union-wide partial.
			updateField(asUuid(field.uuid), {
				case_property: caseType ?? undefined,
			});
		},
		[field.uuid, updateField],
	);

	if (!ctx) return null;

	const writableCaseTypes = getModuleCaseTypes(ctx.module.caseType, caseTypes);
	const isCaseName = field.id === "case_name";
	const hasOptions =
		field.kind === "single_select" || field.kind === "multi_select";
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
		"case_property" in field ? field.case_property : undefined;

	return (
		<div className={SECTION_CARD_CLASS}>
			<SectionLabel label="Data" />
			<div className="space-y-3">
				<div data-field-id="case_property_on">
					<CasePropertyDropdown
						value={caseProperty}
						isCaseName={isCaseName}
						disabled={MEDIA_TYPES.has(field.kind)}
						caseTypes={writableCaseTypes}
						onChange={setCasePropertyOn}
						autoFocus={focusHint === "case_property_on"}
					/>
				</div>
				{hasOptions && (
					<div data-field-id="options">
						<OptionsEditorWidget
							options={field.options ?? []}
							autoFocus={focusHint === "options"}
							onSave={(options) => {
								if (!field.uuid) return;
								updateField(asUuid(field.uuid), {
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
