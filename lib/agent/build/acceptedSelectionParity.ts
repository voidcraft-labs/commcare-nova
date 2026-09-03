/** Deterministic parity between accepted module selection and realized modules. */

import type { BlueprintDoc, CaseSelection } from "@/lib/domain";
import {
	type ModuleHandleBinding,
	realizedModuleUuid,
} from "./acceptedModulePlacement";
import type { SliceExecutionBrief } from "./executionBrief";

export interface AcceptedSelectionRealizationIssue {
	readonly code: "ACCEPTED_CASE_SELECTION_MISMATCH";
	readonly message: string;
	readonly location: {
		readonly kind: "module";
		readonly moduleUuid: string;
	};
	readonly details: {
		readonly moduleCompositionId: string;
		readonly action:
			| "unmarked-create"
			| "default-one"
			| "create-with-module"
			| "configure-after-forms";
		readonly acceptedSelection: CaseSelection | null;
		readonly realizedSelection: CaseSelection | null;
	};
}

function selectionsMatch(
	accepted: CaseSelection | null,
	realized: CaseSelection | undefined,
): boolean {
	if (accepted === null) return realized === undefined;
	return realized?.kind === "multiple" && realized.maximum === accepted.maximum;
}

/** Compare every exact selection realization in the accepted brief with its
 * handle-resolved module. A module born in this slice without a realization
 * must remain one-case; a reused unmarked module may retain selection accepted
 * by its owning earlier slice. Missing modules remain the placement proof's
 * job, so this check owns only unambiguous realized identities. */
export function acceptedSelectionRealizationIssues(
	doc: BlueprintDoc,
	brief: SliceExecutionBrief,
	handles: readonly ModuleHandleBinding[],
): AcceptedSelectionRealizationIssue[] {
	const issues: AcceptedSelectionRealizationIssue[] = [];
	for (const realization of brief.moduleRealizations) {
		const accepted = realization.selectionRealization;
		if (accepted === undefined && realization.action !== "create") continue;
		const moduleUuid = realizedModuleUuid(
			doc,
			brief,
			realization.compositionId,
			handles,
		);
		if (moduleUuid === null) continue;
		const module = doc.modules[moduleUuid];
		if (module === undefined) continue;
		const realizedSelection = module.caseListConfig?.selection;
		const acceptedSelection = accepted?.selection ?? null;
		if (selectionsMatch(acceptedSelection, realizedSelection)) continue;

		issues.push({
			code: "ACCEPTED_CASE_SELECTION_MISMATCH",
			message:
				accepted === undefined
					? `Accepted module composition ${realization.compositionId} has no several-case selection realization, but newly created module ${moduleUuid} is configured for several cases. Remove selection from createModule.`
					: accepted.selection === null
						? `Accepted module composition ${realization.compositionId} opens one case at a time, but module ${moduleUuid} is configured for several cases. Restore the accepted one-case selection.`
						: `Accepted module composition ${realization.compositionId} lets workers select up to ${accepted.selection.maximum} cases, but module ${moduleUuid} does not realize that exact selection. Apply the selectionRealization from the execution brief.`,
			location: { kind: "module", moduleUuid },
			details: {
				moduleCompositionId: realization.compositionId,
				action: accepted?.action ?? "unmarked-create",
				acceptedSelection,
				realizedSelection: realizedSelection ?? null,
			},
		});
	}
	return issues;
}
