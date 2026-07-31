"use client";

import { useMemo } from "react";
import {
	type CasePropertyRenameReview,
	reviewCasePropertyRenames,
} from "@/lib/doc/casePropertyRenameReview";
import type { CasePropertyRenamePlanEntry } from "@/lib/doc/casePropertyRenames";
import { useLookupCommitState } from "@/lib/doc/lookupCommitContext";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useCasePropertyRenameReview(
	renames: readonly CasePropertyRenamePlanEntry[],
): CasePropertyRenameReview {
	const doc = useBlueprintDoc((state) => state);
	const lookupCommitState = useLookupCommitState();
	return useMemo(() => {
		if (lookupCommitState.kind === "loading") {
			return {
				ok: false,
				reason: "Project data is still loading. Wait before reviewing this.",
			};
		}
		if (lookupCommitState.kind === "error") {
			return {
				ok: false,
				reason:
					"Project data could not be loaded. Try again before reviewing this.",
			};
		}
		return reviewCasePropertyRenames(
			doc,
			renames,
			lookupCommitState.lookupContext,
		);
	}, [doc, lookupCommitState, renames]);
}
