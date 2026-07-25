// components/builder/case-operations/refusalCopy.ts
//
// Every refusal an author can meet on this surface, in words.
//
// The planners answer with a reason code and the operations the answer
// is about; this turns that into a sentence that names them. It must
// stay a projection — a refusal's wording may never imply a rule the
// planner does not enforce, because the author will act on the wording.
//
// The two reasons say genuinely different things, and collapsing them
// into one "can't move that" would waste the distinction the analysis
// worked to make:
//
//   - `dependent-reference` — something else USES this operation's
//     result, so order between them is not free.
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
} from "@/lib/doc/caseOperationReview";
import type { Uuid } from "@/lib/doc/types";

/** Join names the way a sentence would: "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[]): string {
	if (names.length === 0) return "";
	if (names.length === 1) return names[0];
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function quotedNames(
	uuids: readonly Uuid[],
	nameOf: (uuid: Uuid) => string | undefined,
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
	nameOf: (uuid: Uuid) => string | undefined,
): string | undefined {
	if (verdict === undefined || verdict.ok) return undefined;
	const names = quotedNames(verdict.blockingUuids, nameOf);
	if (verdict.reason === "dependent-reference") {
		return names.length === 0
			? "Something else here uses this change's result, so it has to stay earlier."
			: `${names} uses this change's result, so this has to stay before it.`;
	}
	return names.length === 0
		? "The submitted form cannot carry the changes in this order."
		: `The submitted form cannot carry this order: it would put this change on the wrong side of ${names}.`;
}

/** The keyboard announcement for a refused move — same facts, spoken. */
export function moveRefusalAnnouncement(
	operationName: string,
	verdict: CaseOperationMoveVerdict | undefined,
	nameOf: (uuid: Uuid) => string | undefined,
): string | undefined {
	const refusal = moveRefusal(verdict, nameOf);
	return refusal === undefined
		? undefined
		: `${operationName} did not move. ${refusal}`;
}

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
			return `the value it saves to ${slot.property}`;
		case "write-condition":
			return `when it saves ${slot.property}`;
	}
}

/**
 * The removal review's per-consumer line: which operation, and every
 * slot of it that would be left pointing at nothing.
 */
export function dependencyLine(
	consumerName: string | undefined,
	slots: readonly CaseOperationReferenceSlot[],
): string {
	const where = listNames(slots.map(referenceSlotPhrase));
	const who =
		consumerName === undefined ? "Another change" : `“${consumerName}”`;
	return `${who} uses it in ${where}.`;
}
