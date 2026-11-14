// The case list filter as Core runs it (`StringUtils.normalize`,
// `StringUtils.fuzzyMatch`, `EntitySortUtil.sortEntities`), and the terms each
// runtime makes of what a worker typed (Java's `String.split`). The two string
// functions' vectors are a shared table Core itself is held to in the proof
// lane (`ListFilterMatchRuntimeTest`), so a port that drifts from Core fails
// here and a Core that moves fails there.

import { describe, expect, it } from "vitest";
import {
	filterTerms,
	fuzzyMatch,
	normalizeForFilter,
	rowFilterScore,
} from "../listFilterMatch";
import {
	LIST_FILTER_FUZZY_VECTORS,
	LIST_FILTER_NORMALIZE_VECTORS,
} from "./fixtures/listFilterMatch";

describe("normalizeForFilter", () => {
	it.each(LIST_FILTER_NORMALIZE_VECTORS)(
		"normalizes $text as Core does",
		({ text, normalized }) => {
			expect(normalizeForFilter(text)).toBe(normalized);
		},
	);
});

describe("fuzzyMatch", () => {
	it.each(LIST_FILTER_FUZZY_VECTORS)(
		"matches $source against $target as Core does",
		({ source, target, matches, distance }) => {
			expect(fuzzyMatch(source, target)).toEqual({ matches, distance });
		},
	);
});

describe("rowFilterScore", () => {
	const field = (text: string, sortText: string | null = text) => ({
		text,
		sortText,
	});

	it("scores a row matched exactly at 0, fuzzy search on or off", () => {
		const row = [field("Amina Smith"), field("Riverside")];
		expect(rowFilterScore(["smith"], row, true)).toEqual({
			matches: true,
			score: 0,
		});
		expect(rowFilterScore(["smith"], row, false)).toEqual({
			matches: true,
			score: 0,
		});
	});

	it("matches a near miss only with fuzzy search on, adding its distance", () => {
		const row = [field("Amina Smyth")];
		expect(rowFilterScore(["smith"], row, false).matches).toBe(false);
		expect(rowFilterScore(["smith"], row, true)).toEqual({
			matches: true,
			score: 1,
		});
	});

	it("sums the distances of every term's fuzzy match", () => {
		const row = [field("Jon Smyth")];
		expect(rowFilterScore(["john", "smith"], row, true)).toEqual({
			matches: true,
			score: 2,
		});
	});

	it("fails a row where any one term matches no field", () => {
		const row = [field("Amina"), field("Riverside")];
		expect(rowFilterScore(["amina", "hilltop"], row, true).matches).toBe(false);
	});

	it("takes the first field that matches a term, a fuzzy one before a later exact one", () => {
		// Core walks the fields in order and tries each one's pieces before the
		// next field's text, so the first field's near miss decides the term.
		const row = [field("Smyth"), field("Smith")];
		expect(rowFilterScore(["smith"], row, true)).toEqual({
			matches: true,
			score: 1,
		});
	});

	it("matches a near miss only against the sort text, piece by piece", () => {
		expect(
			rowFilterScore(["smith"], [field("Amina Smyth", null)], true).matches,
		).toBe(false);
		expect(
			rowFilterScore(["smith"], [field("Shown", "amina smyth")], true),
		).toEqual({ matches: true, score: 1 });
	});

	it("folds accents on both sides", () => {
		expect(rowFilterScore(["jose"], [field("José")], false).matches).toBe(true);
		expect(rowFilterScore(["josé"], [field("Jose")], false).matches).toBe(true);
	});

	it("passes an empty term on a row with any text and fails a row whose every field is blank", () => {
		expect(rowFilterScore([""], [field(""), field("Amina")], true)).toEqual({
			matches: true,
			score: 0,
		});
		expect(rowFilterScore([""], [field(""), field("")], true).matches).toBe(
			false,
		);
	});

	it("passes every row with no terms", () => {
		expect(rowFilterScore([], [field("")], false)).toEqual({
			matches: true,
			score: 0,
		});
		expect(rowFilterScore([], [], true).matches).toBe(true);
	});
});

describe("filterTerms", () => {
	it("splits on runs of whitespace, or on each single space", () => {
		expect(filterTerms("ann  lee ", "whitespace-runs")).toEqual(["ann", "lee"]);
		expect(filterTerms("ann  lee ", "single-spaces")).toEqual([
			"ann",
			"",
			"lee",
		]);
	});

	it("keeps an empty first term where the text starts with a separator", () => {
		expect(filterTerms(" ann", "whitespace-runs")).toEqual(["", "ann"]);
		expect(filterTerms(" ann", "single-spaces")).toEqual(["", "ann"]);
	});

	it("splits on a tab only on runs of whitespace", () => {
		expect(filterTerms("ann\tlee", "whitespace-runs")).toEqual(["ann", "lee"]);
		expect(filterTerms("ann\tlee", "single-spaces")).toEqual(["ann\tlee"]);
	});

	it("splits on Java's whitespace alone, never on a no-break space", () => {
		expect(filterTerms("ann\u00a0lee", "whitespace-runs")).toEqual([
			"ann\u00a0lee",
		]);
	});

	it("normalizes each term", () => {
		expect(filterTerms("José", "whitespace-runs")).toEqual(["jose"]);
		expect(filterTerms("José", "single-spaces")).toEqual(["jose"]);
	});

	it("gives one empty term for an empty text and none for separators alone", () => {
		expect(filterTerms("", "whitespace-runs")).toEqual([""]);
		expect(filterTerms("", "single-spaces")).toEqual([""]);
		expect(filterTerms("  ", "whitespace-runs")).toEqual([]);
		expect(filterTerms("  ", "single-spaces")).toEqual([]);
	});
});
