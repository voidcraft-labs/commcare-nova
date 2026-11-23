// Which comparisons HQ's search runs by its own conversion of the value
// (`case_search/xpath_functions/comparison.py::case_property_range_query`: a
// number first, then a date or a date and time, else `CaseFilterError`), the
// rule the checker's widening, Preview's search compiler and the reader's
// claim all read.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { input, literal, prop, term } from "../builders";
import { searchIndexedComparison } from "../searchIndexedComparison";

const village = term(prop("client", "village"));
const answer = term(input(testUuid("search-indexed-answer")));

describe("searchIndexedComparison", () => {
	it.each([
		["a number", term(literal("5")), "text", "number"],
		["a date", term(literal("2020-01-01")), "text", "date"],
		[
			"a date and time",
			term(literal("2020-01-01T10:00:00Z")),
			"text",
			"datetime",
		],
	] as const)(
		"orders a text property against %s by HQ's conversion of it",
		(_name, value, type, mode) => {
			expect(searchIndexedComparison(false, village, "text", value, type)).toBe(
				mode,
			);
		},
	);

	it("leaves to Nova's own rules a value HQ's conversion refuses: text, a time of day", () => {
		for (const value of ["m", "10:30", "2024-13-01"])
			expect(
				searchIndexedComparison(
					false,
					village,
					"text",
					term(literal(value)),
					"text",
				),
			).toBeUndefined();
	});

	it("runs a worker's text when the search does, and never orders against a time of day", () => {
		expect(
			searchIndexedComparison(false, village, "text", answer, "text"),
		).toBe("runtime");
		expect(
			searchIndexedComparison(false, village, "text", answer, "time"),
		).toBeUndefined();
	});

	it("tests a custom date-and-time property's equality with text on its stored text, and no system date", () => {
		const visited = term(prop("client", "visited_at"));
		expect(
			searchIndexedComparison(true, visited, "datetime", answer, "text"),
		).toBe("exact-text");
		expect(
			searchIndexedComparison(
				true,
				term(prop("client", "last_modified")),
				"datetime",
				answer,
				"text",
			),
		).toBeUndefined();
	});
});
