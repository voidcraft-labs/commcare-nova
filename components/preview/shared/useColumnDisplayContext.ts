// components/preview/shared/useColumnDisplayContext.ts
//
// The display context every running case-list surface projects its cells
// through — the Results list, the Quick Filter that has to match what
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
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { CaseListConfig, CaseProperty, Column } from "@/lib/domain";
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
): ColumnDisplayContext {
	const effectiveCaseTypes = useEffectiveCaseTypes();
	const effectiveCaseType = effectiveCaseTypes.find(
		(candidate) => candidate.name === currentCaseType,
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
			caseProperties: effectiveCaseType?.properties ?? fallbackProperties,
			today,
			projectProse,
		}),
		[
			calculatedTemporalTypes,
			effectiveCaseType?.properties,
			fallbackProperties,
			today,
			projectProse,
		],
	);
}
