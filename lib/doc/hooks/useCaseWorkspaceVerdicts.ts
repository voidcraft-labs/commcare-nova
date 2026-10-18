"use client";

import { useCallback } from "react";
import type { Column } from "@/lib/domain";
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
