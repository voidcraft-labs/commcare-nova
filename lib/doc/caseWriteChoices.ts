import { mutationCommitVerdictWithPrevalidation } from "@/lib/doc/commitVerdicts";
import {
	type FieldCaseWriteDestination,
	type FieldCaseWritePlan,
	planFieldCaseWrite,
} from "@/lib/doc/fieldCaseWriteMutations";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { userFacingErrors } from "@/lib/doc/userFacingErrors";
import type { FieldCaseWriteViewKey, Uuid } from "@/lib/domain";

/**
 * One "Saves to" choice: where the field's answer is saved (`null` stops
 * every write of it), and, when the choice changes one row of a field's
 * view, the row it replaces.
 */
export interface CaseWriteChoice {
	readonly destination: FieldCaseWriteDestination | null;
	readonly replace?: FieldCaseWriteViewKey;
}

/**
 * A choice's verdict. An admitted choice carries the exact batch the gate
 * judged, and that batch is the one a commit dispatches: the planner mints
 * the identity of a case it creates, so planning again would judge one batch
 * and commit another.
 */
export type CaseWriteChoiceVerdict =
	| {
			readonly ok: true;
			readonly mutations: readonly Mutation[];
			readonly notes: readonly string[];
	  }
	| { readonly ok: false; readonly reason: string };

/** The planner's batch for `choice` on the field `fieldUuid`. */
export function caseWriteChoicePlan(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	choice: CaseWriteChoice,
): FieldCaseWritePlan {
	return planFieldCaseWrite(
		doc,
		fieldUuid,
		choice.destination,
		choice.replace === undefined ? undefined : { replace: choice.replace },
	);
}

/**
 * Dry-run one concrete Saves to choice: the one planner every editor uses,
 * then the same full candidate gate that will commit it. Disabled rows
 * display the planner's refusal or the gate's first builder reason; no
 * UI-specific approximation of form scope, writer uniqueness, property type,
 * or create-name requirements exists.
 */
export function caseWriteChoiceVerdict(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	choice: CaseWriteChoice,
	lookupContext: LookupValidationContext,
): CaseWriteChoiceVerdict {
	const plan = caseWriteChoicePlan(doc, fieldUuid, choice);
	if (!plan.ok) return { ok: false, reason: plan.message };
	const verdict = mutationCommitVerdictWithPrevalidation(
		doc,
		plan.mutations,
		lookupContext,
	);
	if (verdict.ok)
		return { ok: true, mutations: plan.mutations, notes: plan.notes };
	return {
		ok: false,
		reason:
			userFacingErrors(verdict.findings)[0] ??
			"This question can't save there. Choose another place for its answer.",
	};
}
