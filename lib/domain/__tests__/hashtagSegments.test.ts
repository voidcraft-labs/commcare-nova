/**
 * Reference text names a record type two ways, and every surface prints it
 * with `caseReferenceText` and reads it with `readCaseReference`. A printer
 * and a reader that disagreed would show the author a spelling that reads
 * back as another record, or as no record at all.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CASE_TYPE_PATTERN } from "@/lib/domain/expression/types";
import {
	buildHashtagRefRegex,
	caseReferencePrefix,
	caseReferenceText,
	HASHTAG_FIXED_NAMESPACES,
	readCaseReference,
} from "@/lib/domain/hashtagSegments";

const caseTypes = fc.oneof(
	fc.constantFrom(
		...HASHTAG_FIXED_NAMESPACES,
		"parent",
		"1st-visit",
		"-flagged",
	),
	fc
		.array(fc.constantFrom(..."abcXYZ019_-"), { minLength: 1, maxLength: 12 })
		.map((characters) => characters.join("")),
);
const properties = fc
	.tuple(
		fc.constantFrom(..."abcXYZ"),
		fc.array(fc.constantFrom(..."abcXYZ019_-"), { maxLength: 12 }),
	)
	.map(([first, rest]) => first + rest.join(""));

/** The namespace and segments a printed reference holds, as a parser reads them. */
function hashtagParts(text: string): [string, string[]] {
	const [namespace, ...segments] = text.slice(1).split("/");
	return [namespace, segments];
}

describe("caseReferenceText and readCaseReference", () => {
	it("are inverse over every case type the grammar admits", () => {
		fc.assert(
			fc.property(caseTypes, properties, (caseType, property) => {
				expect(CASE_TYPE_PATTERN.test(caseType)).toBe(true);
				const text = caseReferenceText(caseType, property);
				expect(text.startsWith(caseReferencePrefix(caseType))).toBe(true);
				expect(readCaseReference(...hashtagParts(text))).toEqual({
					caseType,
					property,
				});
				// The prose matcher finds the whole printed reference.
				expect(buildHashtagRefRegex().exec(text)?.[0]).toBe(text);
			}),
			{ seed: 20261113, numRuns: 400 },
		);
	});

	it("spells a type named for a fixed word with #record", () => {
		for (const word of HASHTAG_FIXED_NAMESPACES)
			expect(caseReferenceText(word, "region")).toBe(`#record/${word}/region`);
		expect(caseReferenceText("parent", "region")).toBe("#parent/region");
		expect(caseReferenceText("Form", "region")).toBe("#Form/region");
	});

	it("reads no record from a fixed namespace's own shape", () => {
		expect(readCaseReference("form", ["age"])).toBeUndefined();
		expect(readCaseReference("case", ["age"])).toBeUndefined();
		expect(readCaseReference("row", ["age"])).toBeUndefined();
		expect(readCaseReference("record", ["age"])).toBeUndefined();
		expect(readCaseReference("record", ["a", "b", "c"])).toBeUndefined();
		expect(readCaseReference("mother", ["a", "b"])).toBeUndefined();
	});
});
