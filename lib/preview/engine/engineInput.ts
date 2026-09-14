import {
	type BlueprintDoc,
	caseSelectionCardinality,
	type LanguageTag,
	materializableCaseTypes,
	moduleUuidOfForm,
	projectLocalizedFields,
	resolveAppLanguage,
	type Uuid,
} from "@/lib/domain";
import type { FormEngineInput } from "./formEngine";

/** The same form, localization and runtime catalogs for every engine host. */
export function buildEngineInput(
	doc: BlueprintDoc,
	formUuid: Uuid,
	language: LanguageTag | null,
): FormEngineInput | undefined {
	const form = doc.forms[formUuid];
	if (!form) return;
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const module = moduleUuid ? doc.modules[moduleUuid] : undefined;
	const resolved =
		language === null
			? undefined
			: resolveAppLanguage(doc.localization, language);
	return {
		form,
		formUuid,
		...(resolved === undefined ? {} : { language: resolved }),
		fields:
			resolved === undefined
				? doc.fields
				: projectLocalizedFields(doc, resolved),
		fieldOrder: doc.fieldOrder,
		caseTypes: materializableCaseTypes(doc),
		caseSelectionCardinality: module
			? caseSelectionCardinality(module)
			: "single",
		userProperties: doc.userProperties,
		...(module?.caseListConfig
			? {
					searchInputs: module.caseListConfig.searchInputs.map(
						({ uuid, name }) => ({ uuid, name }),
					),
				}
			: {}),
	};
}
