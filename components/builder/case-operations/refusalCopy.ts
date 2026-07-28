// components/builder/case-operations/refusalCopy.ts
//
// Every refusal an author can meet on this surface, in words.
//
// The planners answer with a reason code and the operations the answer
// is about; this turns that into a sentence that names them. It must
// stay a projection — a refusal's wording may never imply a rule the
// planner does not enforce, because the author will act on the wording.
//
// The reasons say genuinely different things, and collapsing them into
// one "can't move that" would waste the distinction the analysis worked
// to make:
//
//   - `dependent-reference` + `reference` — something else USES this
//     operation's result, so order between them is not free.
//   - `dependent-reference` + `target-type` — an earlier change SETS the
//     kind of case something later acts on, so the order the types were
//     established in is not free either. Nothing here is made or used;
//     saying it the reference way ("uses the case X makes") names a
//     change that is not the blocker and describes an edge that does not
//     exist, which is exactly why the planner reports which kind it was.
//   - `execution-order` — the SUBMITTED FORM could not represent the
//     order. `caseOperationOrder.ts` refuses a move backwards across a
//     repeat boundary, an authored-key create after other work, and a
//     repeated authored create sharing a repeat with a possibly-aliasing
//     later effect, because CommCare's two processors would disagree
//     about the result. Nothing the author did is wrong; the sequence
//     just is not expressible.

import type {
	CaseOperationMoveVerdict,
	CaseOperationReferenceSlot,
	CaseOperationReviewName,
} from "@/lib/doc/caseOperationReview";
import type { Uuid } from "@/lib/doc/types";
import { casePropertyPhrase } from "./operationSentence";

/** Join names the way a sentence would: "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[]): string {
	if (names.length === 0) return "";
	if (names.length === 1) return names[0];
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function quotedNames(
	uuids: readonly Uuid[],
	nameOf: CaseOperationReviewName,
): string {
	const names = uuids.map((uuid) => {
		const name = nameOf(uuid);
		return name === undefined ? "another change" : `“${name}”`;
	});
	return listNames(names);
}

/**
 * Why this position is not available, naming the operations involved.
 * Returns `undefined` when the position is available.
 */
export function moveRefusal(
	verdict: CaseOperationMoveVerdict | undefined,
	nameOf: CaseOperationReviewName,
	context: {
		readonly moved: Uuid;
		readonly dependsOn: readonly Uuid[];
	},
): string | undefined {
	if (verdict === undefined || verdict.ok) return undefined;
	return moveRefusalReason(verdict, nameOf, context);
}

/**
 * The same sentence for a verdict already known to be a refusal, so a
 * caller inside the refused branch does not have to fall back on copy
 * that could never be right.
 *
 * A REFERENCE refusal comes in two shapes, and saying them the same way
 * would misdescribe one of them. The planner answers with the operations
 * whose REFERENCES would break, so:
 *
 *   - dragging a producer LATER breaks its consumers — name them;
 *   - dragging a consumer EARLIER breaks its own references — naming it
 *     back to the author would read as "this change uses itself", so the
 *     sentence names what it depends on instead.
 *
 * `moved` and `dependsOn` are what let the copy tell those apart without
 * deciding anything: both come from the model. A TARGET-TYPE refusal is
 * not about a reference at all, so it never reads `dependsOn` — the
 * blockers the planner named are the whole answer, and the sentence
 * claims no direction, because a retype moved either way can leave a
 * neighbour acting on the wrong kind of case.
 */
export function moveRefusalReason(
	verdict: Extract<CaseOperationMoveVerdict, { ok: false }>,
	nameOf: CaseOperationReviewName,
	context: {
		/** The operation being moved. */
		readonly moved: Uuid;
		/** The creates it consumes, in execution order. */
		readonly dependsOn: readonly Uuid[];
	},
): string {
	if (verdict.reason === "dependent-reference") {
		const others = verdict.blockingUuids.filter(
			(uuid) => uuid !== context.moved,
		);
		if (verdict.dependencyKind === "target-type") {
			const names = quotedNames(others, nameOf);
			return names.length === 0
				? "This order would change which kind of case this change acts on."
				: `This order would change which kind of case ${names} acts on.`;
		}
		if (verdict.blockingUuids.includes(context.moved)) {
			const targets = quotedNames(context.dependsOn, nameOf);
			return targets.length === 0
				? "This change uses a case an earlier change makes, so it cannot move ahead of it."
				: `This change uses the case ${targets} makes, so it has to stay after it.`;
		}
		const names = quotedNames(others, nameOf);
		return names.length === 0
			? "Something else here uses this change's result, so it has to stay earlier."
			: `${names} uses this change's result, so this has to stay before it.`;
	}
	/* The moved change is on both sides of a wire-order refusal — it is the
	 * one that would land wrong. Naming it here would put it on the wrong
	 * side of itself. */
	const names = quotedNames(
		verdict.blockingUuids.filter((uuid) => uuid !== context.moved),
		nameOf,
	);
	return names.length === 0
		? "The submitted form cannot carry the changes in this order."
		: `The submitted form cannot carry this order: it would put this change on the wrong side of ${names}.`;
}

// The spoken form of a refusal lives in `keyboardMove.ts`, which owns the
// whole outcome (moved / already at the edge / refused) so the sentence an
// author HEARS and the edit that actually happened come from one decision.

/** Where a consumer holds its reference, in the author's words. */
export function referenceSlotPhrase(slot: CaseOperationReferenceSlot): string {
	switch (slot.kind) {
		case "target":
			return "the case it changes";
		case "link":
			return `its “${slot.identifier}” link`;
		case "name":
			return "the name it sets";
		case "owner":
			return "the owner it sets";
		case "rename":
			return "the new name it sets";
		case "condition":
			return "when it runs";
		case "write":
			return `the value it saves to ${casePropertyPhrase(slot.property)}`;
		case "write-condition":
			return `when it saves ${casePropertyPhrase(slot.property)}`;
	}
}

/**
 * The removal review's per-blocker line: which operation, and every slot
 * of it that would be left pointing at nothing.
 *
 * No slots means the blocker holds no reference at all — it depends on
 * the kind of case this change establishes. There is nothing to point
 * at, so the line names the operation and stops rather than inventing a
 * slot the author would go looking for.
 */
export function dependencyLine(
	blockerName: string | undefined,
	slots: readonly CaseOperationReferenceSlot[],
): string {
	const who = blockerName === undefined ? "Another change" : `“${blockerName}”`;
	return slots.length === 0
		? `${who} depends on this change.`
		: `${who} uses it in ${listNames(slots.map(referenceSlotPhrase))}.`;
}
