/**
 * The stored placement shapes. A held placement names a place in a form
 * CommCare HQ already keeps, so a path HQ cannot name as elements, an index
 * on the one subcase of a repeat (which reaches no path), or a repeat on the
 * own close (which runs once, at the root) must never reach the document.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	placementIneligibilitySentence,
	placementLine,
} from "@/lib/domain/placementCopy";
import {
	ADVANCED_INELIGIBILITY_REASONS,
	casePlacementSchema,
	ownClosePlacementSchema,
	PLACEMENT_INELIGIBILITY_REASONS,
	saveToCasePlacementSchema,
} from "@/lib/domain/placements";

const REPEAT = testUuid("6b1f5d3e-2a4c-4e8b-9f70-1c2d3e4f5a6b");

describe("casePlacementSchema", () => {
	it("parses each arm", () => {
		for (const placement of [
			{ kind: "basic", slot: "own" },
			{ kind: "basic", slot: "usercase" },
			{ kind: "basic", slot: "subcase", index: 0 },
			{ kind: "basic", slot: "subcase", index: 3 },
			{ kind: "basic", slot: "subcase-row" },
			{ kind: "save-to-case", path: ["save_visit"] },
			{
				kind: "save-to-case",
				repeat: REPEAT,
				path: ["nova_subcases", "nova_subcase_0"],
			},
		]) {
			expect(casePlacementSchema.safeParse(placement).success).toBe(true);
		}
	});

	it("refuses a path segment holding a slash or starting with a digit, and an empty path", () => {
		for (const path of [
			["visits/save_visit"],
			["nova_subcases", "0_visit"],
			["1st"],
			[""],
			[],
		]) {
			expect(
				saveToCasePlacementSchema.safeParse({ kind: "save-to-case", path })
					.success,
			).toBe(false);
		}
	});

	it("refuses an index on subcase-row and a missing or negative index on subcase", () => {
		for (const placement of [
			{ kind: "basic", slot: "subcase-row", index: 0 },
			{ kind: "basic", slot: "subcase" },
			{ kind: "basic", slot: "subcase", index: -1 },
			{ kind: "basic", slot: "subcase", index: 1.5 },
		]) {
			expect(casePlacementSchema.safeParse(placement).success).toBe(false);
		}
	});

	it("parses an advanced action's tag, and its row only as true", () => {
		for (const placement of [
			{ kind: "advanced", tag: "load_visit0" },
			{ kind: "advanced", tag: "open_visit_1", row: true },
		]) {
			expect(casePlacementSchema.safeParse(placement).success).toBe(true);
		}
		for (const placement of [
			{ kind: "advanced", tag: "load/visit" },
			{ kind: "advanced", tag: "0_visit" },
			{ kind: "advanced", tag: "" },
			{ kind: "advanced" },
			{ kind: "advanced", tag: "open_visit_0", row: false },
			{ kind: "advanced", tag: "open_visit_0", slot: "own" },
		]) {
			expect(casePlacementSchema.safeParse(placement).success).toBe(false);
		}
	});
});

describe("ownClosePlacementSchema", () => {
	it("admits a root block and refuses a repeat", () => {
		expect(
			ownClosePlacementSchema.safeParse({
				kind: "save-to-case",
				path: ["close_visit"],
			}).success,
		).toBe(true);
		expect(
			ownClosePlacementSchema.safeParse({
				kind: "save-to-case",
				repeat: REPEAT,
				path: ["close_visit"],
			}).success,
		).toBe(false);
	});
});

describe("placement copy", () => {
	it("gives every reason its own sentence", () => {
		const sentences = PLACEMENT_INELIGIBILITY_REASONS.map(
			placementIneligibilitySentence,
		);
		expect(new Set(sentences).size).toBe(
			PLACEMENT_INELIGIBILITY_REASONS.length,
		);
		for (const sentence of sentences) expect(sentence).toMatch(/\.$/);
	});

	it("gives every advanced reason a sentence of the shared tuple", () => {
		for (const reason of ADVANCED_INELIGIBILITY_REASONS) {
			expect(PLACEMENT_INELIGIBILITY_REASONS).toContain(reason);
		}
		expect(placementIneligibilitySentence("carried-create")).toBe(
			"An after-submit link now hands the case it creates to another form, which needs that case's id when the form opens.",
		);
	});

	it("tells Case Management, case actions and Save to Case apart", () => {
		expect(placementLine({ kind: "basic", slot: "subcase-row" })).toBe(
			"CommCare HQ keeps this in the form's Case Management settings.",
		);
		expect(placementLine({ kind: "advanced", tag: "open_visit_0" })).toBe(
			"CommCare HQ keeps this in the form's case actions.",
		);
		expect(placementLine({ kind: "save-to-case", path: ["save_visit"] })).toBe(
			"CommCare HQ keeps this in a Save to Case block in the form, which needs Save to Case in the project space's plan.",
		);
	});
});
