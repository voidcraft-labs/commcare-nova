import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { declareCaseTypeMutations } from "@/lib/doc/scaffolds";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { userFacingErrors } from "@/lib/doc/userFacingErrors";
import type { CaptureCaseWrite, CaseWrite, Field } from "@/lib/domain";

/**
 * Either destination shape a field's schema may carry.
 *
 * The capture kinds extend the pair with the `mode` naming what reaches
 * the case. Both travel through this helper unchanged — the patch carries
 * whatever the caller built, and the per-kind mutation schema is what
 * decides whether that shape is the one this field takes.
 */
export type AuthoredCaseWrite = CaseWrite | CaptureCaseWrite;

export type CaseWriteChoiceVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

/**
 * The exact complete candidate batch used by the local Saves to chooser.
 *
 * A destination is always one whole pair (or null to clear), plus the mode
 * on the capture kinds. Declaration and field retargeting share the batch,
 * matching the builder mutation hook's declaration chokepoint.
 */
export function caseWriteCandidateMutations(
	doc: BlueprintDoc,
	field: Field,
	caseWrite: AuthoredCaseWrite | null,
): readonly Mutation[] {
	return [
		...(caseWrite === null
			? []
			: declareCaseTypeMutations(doc, caseWrite.caseType)),
		{
			kind: "updateField",
			uuid: field.uuid,
			targetKind: field.kind,
			patch: { caseWrite },
		} as Mutation,
	];
}

/**
 * Dry-run one concrete Saves to choice through the same full candidate gate
 * that will commit it. Disabled rows display this verdict's first concise
 * builder reason; no UI-specific approximation of form scope, writer
 * uniqueness, property type, or create-name requirements exists.
 */
export function caseWriteChoiceVerdict(
	doc: BlueprintDoc,
	field: Field,
	caseWrite: AuthoredCaseWrite | null,
	lookupContext: LookupValidationContext,
): CaseWriteChoiceVerdict {
	const verdict = mutationCommitVerdict(
		doc,
		caseWriteCandidateMutations(doc, field, caseWrite),
		lookupContext,
	);
	if (verdict.ok) return { ok: true };
	return {
		ok: false,
		reason:
			userFacingErrors(verdict.findings)[0] ??
			"This destination is not available for this question.",
	};
}
