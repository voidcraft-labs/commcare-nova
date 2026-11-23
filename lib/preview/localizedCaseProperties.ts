import {
	type CaseListConfig,
	type CaseProperty,
	type CaseType,
	type Column,
	casePropertyOptionOccurrence,
	casePropertyOptionTranslationUnitId,
	columnPropertyCaseType,
	type LocalizedValue,
	type TranslationUnitId,
} from "@/lib/domain";

import { propertiesReachedByColumn } from "@/lib/domain/columnRelation";

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

/**
 * The catalog entry each property column read through a relation shows, by
 * column: the property of the type its walk reaches, its option labels in
 * the selected language. A column whose walk reaches no type, or whose type
 * holds no such property, maps to undefined.
 */
export function relatedColumnProperties(
	config: CaseListConfig | undefined,
	listCaseType: string | undefined,
	caseTypes: readonly CaseType[],
	localizedValues: ReadonlyMap<TranslationUnitId, LocalizedValue>,
): ReadonlyMap<Column["uuid"], CaseProperty | undefined> {
	const out = new Map<Column["uuid"], CaseProperty | undefined>();
	for (const column of config?.columns ?? []) {
		if (
			column.kind === "calculated" ||
			(column.via === undefined && !column.readFrom)
		)
			continue;
		const reached = columnPropertyCaseType(column, listCaseType, caseTypes);
		const properties = propertiesReachedByColumn(
			column,
			listCaseType,
			caseTypes,
			column.field,
		);
		out.set(
			column.uuid,
			projectLocalizedCaseProperties(reached, properties, localizedValues).find(
				(property) => property.name === column.field,
			),
		);
	}
	return out;
}
