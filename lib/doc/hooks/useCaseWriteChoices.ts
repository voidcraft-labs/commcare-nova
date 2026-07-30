"use client";

import { useCallback } from "react";
import {
	type CaseWriteChoiceVerdict,
	caseWriteChoiceVerdict,
} from "@/lib/doc/caseWriteChoices";
import { useLookupCommitState } from "@/lib/doc/lookupCommitContext";
import type { CaseWrite, Field } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useCaseWriteChoices(field: Field): {
	readonly choiceVerdict: (
		caseWrite: CaseWrite | null,
	) => CaseWriteChoiceVerdict;
} {
	const doc = useBlueprintDoc((state) => state);
	const lookupCommitState = useLookupCommitState();
	const choiceVerdict = useCallback(
		(caseWrite: CaseWrite | null): CaseWriteChoiceVerdict => {
			if (lookupCommitState.kind === "loading") {
				return {
					ok: false,
					reason: "Project data is still loading. Wait before changing this.",
				};
			}
			if (lookupCommitState.kind === "error") {
				return {
					ok: false,
					reason:
						"Project data could not be loaded. Try again before changing this.",
				};
			}
			return caseWriteChoiceVerdict(
				doc,
				field,
				caseWrite,
				lookupCommitState.lookupContext,
			);
		},
		[doc, field, lookupCommitState],
	);
	return { choiceVerdict };
}
