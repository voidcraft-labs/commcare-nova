import { describe, expect, it } from "vitest";
import { sectionInView } from "../useScrolledSection";

/* Web Apps' one screen records the section in view so a flip to edit mode
 * opens on it; the edit canvas reads the same rule for its first row
 * (`sectionShownAtRow`). */
const HEADINGS = [
	{ uuid: "about", top: 100 },
	{ uuid: "visit", top: 600 },
	{ uuid: "review", top: 1200 },
];

describe("sectionInView", () => {
	it("shows the first section while the top edge is above its heading", () => {
		expect(sectionInView(HEADINGS, 0)).toBe("about");
	});

	it("shows the last section whose heading is at or above the top edge", () => {
		expect(sectionInView(HEADINGS, 100)).toBe("about");
		expect(sectionInView(HEADINGS, 599)).toBe("about");
		expect(sectionInView(HEADINGS, 600)).toBe("visit");
		expect(sectionInView(HEADINGS, 5000)).toBe("review");
	});

	it("takes a heading a fraction of a pixel past the edge as in view", () => {
		expect(sectionInView(HEADINGS, 599.6)).toBe("visit");
	});

	it("has no section on a screen without headings", () => {
		expect(sectionInView([], 0)).toBeUndefined();
	});
});
