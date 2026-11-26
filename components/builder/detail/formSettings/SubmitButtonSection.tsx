"use client";

import {
	useBuilderLanguage,
	useLocalizedText,
	useTranslationUnitEditor,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { makeTranslationUnitId, type Uuid } from "@/lib/domain";
import { InlineField } from "./InlineField";

export function SubmitButtonSection({ formUuid }: { formUuid: Uuid }) {
	const form = useForm(formUuid);
	const { inline } = useBlueprintMutations();
	const { isSource } = useBuilderLanguage();
	const id = makeTranslationUnitId("form", formUuid, "submit-label");
	const editor = useTranslationUnitEditor(id);
	const translated = useLocalizedText(id);
	if (!form || (!isSource && !form.submitLabel)) return null;
	return (
		<InlineField
			label="Submit button in Web Apps"
			value={isSource ? (form.submitLabel?.text ?? "") : (translated ?? "")}
			placeholder="Submit"
			onChange={(text) =>
				isSource
					? inline.updateForm(formUuid, {
							submitLabel: text === "" ? {} : { text },
						})
					: editor.saveTarget(text)
			}
		/>
	);
}
