// lib/domain/settled.ts
//
// Whether a part of a document can still change.
//
// A whole-document pass (the validator run, the reference index build,
// acceptance, the reader's assembly) asks the same structural questions once
// per form, field or carrier: which menu lists a form, which form holds a
// field. Their answers are projections of a few document parts, so they can
// be derived once and remembered by those parts' identity, but only while no
// write can reach the part any more. An Immer draft can be written; so can an
// object that is not frozen. A remembered answer for a part that changed
// under it would be a wrong commit verdict, so a part that may still change
// gets no remembered answer: its caller scans.
//
// Which documents are settled: every result of Immer's default `produce`,
// which deep-freezes what it returns (the doc store's documents and the
// commit gate's candidates), and the reader's working documents
// (`lib/commcare/reader/expressions/index.ts::cloned`, frozen whole).
// Documents made with Immer's freezing turned off are not. Acceptance's
// document under a declaration choice (`acceptance.ts`, `gather.ts::docUnder`)
// and `lib/doc/platformDeclaration.ts`'s keep an open root and open copies of
// what the choice changed, so a question about the whole document always
// takes the scan, while a part shared unchanged with a settled document keeps
// that part's remembered answer. The reader's candidates
// (`lib/commcare/reader/candidate.ts`) freeze only what they made: a
// candidate of a settled document is settled, one of an open document is not.

import { isDraft } from "immer";

/** An object no write can reach directly: frozen, and no Immer draft. */
export function isSettled(value: object): boolean {
	return !isDraft(value) && Object.isFrozen(value);
}

/**
 * Objects found settled all the way down. Being frozen is permanent, so once
 * a value and everything it holds is found frozen, it stays so, and the next
 * question about it is answered without a walk.
 */
const deeplySettled = new WeakSet<object>();

/**
 * Whether `value` and every object it holds are settled. A `Map` or `Set` is
 * never settled: freezing one leaves its entries writable.
 */
export function isDeeplySettled(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return true;
	if (deeplySettled.has(value)) return true;
	if (!isSettled(value) || value instanceof Map || value instanceof Set)
		return false;
	for (const child of Object.values(value))
		if (!isDeeplySettled(child)) return false;
	deeplySettled.add(value);
	return true;
}
