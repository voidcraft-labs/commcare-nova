"use client";

import {
	type CaseWorkspaceBoundaryVerdicts,
	caseWorkspaceBoundaryVerdicts,
} from "../commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../lookupReferences";
import type { Uuid } from "../types";
import { useBlueprintDocEq } from "./useBlueprintDoc";

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
	return useBlueprintDocEq(
		(doc) =>
			moduleUuid === undefined
				? CLEAN_VERDICTS
				: caseWorkspaceBoundaryVerdicts(
						doc,
						moduleUuid,
						LOOKUP_CONTEXT_UNAVAILABLE,
					),
		equalVerdicts,
	);
}

export type { CaseWorkspaceBoundaryVerdicts } from "../commitVerdicts";
