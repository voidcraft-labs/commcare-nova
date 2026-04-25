/**
 * renameOutcome — pure classification tests.
 *
 * The header's id input runs through `useCommitField` which calls the
 * outcome classifier with the typed id and the rename mutation's
 * conflict flag. The classifier returns the discriminated outcome and
 * the header turns it into setShaking + setIdNotice calls (or a clean
 * exit on noop / success).
 *
 * Coverage of the underlying renameField mutation lives in
 * `lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx`. The
 * popover render + shake-class application is owned by Playwright.
 */

import { describe, expect, it } from "vitest";
import { classifyRenameOutcome } from "../renameOutcome";

describe("classifyRenameOutcome", () => {
	it("returns noop for an empty newId", () => {
		// useCommitField filters most empty commits upstream, but the
		// classifier hardens the branch so a stray empty value never
		// surfaces a confusing 'A sibling field already has the ID ""'
		// popover.
		expect(classifyRenameOutcome({ newId: "", hasConflict: false })).toEqual({
			kind: "noop",
		});
	});

	it("returns conflict with the typed id embedded when the mutation reports collision", () => {
		// The conflicting id is part of the message because the input is
		// usually narrow enough that the live value isn't visible while
		// the popover is open. The wording is load-bearing for the test
		// — a copy change should be intentional, not silent.
		expect(
			classifyRenameOutcome({ newId: "occupied", hasConflict: true }),
		).toEqual({
			kind: "conflict",
			message: 'A sibling field already has the ID "occupied"',
		});
	});

	it("returns success when the rename was accepted", () => {
		expect(
			classifyRenameOutcome({ newId: "renamed", hasConflict: false }),
		).toEqual({ kind: "success" });
	});

	it("conflict supersedes any other state when both an id and conflict are present", () => {
		// Belt-and-suspenders pin: if both branches could apply (id is
		// non-empty AND the mutation reported a conflict), the classifier
		// must choose conflict — not silently fall through to success.
		const outcome = classifyRenameOutcome({
			newId: "x",
			hasConflict: true,
		});
		expect(outcome.kind).toBe("conflict");
	});
});
