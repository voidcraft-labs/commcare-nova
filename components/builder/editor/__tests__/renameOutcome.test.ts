/**
 * renameOutcome — pure classification tests.
 *
 * The header's id input runs through `useCommitField`, which calls the
 * outcome classifier with the typed id and the shared identifier
 * verdict (`renameFieldIdVerdict` — computed by the header before any
 * dispatch). The classifier returns the discriminated outcome and the
 * header turns it into setShaking + setIdNotice calls (a rejection),
 * a dispatch (success), or a clean exit (noop).
 *
 * Verdict-content coverage (which ids fail and why) lives in
 * `lib/doc/__tests__/identifierVerdicts.test.ts`; the rename mutation
 * itself in `lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx`.
 * The popover render + shake-class application is owned by Playwright.
 */

import { describe, expect, it } from "vitest";
import type { FieldIdVerdict } from "@/lib/doc/identifierVerdicts";
import { classifyRenameOutcome } from "../renameOutcome";

const okVerdict: FieldIdVerdict = { ok: true };
const conflictVerdict: FieldIdVerdict = {
	ok: false,
	code: "sibling_conflict",
	// Verbose (SA) message + the concise builder line; the classifier
	// surfaces the latter, since this is the rename popover surface.
	message:
		'Another field at the same level is already named "occupied". Fields that sit side by side share an XML path, so each needs a unique ID.',
	userMessage:
		'Another field is already named "occupied". Give this one a different ID, or rename that one first.',
};

describe("classifyRenameOutcome", () => {
	it("returns noop for an empty newId", () => {
		// useCommitField filters most empty commits upstream, but the
		// classifier hardens the branch so a stray empty value never
		// surfaces a confusing rejection popover.
		expect(classifyRenameOutcome({ newId: "", verdict: okVerdict })).toEqual({
			kind: "noop",
		});
	});

	it("returns rejected carrying the verdict's CONCISE userMessage", () => {
		// This is the builder rename popover — the classifier surfaces the
		// verdict's concise `userMessage` (not the SA-facing verbose
		// `message`), embedding the offending id, untouched.
		expect(
			classifyRenameOutcome({ newId: "occupied", verdict: conflictVerdict }),
		).toEqual({
			kind: "rejected",
			message:
				'Another field is already named "occupied". Give this one a different ID, or rename that one first.',
		});
	});

	it("returns success when the verdict is clean", () => {
		expect(
			classifyRenameOutcome({ newId: "renamed", verdict: okVerdict }),
		).toEqual({ kind: "success" });
	});

	it("noop supersedes a rejection when the id is empty", () => {
		// Belt-and-suspenders pin: an empty id exits as noop even if a
		// caller hands a failing verdict alongside it — nothing was
		// typed, so nothing should shake.
		const outcome = classifyRenameOutcome({
			newId: "",
			verdict: conflictVerdict,
		});
		expect(outcome.kind).toBe("noop");
	});
});
