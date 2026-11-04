/**
 * The words for where CommCare HQ keeps a case change. An identity move
 * states its `from` and `to` as placement labels, so each placement arm has
 * to name its own place; and a placement line says the change is kept where
 * the published app has it exactly when the placement is held.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	HELD_PLACEMENT_SUFFIX,
	PLACEMENT_LABELS,
	placementLabel,
	placementLabelWords,
	placementLine,
} from "@/lib/domain/placementCopy";
import type { CasePlacement } from "@/lib/domain/placements";

const REPEAT = testUuid("placement-copy-repeat");

const BASIC: readonly CasePlacement[] = [
	{ kind: "basic", slot: "own" },
	{ kind: "basic", slot: "usercase" },
	{ kind: "basic", slot: "subcase", index: 2 },
	{ kind: "basic", slot: "subcase-row" },
];
const ADVANCED: readonly CasePlacement[] = [
	{ kind: "advanced", tag: "load_visit0" },
	{ kind: "advanced", tag: "open_visit_1", row: true },
];
const SAVE_TO_CASE: readonly CasePlacement[] = [
	{ kind: "save-to-case", path: ["save_visit"] },
	{ kind: "save-to-case", repeat: REPEAT, path: ["nova_subcases", "visit"] },
];

describe("placementLabel", () => {
	it("names every Case Management slot Case Management", () => {
		for (const placement of BASIC) {
			expect(placementLabel(placement)).toBe("case-management");
		}
	});

	it("names every advanced load and open action the form's case actions", () => {
		for (const placement of ADVANCED) {
			expect(placementLabel(placement)).toBe("case-actions");
		}
	});

	it("names every Save to Case block Save to Case", () => {
		for (const placement of SAVE_TO_CASE) {
			expect(placementLabel(placement)).toBe("save-to-case");
		}
	});

	it("gives each label its own words", () => {
		const words = PLACEMENT_LABELS.map(placementLabelWords);
		expect(new Set(words).size).toBe(PLACEMENT_LABELS.length);
		expect(placementLabelWords("case-management")).toBe("Case Management");
		expect(placementLabelWords("save-to-case")).toBe("Save to Case");
	});
});

describe("placementLine", () => {
	it("says the change is kept where the published app has it only when held", () => {
		for (const placement of [...BASIC, ...ADVANCED, ...SAVE_TO_CASE]) {
			const line = placementLine(placement);
			expect(line.endsWith(HELD_PLACEMENT_SUFFIX)).toBe(false);
			expect(placementLine(placement, false)).toBe(line);
			expect(placementLine(placement, true)).toBe(
				`${line} · Kept where your published app has it`,
			);
		}
	});
});
