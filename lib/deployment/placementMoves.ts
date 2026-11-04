import "server-only";

import { produce } from "immer";
import { appPlacements, planPlacements } from "@/lib/commcare/placement";
import { sameTypeBasicChildCases } from "@/lib/commcare/sameTypeChildCases";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import { formEmitsSaveToCase } from "@/lib/commcare/xform/caseOps";
import { withIdentityMoves } from "@/lib/doc/identityMoves";
import { applyHoldPlacements } from "@/lib/doc/mutations/placements";
import { heldPlacementOf } from "@/lib/doc/placementHolds";
import { type PlacementHoldEntry, placementTargetKey } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	operationCaseType,
	ownRecordValue,
	type Uuid,
} from "@/lib/domain";
import {
	forcedPlacementMoveSentence,
	movedToCaseManagementSentence,
	type PlacementMoveOfferView,
	type PlacementMoveView,
	type PlacementOfferReason,
} from "@/lib/publish/placementMoves";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

/**
 * The case changes a publish can move so the project space can take the app,
 * derived from the document alone: accepting an offer asks CommCare HQ
 * nothing, and the publish records it before preflight runs.
 */

/** A case change an offer can move: an operation, or a form's own close. */
export type CaseChangeTarget =
	| {
			readonly target: "case-operation";
			readonly formUuid: Uuid;
			readonly operationUuid: Uuid;
	  }
	| { readonly target: "own-close"; readonly formUuid: Uuid };

type CaseChangeHold = Extract<
	PlacementHoldEntry,
	{ target: "case-operation" | "own-close" }
>;

export interface PlacementMoveOffer extends PlacementMoveOfferView {
	/**
	 * What accepting records, in document order: the moved targets, then the
	 * moves they force. An own close moved into Case Management shares its
	 * form's own case block and holds no slot, so its entry clears the hold.
	 */
	readonly holds: readonly CaseChangeHold[];
}

/** The offer of `reason` over `doc`, or `null` where it moves nothing. */
export function placementMoveOffer(
	doc: BlueprintDoc,
	reason: PlacementOfferReason,
): PlacementMoveOffer | null {
	switch (reason) {
		case "save-to-case":
			return saveToCaseOffer(doc);
		case "same-type-child-links":
			return null;
	}
}

/** What a person is shown of an offer: everything but its holds. */
export function placementMoveOfferView(
	offer: PlacementMoveOffer,
): PlacementMoveOfferView {
	return {
		reason: offer.reason,
		digest: offer.digest,
		moves: offer.moves,
		asksChildCases: offer.asksChildCases,
	};
}

/** The form's name, trimmed, or its id, as every reason names a form. */
function formName(doc: BlueprintDoc, formUuid: Uuid): string {
	const form = ownRecordValue(doc.forms, formUuid);
	if (form === undefined) return formUuid;
	return form.name.trim() || form.id;
}

/**
 * The case change `target` makes, in words: "makes a new household case",
 * "updates the household case", "closes the household case", "saves to this
 * form's household case", "saves to the worker's record", or "closes this
 * form's case".
 */
export function describeCaseChange(
	doc: BlueprintDoc,
	target: CaseChangeTarget,
): string {
	if (target.target === "own-close") return "closes this form's case";
	const operation = ownRecordValue(
		doc.forms,
		target.formUuid,
	)?.caseOperations?.find((op) => op.uuid === target.operationUuid);
	if (operation === undefined) {
		throw new Error(
			`Nova went to describe the case change ${target.operationUuid} of form ${target.formUuid}, and the form holds no such change. A move offer names only changes its document holds, so the offer and the document disagree.`,
		);
	}
	const caseType = operationCaseType(doc, target.formUuid, operation);
	switch (operation.action) {
		case "own":
			return caseType === undefined
				? "saves to this form's case"
				: `saves to this form's ${caseType} case`;
		case "create":
			return `makes a new ${operation.caseType} case`;
		case "update":
			return operation.target.kind === "worker-record"
				? "saves to the worker's record"
				: `updates the ${operation.caseType} case`;
		case "close":
			return `closes the ${operation.caseType} case`;
	}
}

/**
 * The digest an acceptance names: the reason and, for each hold, its target,
 * what the document holds there now and what the move holds. An edit that
 * changes none of those leaves it; any change to what moves changes it.
 */
function offerDigest(
	doc: BlueprintDoc,
	reason: PlacementOfferReason,
	holds: readonly CaseChangeHold[],
): string {
	return canonicalJsonDigest({
		reason,
		holds: holds.map((hold) => [
			placementTargetKey(hold),
			heldPlacementOf(doc, hold),
			hold.placement,
		]),
	});
}

/**
 * Every case operation and own close whose effective placement is its own
 * Save to Case block, in document order, or `null` where one of them is not
 * held: an unheld change already takes the simplest place that expresses
 * it, so it has nothing simpler.
 */
function heldSaveToCaseTargets(
	doc: BlueprintDoc,
): readonly CaseChangeTarget[] | null {
	const targets: CaseChangeTarget[] = [];
	for (const [formUuid, { placements }] of appPlacements(doc)) {
		const form = ownRecordValue(doc.forms, formUuid);
		if (form === undefined) continue;
		for (const operation of form.caseOperations ?? []) {
			const planned = placements.get(operation.uuid);
			if (planned?.placement.kind !== "save-to-case") continue;
			if (!planned.held) return null;
			targets.push({
				target: "case-operation",
				formUuid,
				operationUuid: operation.uuid,
			});
		}
		const ownClose = placements.get("own-close");
		if (
			ownClose?.placement.kind === "save-to-case" &&
			ownClose.sharesWith === undefined
		) {
			if (!ownClose.held) return null;
			targets.push({ target: "own-close", formUuid });
		}
	}
	return targets;
}

/**
 * The `save-to-case` offer: every held Save to Case block moved to the Case
 * Management slot the planner gives it once the hold is gone, all of them or
 * none. A partial move changes submission paths and still needs Save to Case,
 * so it buys nothing. It never puts a new case of its module's own type in a
 * basic subcase, which a project space that drops such links would refuse
 * next.
 */
function saveToCaseOffer(doc: BlueprintDoc): PlacementMoveOffer | null {
	const targets = heldSaveToCaseTargets(doc);
	if (targets === null || targets.length === 0) return null;

	const cleared = produce(doc, (draft) => {
		applyHoldPlacements(draft, {
			kind: "holdPlacements",
			holds: targets.map((target) => ({ ...target, placement: null })),
		});
	});
	if (sameTypeBasicChildCases(cleared).length > 0) return null;

	const moved: CaseChangeHold[] = [];
	for (const target of targets) {
		const planned = planPlacements(cleared, target.formUuid).placements.get(
			target.target === "own-close" ? "own-close" : target.operationUuid,
		);
		if (planned === undefined || planned.placement.kind === "save-to-case")
			return null;
		moved.push(
			target.target === "own-close"
				? { ...target, placement: null }
				: { ...target, placement: planned.placement },
		);
	}

	const holds = withForcedMoves(doc, moved);
	if (holds === null) return null;
	const movedKeys = new Set(moved.map(placementTargetKey));
	const moves: PlacementMoveView[] = holds.map((hold) => {
		const form = formName(doc, hold.formUuid);
		const change = describeCaseChange(doc, hold);
		return {
			form,
			change,
			sentence: movedKeys.has(placementTargetKey(hold))
				? movedToCaseManagementSentence(form, change)
				: forcedPlacementMoveSentence(form, change),
		};
	});
	return {
		reason: "save-to-case",
		digest: offerDigest(doc, "save-to-case", holds),
		moves,
		asksChildCases: holds.some(
			(hold) =>
				hold.target === "case-operation" &&
				hold.placement?.kind === "basic" &&
				(hold.placement.slot === "subcase" ||
					hold.placement.slot === "subcase-row"),
		),
		holds,
	};
}

/**
 * `moved` followed by every hold the move planner appends once they apply (a
 * basic subcase renumbered after another joins the list, for instance), each
 * target once with the planner's value where it set one. `null` where a
 * forced move is not a case change in Case Management: the offer would then
 * move something it cannot name as a case change, or still need Save to
 * Case.
 */
function withForcedMoves(
	doc: BlueprintDoc,
	moved: readonly CaseChangeHold[],
): readonly CaseChangeHold[] | null {
	const plan = withIdentityMoves(doc, [
		{ kind: "holdPlacements", holds: structuredClone([...moved]) },
	]);
	const planned = new Map<string, PlacementHoldEntry>();
	for (const mutation of plan.batch) {
		if (mutation.kind !== "holdPlacements") continue;
		for (const entry of mutation.holds)
			planned.set(placementTargetKey(entry), structuredClone(entry));
	}
	const holds: CaseChangeHold[] = [];
	const settle = (entry: PlacementHoldEntry): boolean => {
		if (entry.target !== "case-operation" && entry.target !== "own-close")
			return false;
		if (entry.placement?.kind === "save-to-case") return false;
		holds.push(entry);
		return true;
	};
	for (const hold of moved) {
		const key = placementTargetKey(hold);
		if (!settle(planned.get(key) ?? hold)) return null;
		planned.delete(key);
	}
	for (const entry of planned.values()) if (!settle(entry)) return null;
	return holds;
}

/**
 * The forms whose Save to Case blocks the plan feature is asked for, by name,
 * in document order: each form some placement of which is Save to Case and
 * whose source writes that block (`planPrivileges.ts`'s `save_to_case` rule).
 */
export function saveToCaseFormNames(
	doc: BlueprintDoc,
	attachmentTarget: AttachmentUrlTarget | null,
): readonly string[] {
	const names: string[] = [];
	for (const [formUuid, { placements }] of appPlacements(doc)) {
		if (
			[...placements.values()].some(
				(planned) => planned.placement.kind === "save-to-case",
			) &&
			formEmitsSaveToCase(doc, formUuid, { attachmentTarget })
		)
			names.push(formName(doc, formUuid));
	}
	return names;
}
