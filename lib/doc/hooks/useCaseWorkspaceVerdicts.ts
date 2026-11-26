"use client";

import { useCallback } from "react";
import { shallow } from "zustand/shallow";
import type { CaseListConfig, Column, SortComparison } from "@/lib/domain";
import { previewCaseListOrderPlan } from "@/lib/preview/engine/caseListOrder";
import {
	type CaseWorkspaceBoundaryVerdicts,
	caseListOrderChoiceRefusal,
	caseWorkspaceBoundaryVerdicts,
} from "../commitVerdicts";
import { useLookupCommitState } from "../lookupCommitContext";
import type { Uuid } from "../types";
import { useBlueprintDoc, useBlueprintDocEq } from "./useBlueprintDoc";

const CLEAN_VERDICTS: CaseWorkspaceBoundaryVerdicts = {
	filterBroken: false,
	searchInputsBroken: false,
	searchButtonConditionBroken: false,
	excludedOwnerIdsBroken: false,
	brokenColumnUuids: [],
};

function equalVerdicts(
	left: CaseWorkspaceBoundaryVerdicts,
	right: CaseWorkspaceBoundaryVerdicts,
): boolean {
	return (
		left.filterBroken === right.filterBroken &&
		left.searchInputsBroken === right.searchInputsBroken &&
		left.searchButtonConditionBroken === right.searchButtonConditionBroken &&
		left.excludedOwnerIdsBroken === right.excludedOwnerIdsBroken &&
		left.brokenColumnUuids.length === right.brokenColumnUuids.length &&
		left.brokenColumnUuids.every(
			(uuid, index) => uuid === right.brokenColumnUuids[index],
		)
	);
}

/** Subscribe only to the case-workspace-ready validator projection. */
export function useCaseWorkspaceBoundaryVerdicts(
	moduleUuid: Uuid | undefined,
): CaseWorkspaceBoundaryVerdicts {
	const { lookupContext } = useLookupCommitState();
	return useBlueprintDocEq(
		(doc) =>
			moduleUuid === undefined
				? CLEAN_VERDICTS
				: caseWorkspaceBoundaryVerdicts(doc, moduleUuid, lookupContext),
		equalVerdicts,
	);
}

/**
 * Why Default order's Add menu withholds a choice
 * (`caseListOrderChoiceRefusal`), over the current document. A closed menu
 * subscribes to nothing: the document is read only while `enabled`, and the
 * answer is `undefined` otherwise.
 */
export function useCaseListOrderChoiceRefusal(
	moduleUuid: Uuid | undefined,
	enabled: boolean,
): (column: Column) => string | undefined {
	const doc = useBlueprintDoc((current) =>
		enabled && moduleUuid !== undefined ? current : undefined,
	);
	return useCallback(
		(column: Column) =>
			doc === undefined || moduleUuid === undefined
				? undefined
				: caseListOrderChoiceRefusal(doc, moduleUuid, column),
		[doc, moduleUuid],
	);
}

export type { CaseWorkspaceBoundaryVerdicts } from "../commitVerdicts";

/** Default order offers comparisons only for a rule whose landing field
 * allows them. The collapsed composer subscribes to no order information. */
export function useCaseListOrderControls(
	moduleUuid: Uuid,
	config: CaseListConfig,
	expanded: boolean,
) {
	return useBlueprintDocEq(
		(doc) => {
			const mod = doc.modules[moduleUuid];
			const comparisons = new Map<Uuid, SortComparison>();
			if (!expanded || !mod) return { comparisons, extraFields: [] as Uuid[] };
			const plan = previewCaseListOrderPlan(mod, doc, config);
			for (const { sort, defaultComparison } of plan.calculations)
				comparisons.set(sort.uuid, defaultComparison);
			for (const rule of plan.authored) {
				if (rule.defaultComparison !== undefined)
					comparisons.set(rule.column, rule.defaultComparison);
			}
			return {
				comparisons,
				extraFields: plan.carriers.map((carrier) => carrier.column),
			};
		},
		(left, right) =>
			shallow(left.comparisons, right.comparisons) &&
			shallow(left.extraFields, right.extraFields),
	);
}
