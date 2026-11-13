/**
 * The own case operation's birth id. It becomes an XForm element name, so an
 * id that kept a case type's `-`, or collided with another operation of the
 * form, would name an element HQ cannot build or two blocks at one path.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	isCaseOperationIdentifier,
	ownCaseOperationId,
} from "@/lib/domain/caseOperationIdentifiers";
import { CASE_TYPE_PATTERN } from "@/lib/domain/expression/types";
import { questionIdProblem } from "@/lib/domain/questionId";

describe("ownCaseOperationId", () => {
	it("is the module's case type when it is free", () => {
		expect(ownCaseOperationId("patient", new Set())).toBe("patient");
	});

	it("turns characters the identifier grammar refuses into underscores", () => {
		const id = ownCaseOperationId("home-visit", new Set());
		expect(id).toBe("home_visit");
		expect(isCaseOperationIdentifier(id)).toBe(true);
	});

	it("steps past the form's other operation ids", () => {
		expect(
			ownCaseOperationId("patient", new Set(["patient", "patient_2"])),
		).toBe("patient_3");
	});
});

describe("ownCaseOperationId over every case type the grammar admits", () => {
	const caseTypes = fc
		.array(fc.constantFrom(..."abcXYZ019_-"), {
			minLength: 1,
			maxLength: 16,
		})
		.map((characters) => characters.join(""));
	const takenIds = fc.uniqueArray(
		fc.oneof(caseTypes, fc.constantFrom("case_case", "case_1st_visit", "x")),
		{ maxLength: 4 },
	);

	it("mints a question ID HQ's form builder takes, free among the form's ids", () => {
		fc.assert(
			fc.property(caseTypes, takenIds, (caseType, taken) => {
				expect(CASE_TYPE_PATTERN.test(caseType)).toBe(true);
				const id = ownCaseOperationId(caseType, new Set(taken));
				expect(questionIdProblem(id)).toBeUndefined();
				expect(isCaseOperationIdentifier(id)).toBe(true);
				expect(taken).not.toContain(id);
			}),
			{ seed: 20261113, numRuns: 400 },
		);
	});

	it("keeps the id a type of letters, digits and underscores mints today", () => {
		const keptTypes = fc
			.tuple(
				fc.constantFrom(..."abcXYZ"),
				fc.array(fc.constantFrom(..."abcXYZ019_-"), { maxLength: 12 }),
			)
			.map(([first, rest]) => first + rest.join(""))
			.filter(
				(caseType) =>
					questionIdProblem(caseType.replaceAll("-", "_")) === undefined,
			);
		fc.assert(
			fc.property(keptTypes, (caseType) => {
				expect(ownCaseOperationId(caseType, new Set())).toBe(
					caseType.replaceAll("-", "_"),
				);
			}),
			{ seed: 20261114, numRuns: 300 },
		);
	});

	it.each([
		["1st-visit", "case_1st_visit"],
		["-flagged", "case__flagged"],
		["2024", "case_2024"],
		["case", "case_case"],
		["XMLrecord", "case_XMLrecord"],
		["meta", "case_meta"],
		["registration", "case_registration"],
	])("mints %j as %j", (caseType, id) => {
		expect(ownCaseOperationId(caseType, new Set())).toBe(id);
	});
});
