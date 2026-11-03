/**
 * What every semantic step of the case-writes cutover shares (part 09 §7):
 * the result a step returns, the one way a step's mutations reach the
 * document, and the blocker shape a step reports.
 *
 * A step whose planner returns mutations applies them through the reducer
 * every editor's commit uses, `lib/doc/commitVerdicts.ts::
 * prepareMutationCandidate` over `admitMutationBatch`, so the cutover's edit
 * is the production edit. A candidate that stops at admission (an identity
 * collision, a stale sequence anchor, an invalid target, an unplannable
 * rename) or a batch admission refuses as not canonical is the blocker
 * `transform-admission`, a defect of the step that planned it. The gate
 * itself runs once, at `judge-target`, over the whole target.
 */

import {
	preparedCandidateHasAdmissionIssue,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import {
	admitMutationBatch,
	MutationWireCanonicalityError,
} from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";
import type {
	BlockerCode,
	BlockerPlace,
	CutoverBlocker,
	PlannedChange,
} from "../types";

/**
 * What one semantic step returns: the document it leaves, the changes and
 * notice entries it planned, and the blockers it met. Where `blockers` is
 * not empty the transform stops at this step, and `doc` is the document the
 * step was given, so the judgement can still read it.
 */
export interface StepResult {
	readonly doc: BlueprintDoc;
	readonly changes: readonly PlannedChange[];
	readonly notice: readonly MigrationNoticeEntry[];
	readonly blockers: readonly CutoverBlocker[];
}

/** One blocker of `code`: `count` places, its finding codes sorted and
 *  distinct. */
export function stepBlocker(
	code: BlockerCode,
	count: number,
	findingCodes: Iterable<string>,
	places?: readonly BlockerPlace[],
): CutoverBlocker {
	return {
		code,
		count,
		findingCodes: [...new Set(findingCodes)].sort(),
		...(places !== undefined && places.length > 0 && { places }),
	};
}

/** The step's result where a blocker stopped it: the document unchanged,
 *  nothing planned. */
export function stoppedStep(
	doc: BlueprintDoc,
	blockers: readonly CutoverBlocker[],
): StepResult {
	return { doc, changes: [], notice: [], blockers };
}

/** The codes of a candidate's admission issue: the issue's kind with the
 *  mutation kind it met, never a value. */
function admissionIssueCodes(
	prepared: ReturnType<typeof prepareMutationCandidate>,
): string[] {
	const codes: string[] = [];
	if (prepared.identityAdmissionIssue !== undefined)
		codes.push(`identity:${prepared.identityAdmissionIssue.mutationKind}`);
	if (prepared.sequenceAdmissionIssue !== undefined)
		codes.push(`sequence:${prepared.sequenceAdmissionIssue.mutationKind}`);
	if (prepared.targetAdmissionIssue === true) codes.push("target");
	if (prepared.renamePlanIssue !== undefined)
		codes.push(`rename:${prepared.renamePlanIssue.reason}`);
	return codes;
}

export type AppliedMutations =
	| { readonly ok: true; readonly doc: BlueprintDoc }
	| { readonly ok: false; readonly blocker: CutoverBlocker };

/**
 * Apply one step's mutations to `doc` through the reducer every editor's
 * commit uses. An empty batch leaves the document as it is. A batch
 * admission refuses, or a candidate that stops at admission, is the blocker
 * `transform-admission`; `entity` names where it was met, for
 * `--debug-details` only.
 */
export function applyStepMutations(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
	entity?: BlockerPlace["entity"],
): AppliedMutations {
	if (mutations.length === 0) return { ok: true, doc };
	const refused = (codes: readonly string[]): AppliedMutations => ({
		ok: false,
		blocker: stepBlocker(
			"transform-admission",
			1,
			codes,
			codes.map((findingCode) => ({
				...(entity !== undefined && { entity }),
				findingCode,
			})),
		),
	});
	let prepared: ReturnType<typeof prepareMutationCandidate>;
	try {
		prepared = prepareMutationCandidate(doc, admitMutationBatch(mutations));
	} catch (error) {
		if (error instanceof MutationWireCanonicalityError)
			return refused([error.code]);
		throw error;
	}
	if (preparedCandidateHasAdmissionIssue(prepared))
		return refused(admissionIssueCodes(prepared));
	return { ok: true, doc: prepared.nextDoc };
}

/** Every form of the document in menu order: each module of `moduleOrder`
 *  with its forms in `formOrder`. */
export function formsInMenuOrder(doc: BlueprintDoc): readonly Uuid[] {
	return doc.moduleOrder.flatMap((moduleUuid) =>
		(doc.formOrder[moduleUuid] ?? []).filter(
			(formUuid) => doc.forms[formUuid] !== undefined,
		),
	);
}
