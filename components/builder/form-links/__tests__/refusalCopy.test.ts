// components/builder/form-links/__tests__/refusalCopy.test.ts
//
// Every refusal reads as a sentence about the rule the planner enforces,
// and no refusal implies one it does not.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { Uuid } from "@/lib/doc/types";
import {
	makeOtherwiseUnavailableReason,
	moveRefusal,
	moveRefusalReason,
	otherwiseUnavailableReason,
	removalQuestion,
	targetRefusalReason,
} from "../refusalCopy";

const A = testUuid("form-a");
const B = testUuid("form-b");
const ME = testUuid("form-me");
const NAMES: Record<string, string> = { [A]: "Visit", [B]: "Note" };
const nameOf = (uuid: Uuid) => NAMES[uuid];

describe("move refusals", () => {
	it("says each positional rule in its own words", () => {
		expect(
			moveRefusalReason({ ok: false, reason: "after-else", elseUuid: A }),
		).toBe("A link with a condition has to stay above the otherwise link.");
		expect(
			moveRefusalReason({
				ok: false,
				reason: "else-not-last",
				blockingUuids: [A],
			}),
		).toBe(
			"The otherwise link has to stay last: it only runs when nothing above it matched.",
		);
	});

	it("has nothing to say about an available position", () => {
		expect(moveRefusal({ ok: true })).toBeUndefined();
		expect(moveRefusal(undefined)).toBeUndefined();
	});
});

describe("target refusals", () => {
	it("names the chain back to this form, ending in 'this form'", () => {
		expect(
			targetRefusalReason(
				{ ok: false, reason: "cycle", chain: [A, B, ME] },
				nameOf,
			),
		).toBe("Going there would lead back here: “Visit” → “Note” → this form.");
	});

	it("still reads when a form in the chain has no name", () => {
		expect(
			targetRefusalReason(
				{ ok: false, reason: "cycle", chain: ["gone" as Uuid, ME] },
				nameOf,
			),
		).toBe("Going there would lead back here: “another form” → this form.");
	});

	it("keeps self and missing apart from a cycle", () => {
		expect(
			targetRefusalReason({ ok: false, reason: "self-target" }, nameOf),
		).toBe("This form can't send the person straight back into itself.");
		expect(
			targetRefusalReason({ ok: false, reason: "target-not-found" }, nameOf),
		).toBe("That destination is no longer part of the app.");
	});
});

describe("add and convert", () => {
	it("explains a refused otherwise intent and says nothing when it is on offer", () => {
		expect(
			otherwiseUnavailableReason({
				conditional: { ok: true },
				otherwise: { ok: false, reason: "else-exists", elseUuid: A },
			}),
		).toBe(
			"This form already has an otherwise link. Change where it goes instead.",
		);
		expect(
			otherwiseUnavailableReason({
				conditional: { ok: true },
				otherwise: { ok: true },
			}),
		).toBeUndefined();
	});

	it("names why a link cannot become the otherwise link", () => {
		expect(
			makeOtherwiseUnavailableReason({ isLast: true, hasElse: false }),
		).toBeUndefined();
		expect(
			makeOtherwiseUnavailableReason({ isLast: true, hasElse: true }),
		).toBe(
			"This form already has an otherwise link. Remove it first, or change where it goes.",
		);
		expect(
			makeOtherwiseUnavailableReason({ isLast: false, hasElse: false }),
		).toBe(
			"Only the last link can be the otherwise link. Move this one to the bottom first.",
		);
	});
});

describe("removal", () => {
	it("names the pinned fallback when removing the otherwise link", () => {
		expect(
			removalQuestion("Go to “Visit”", {
				ok: true,
				mutations: [],
				pinsFallback: "module",
			}),
		).toBe(
			"Remove “Go to “Visit””? When nothing above matches, the form will then go to this module's form list. You can undo this.",
		);
	});

	it("asks plainly when nothing else changes", () => {
		expect(removalQuestion("Go to “Visit”", { ok: true, mutations: [] })).toBe(
			"Remove “Go to “Visit””? You can undo this.",
		);
	});
});
