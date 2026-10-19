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
	useBuilderLanguage,
	useLocalizedValues,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useExpressionLookupTypes } from "@/lib/doc/hooks/useExpressionSlotContext";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type {
	BlueprintDoc,
	CaseListConfig,
	CaseProperty,
	Column,
	Uuid,
} from "@/lib/domain";
import { slotContext } from "@/lib/domain/expression/context";
import { caseQueryReadingFor } from "@/lib/domain/expression/temporalType";
import {
	type CalculatedTemporalType,
	type ColumnDisplayContext,
	resolveCalculatedTemporalType,
} from "@/lib/preview/columnDisplay";
import { projectLocalizedCaseProperties } from "@/lib/preview/localizedCaseProperties";
import { useLocalCalendarDay } from "@/lib/ui/hooks/useLocalCalendarDay";

/**
 * `fallbackProperties` covers the window where the effective view has no
 * entry for the module's case type yet; the materializable catalog the
 * caller already holds is the closest honest stand-in.
 */
export function useColumnDisplayContext(
	config: CaseListConfig | undefined,
	currentCaseType: string | undefined,
	fallbackProperties: readonly CaseProperty[],
	owner: { readonly doc: BlueprintDoc; readonly moduleUuid: Uuid },
): ColumnDisplayContext {
	const effectiveCaseTypes = useEffectiveCaseTypes();
	const effectiveCaseType = effectiveCaseTypes.find(
		(candidate) => candidate.name === currentCaseType,
	);
	const localizedValues = useLocalizedValues();
	const { language } = useBuilderLanguage();
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
	const lookupTypes = useExpressionLookupTypes();
	const { doc, moduleUuid } = owner;
	// The running list's rows are casedb rows for a browse list and results
	// rows for an effective Search; the live config decides which.
	const caseSearchConfig = doc.modules[moduleUuid]?.caseSearchConfig;
	const columnsReading = useMemo(
		() =>
			config === undefined
				? "casedb"
				: caseQueryReadingFor({ caseListConfig: config, caseSearchConfig })
						.columns,
		[config, caseSearchConfig],
	);
	const calculatedTemporalTypes = useMemo(() => {
		const types = new Map<Column["uuid"], CalculatedTemporalType>();
		if (config === undefined) return types;
		for (const column of config.columns) {
			if (column.kind !== "calculated") continue;
			const context = slotContext(
				doc,
				{
					entity: "module",
					uuid: moduleUuid,
					slot: "case_list_column_expression",
					member: { columnUuid: column.uuid },
				},
				lookupTypes,
			);
			if (context === undefined)
				throw new Error("The calculated column has no owning expression slot.");
			const temporalType = resolveCalculatedTemporalType(
				column,
				context,
				columnsReading,
			);
			if (temporalType !== undefined) types.set(column.uuid, temporalType);
		}
		return types;
	}, [config, doc, moduleUuid, lookupTypes, columnsReading]);
	return useMemo(
		() => ({
			language,
			calculatedTemporalTypes,
			caseProperties,
			today,
			reading: columnsReading,
			projectProse,
		}),
		[
			language,
			calculatedTemporalTypes,
			caseProperties,
			today,
			columnsReading,
			projectProse,
		],
	);
}
