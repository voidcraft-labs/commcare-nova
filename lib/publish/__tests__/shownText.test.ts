/**
 * A text an app supplies, cut to what one line a person reads may hold.
 *
 * Contract: the output holds at most the bounds' grapheme clusters and code
 * units, its last character `…` where it was cut; no cluster and no surrogate
 * pair is split; and the work is bounded by the unit bound, never by the
 * text: only the text's first `units + 2` code units are ever segmented.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cutShown } from "../shownText";

const BOUNDS = { graphemes: 200, units: 800 };
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const clusters = (text: string) => [...graphemes.segment(text)].length;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("cutShown", () => {
	it("keeps a text within both bounds whole", () => {
		const text = "n".repeat(BOUNDS.graphemes);
		expect(cutShown(text, BOUNDS)).toBe(text);
		expect(cutShown("", BOUNDS)).toBe("");
	});

	it("cuts a text of more characters than the bound to one fewer and the mark", () => {
		const cut = cutShown("n".repeat(BOUNDS.graphemes + 1), BOUNDS);
		expect(cut).toBe(`${"n".repeat(BOUNDS.graphemes - 1)}…`);
	});

	it("cuts one character of a hundred thousand combining marks to the unit bound", () => {
		const text = `e${"́".repeat(100_000)}`;
		const cut = cutShown(text, BOUNDS);
		expect(cut.length).toBeLessThanOrEqual(BOUNDS.units);
		expect(cut.endsWith("…")).toBe(true);
		expect(clusters(cut)).toBeLessThanOrEqual(BOUNDS.graphemes);
	});

	it("never splits an astral character or a joined emoji at the bound", () => {
		const technologist = "👩🏽‍💻";
		for (const lead of ["", "n", "nn", "nnn"]) {
			const text = `${lead}${technologist.repeat(400)}`;
			const cut = cutShown(text, BOUNDS);
			expect(cut.length).toBeLessThanOrEqual(BOUNDS.units);
			const body = cut.slice(lead.length, -1);
			expect(body).toBe(technologist.repeat(body.length / technologist.length));
		}
		const astral = `${"n".repeat(BOUNDS.units - 1)}😀`;
		expect(cutShown(astral, BOUNDS).includes("\ud83d")).toBe(false);
		/* A skin tone after the bound joins the character before it. */
		const toned = `${"n".repeat(BOUNDS.units - 2)}👍🏽tail`;
		const cut = cutShown(toned, {
			graphemes: BOUNDS.units,
			units: BOUNDS.units,
		});
		expect(cut).toBe(`${"n".repeat(BOUNDS.units - 2)}…`);
	});

	it("segments no more than the bound's units of a text of ten million", () => {
		const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
		const cut = cutShown("n".repeat(10_000_000), BOUNDS);
		expect(cut.length).toBeLessThanOrEqual(BOUNDS.units);
		for (const [input] of segment.mock.calls)
			expect(input.length).toBeLessThanOrEqual(BOUNDS.units + 2);
	});
});
