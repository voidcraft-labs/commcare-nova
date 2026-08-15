// components/preview/shared/useColumnDisplayContext.ts
//
// The display context every running case-list surface projects its cells
// through: the Results list, the Quick Filter that has to match what
// those cells say, and the tile pinned above a module's forms. One
// derivation, so option labels, calculated temporal semantics, and the
// current day can never differ between two surfaces showing one case.

"use client";
import { useMemo } from "react";
import {
	type CalculatedTemporalType,
	type ColumnDisplayContext,
	resolveCalculatedTemporalType,
} from "@/components/builder/case-list-config/columnCellRenderer";
import { useLocalizedValues } from "@/components/builder/localization/BuilderLocalizationProvider";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import {
	type CaseListConfig,
	type CaseProperty,
	type Column,
	type LocalizedValue,
	makeTranslationUnitId,
	type TranslationUnitId,
} from "@/lib/domain";
import { useLocalCalendarDay } from "@/lib/ui/hooks/useLocalCalendarDay";

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
			options: property.options?.map((option) => {
				const localized = localizedValues.get(
					makeTranslationUnitId(
						"case-property-option",
						currentCaseType,
						property.name,
						option.value,
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
 * `fallbackProperties` covers the window where the effective view has no
 * entry for the module's case type yet; the materializable catalog the
 * caller already holds is the closest honest stand-in.
 */
export function useColumnDisplayContext(
	config: CaseListConfig | undefined,
	currentCaseType: string | undefined,
	fallbackProperties: readonly CaseProperty[],
): ColumnDisplayContext {
	const effectiveCaseTypes = useEffectiveCaseTypes();
	const effectiveCaseType = effectiveCaseTypes.find(
		(candidate) => candidate.name === currentCaseType,
	);
	const localizedValues = useLocalizedValues();
	const caseProperties = useMemo(
		() =>
			projectLocalizedCaseProperties(
				currentCaseType,
				effectiveCaseType?.properties ?? fallbackProperties,
				localizedValues,
			),
		[
			currentCaseType,
			effectiveCaseType?.properties,
			fallbackProperties,
			localizedValues,
		],
	);
	const today = useLocalCalendarDay();
	const projectProse = useProseProjection();
	const calculatedTemporalTypes = useMemo(() => {
		const types = new Map<Column["uuid"], CalculatedTemporalType>();
		if (config === undefined) return types;
		const typeContext = {
			caseTypes: [...effectiveCaseTypes],
			currentCaseType: effectiveCaseType?.name,
			// Calculated-column expressions cannot read worker search inputs.
			// Keeping this empty matches their validator slot constraint.
			knownInputs: [],
		};
		for (const column of config.columns) {
			const temporalType = resolveCalculatedTemporalType(column, typeContext);
			if (temporalType !== undefined) types.set(column.uuid, temporalType);
		}
		return types;
	}, [config, effectiveCaseType?.name, effectiveCaseTypes]);
	return useMemo(
		() => ({
			calculatedTemporalTypes,
			caseProperties,
			today,
			projectProse,
		}),
		[calculatedTemporalTypes, caseProperties, today, projectProse],
	);
}
