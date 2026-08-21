// components/builder/shared/__tests__/keyboardReorderPlan.test.ts
//
// The shared keyboard reorder decision: a refused move SAYS why, an edge
// says it is already there, and a committed move carries no sentence of
// its own (the canvas reads where it landed from the committed document).

import { describe, expect, it } from "vitest";
import {
	type KeyboardReorderOutcome,
	planKeyboardReorder,
	reorderDirection,
} from "../keyboardReorderPlan";

type Verdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly why: string };

const refusalOf = (verdict: Verdict) => (verdict.ok ? undefined : verdict.why);

function allOk(length: number): Map<number, Verdict> {
	return new Map(
		Array.from({ length }, (_, index) => [index, { ok: true } as const]),
	);
}

function announcementOf(outcome: KeyboardReorderOutcome | undefined): string {
	if (outcome === undefined || outcome.kind === "move") {
		throw new Error(
			`Expected a refused or at-edge outcome, which carry words. Got ${outcome?.kind ?? "no outcome"}.`,
		);
	}
	return outcome.announcement;
}

describe("planKeyboardReorder", () => {
	it("names the destination and nothing else for an available move", () => {
		expect(
			planKeyboardReorder({
				order: ["a", "b", "c"],
				index: 2,
				key: "ArrowUp",
				verdicts: allOk(3),
				name: "Go to “Visit”",
				refusalOf,
			}),
		).toEqual({ kind: "move", toIndex: 1 });
	});

	it("Home and End travel to the ends", () => {
		expect(
			planKeyboardReorder({
				order: ["a", "b", "c"],
				index: 2,
				key: "Home",
				verdicts: allOk(3),
				name: "c",
				refusalOf,
			}),
		).toMatchObject({ kind: "move", toIndex: 0 });
		expect(
			planKeyboardReorder({
				order: ["a", "b", "c"],
				index: 0,
				key: "End",
				verdicts: allOk(3),
				name: "a",
				refusalOf,
			}),
		).toMatchObject({ kind: "move", toIndex: 2 });
	});

	it("says it is already at the edge instead of moving nowhere", () => {
		expect(
			planKeyboardReorder({
				order: ["a", "b"],
				index: 0,
				key: "ArrowUp",
				verdicts: allOk(2),
				name: "First link",
				refusalOf,
			}),
		).toEqual({
			kind: "at-edge",
			announcement: "First link is already first.",
		});
		expect(
			announcementOf(
				planKeyboardReorder({
					order: ["a", "b"],
					index: 1,
					key: "End",
					verdicts: allOk(2),
					name: "Last link",
					refusalOf,
				}),
			),
		).toBe("Last link is already last.");
	});

	it("leads a refusal with the name, then the caller's reason", () => {
		const verdicts = new Map<number, Verdict>([
			[0, { ok: false, why: "It has to stay above the otherwise link." }],
			[1, { ok: true }],
		]);
		const outcome = planKeyboardReorder({
			order: ["a", "b"],
			index: 1,
			key: "ArrowUp",
			verdicts,
			name: "Go to “Visit”",
			refusalOf,
		});
		expect(outcome?.kind).toBe("refused");
		expect(announcementOf(outcome)).toBe(
			"Go to “Visit” did not move earlier. It has to stay above the otherwise link.",
		);
	});

	it("treats a destination with no verdict as available", () => {
		// The map answers for every destination the planner knows about; a
		// missing entry is not a refusal the author should hear about.
		expect(
			planKeyboardReorder({
				order: ["a", "b"],
				index: 0,
				key: "ArrowDown",
				verdicts: new Map(),
				name: "a",
				refusalOf,
			}),
		).toEqual({ kind: "move", toIndex: 1 });
	});

	it("returns nothing for an index that names no item", () => {
		expect(
			planKeyboardReorder({
				order: ["a"],
				index: 4,
				key: "ArrowDown",
				verdicts: allOk(1),
				name: "?",
				refusalOf,
			}),
		).toBeUndefined();
	});

	it("reads direction the way the author experiences the key", () => {
		expect(reorderDirection("ArrowUp")).toBe("earlier");
		expect(reorderDirection("Home")).toBe("earlier");
		expect(reorderDirection("ArrowDown")).toBe("later");
		expect(reorderDirection("End")).toBe("later");
	});
});
