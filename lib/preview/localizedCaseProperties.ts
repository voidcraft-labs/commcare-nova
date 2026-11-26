import {
	type CaseListConfig,
	type CaseProperty,
	type CaseType,
	type Column,
	casePropertyOptionOccurrence,
	casePropertyOptionTranslationUnitId,
	columnPropertyCaseType,
	type LocalizedValue,
	proseText,
	type TranslationUnitId,
} from "@/lib/domain";

import { propertiesReachedByColumn } from "@/lib/domain/columnRelation";
import {
	columnWordingRole,
	generatedWordingId,
	imageDescriptionWordingId,
} from "@/lib/domain/generatedWording";
import type { ColumnDisplayContext } from "./columnDisplay";

/** A detail can use a different option label from the row that opens it.
 * Resolve each option once per screen so the filter and rendered cells agree. */
export function columnOutputWording(
	config: CaseListConfig | undefined,
	listCaseType: string | undefined,
	caseTypes: readonly CaseType[],
	caseProperties: readonly CaseProperty[],
	relatedProperties: NonNullable<ColumnDisplayContext["relatedProperties"]>,
	values: ReadonlyMap<TranslationUnitId, LocalizedValue>,
	search: boolean,
	detail: boolean,
): Pick<ColumnDisplayContext, "columnProperties" | "imageDescription"> {
	const role = columnWordingRole(search, detail);
	const columnProperties = new Map<Column["uuid"], CaseProperty>();
	for (const column of config?.columns ?? []) {
		if (column.kind !== "plain") continue;
		const type = columnPropertyCaseType(column, listCaseType, caseTypes);
		if (type === undefined) continue;
		const property =
			column.via === undefined && !column.readFrom
				? caseProperties.find((p) => p.name === column.field)
				: relatedProperties.get(column.uuid);
		if (!property?.options?.length) continue;
		columnProperties.set(column.uuid, {
			...property,
			options: property.options.map((option, index, options) => {
				const id = casePropertyOptionTranslationUnitId(
					type,
					property.name,
					option.value,
					casePropertyOptionOccurrence(options, index),
				);
				const value = values.get(generatedWordingId(column.uuid, role, id));
				return typeof value === "string"
					? { ...option, label: proseText(value) }
					: option;
			}),
		});
	}
	return {
		columnProperties,
		imageDescription: (column, row) => {
			const text = values.get(imageDescriptionWordingId(column, role, row));
			return typeof text === "string" && text !== "" ? text : undefined;
		},
	};
}

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
