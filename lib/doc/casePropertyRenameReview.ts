import {
	type CasePropertyRenameImpact,
	casePropertyRenameImpact,
} from "@/lib/doc/casePropertyRenameImpact";
import {
	type CasePropertyRenamePlanEntry,
	type CasePropertyRenamePlanIssue,
	planCasePropertyRenames,
} from "@/lib/doc/casePropertyRenames";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { userFacingErrors } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc } from "@/lib/domain";

export type CasePropertyRenameReview =
	| {
			readonly ok: true;
			readonly impact: CasePropertyRenameImpact;
	  }
	| {
			readonly ok: false;
			readonly reason: string;
			readonly renameIndex?: number;
	  };

function issueReason(reason: CasePropertyRenamePlanIssue): string {
	switch (reason.reason) {
		case "self-rename":
			return "Choose a different new name.";
		case "duplicate-source":
			return "Each property can appear once in this rename.";
		case "duplicate-destination":
			return "Two properties cannot end with the same name.";
		case "standard-scalar-property":
			return "Nova-managed case properties cannot be renamed.";
		case "source-missing":
			return "This property is no longer in the app. Refresh the list.";
		case "occupied-destination":
			return `“${reason.to}” already exists. Add it as another property to rename so no data is overwritten.`;
	}
}

/** Pure complete-document review used by the builder and its focused tests. */
export function reviewCasePropertyRenames(
	doc: BlueprintDoc,
	renames: readonly CasePropertyRenamePlanEntry[],
	lookupContext: LookupValidationContext,
): CasePropertyRenameReview {
	if (renames.length === 0) {
		return { ok: false, reason: "Choose at least one property to rename." };
	}
	const mutation = {
		kind: "renameCaseProperties" as const,
		renames: renames.map(({ caseType, from, to }) => ({
			caseType,
			from,
			to,
		})),
	};
	const plan = planCasePropertyRenames(doc, mutation);
	if (!plan.ok) {
		return {
			ok: false,
			reason: issueReason(plan.issue),
			renameIndex: plan.issue.renameIndex,
		};
	}
	const verdict = mutationCommitVerdict(doc, [mutation], lookupContext);
	if (!verdict.ok) {
		return {
			ok: false,
			reason:
				userFacingErrors(verdict.findings)[0] ??
				"This rename is not available in the current app.",
		};
	}
	return {
		ok: true,
		impact: casePropertyRenameImpact(doc, plan.plan.entries),
	};
}
