// A refused menu or Search screen tries again on the next document commit.
// The boundary starts watching only after React commits the refusal, so a
// commit that lands in between, or a document swapped under it, must try the
// screen again rather than wait for a commit that may never come.

import { describe, expect, it } from "vitest";
import { refusalWatchStep } from "@/components/preview/shared/PreviewDataRefusal";

function documentAt(state: unknown) {
	let current = state;
	return {
		subscribe: () => () => {},
		getState: () => current,
		commit(next: unknown) {
			current = next;
		},
	};
}

describe("the refusal boundary's document watch", () => {
	it("watches the document while a refusal shows, from the state it was caught at", () => {
		const doc = documentAt("first");
		expect(
			refusalWatchStep({
				refused: true,
				watched: undefined,
				doc,
				caughtAt: "first",
			}),
		).toEqual({ unwatch: false, next: "watch" });
		expect(
			refusalWatchStep({ refused: true, watched: doc, doc, caughtAt: "first" }),
		).toEqual({ unwatch: false, next: "none" });
	});

	it("tries the screen again when the document changed before the watch began", () => {
		const doc = documentAt("first");
		doc.commit("second");
		expect(
			refusalWatchStep({
				refused: true,
				watched: undefined,
				doc,
				caughtAt: "first",
			}),
		).toEqual({ unwatch: false, next: "retry" });
	});

	it("leaves the old document and tries again when it is given another", () => {
		const before = documentAt("first");
		const after = documentAt("other");
		expect(
			refusalWatchStep({
				refused: true,
				watched: before,
				doc: after,
				caughtAt: "first",
			}),
		).toEqual({ unwatch: true, next: "retry" });
	});

	it("stops watching once nothing is refused", () => {
		const doc = documentAt("first");
		expect(
			refusalWatchStep({
				refused: false,
				watched: doc,
				doc,
				caughtAt: undefined,
			}),
		).toEqual({ unwatch: true, next: "none" });
		expect(
			refusalWatchStep({
				refused: false,
				watched: undefined,
				doc,
				caughtAt: undefined,
			}),
		).toEqual({ unwatch: false, next: "none" });
	});
});
