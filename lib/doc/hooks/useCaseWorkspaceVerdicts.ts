"use client";

import {
	type CaseWorkspaceBoundaryVerdicts,
	caseWorkspaceBoundaryVerdicts,
} from "../commitVerdicts";
import type { Uuid } from "../types";
import { useBlueprintDocEq } from "./useBlueprintDoc";

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
	moduleUuid: Uuid,
): CaseWorkspaceBoundaryVerdicts {
	return useBlueprintDocEq(
		(doc) => caseWorkspaceBoundaryVerdicts(doc, moduleUuid),
		equalVerdicts,
	);
}

export type { CaseWorkspaceBoundaryVerdicts } from "../commitVerdicts";
