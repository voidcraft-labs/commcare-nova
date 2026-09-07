import {
	type CaseProperty,
	casePropertyOptionOccurrence,
	casePropertyOptionTranslationUnitId,
	type LocalizedValue,
	type TranslationUnitId,
} from "@/lib/domain";

/** Project option labels through the same selected-language lens as the rest
 * of Preview while retaining the effective catalog's structural data type. */
export function projectLocalizedCaseProperties(
	currentCaseType: string | undefined,
	properties: readonly CaseProperty[],
	localizedValues: ReadonlyMap<TranslationUnitId, LocalizedValue>,
): readonly CaseProperty[] {
	if (currentCaseType === undefined) return properties;
	return properties.map((property) => {
		if (
			property.data_type !== "single_select" &&
			property.data_type !== "multi_select"
		)
			return property;
		return {
			...property,
			options: property.options?.map((option, index, options) => {
				const localized = localizedValues.get(
					casePropertyOptionTranslationUnitId(
						currentCaseType,
						property.name,
						option.value,
						casePropertyOptionOccurrence(options, index),
					),
				);
				return typeof localized === "object" && localized !== null
					? { ...option, label: localized }
					: option;
			}),
		};
	});
}
