import { describe, expect, it } from "vitest";
import {
	findOnDeviceDateAddIssue,
	findOnDeviceDateAddIssueInPredicate,
} from "@/lib/commcare/expression/onDeviceCompatibility";
import {
	dateAdd,
	eq,
	literal,
	prop,
	type TypeContext,
	term,
	today,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

const TYPE_CONTEXT: TypeContext = {
	caseTypes: [
		{
			name: "patient",
			properties: [
				{
					name: "visited_on",
					label: proseText("Visited on"),
					data_type: "date",
				},
				{
					name: "visited_at",
					label: proseText("Visited at"),
					data_type: "datetime",
				},
			],
		},
	],
	knownInputs: [],
	currentCaseType: "patient",
};

describe("on-device date-add compatibility", () => {
	it("resolves a property-backed datetime from the supplied type context", () => {
		const issue = findOnDeviceDateAddIssue(
			dateAdd(term(prop("patient", "visited_at")), "days", term(literal(1))),
			TYPE_CONTEXT,
		);
		expect(issue?.reason).toBe("datetime-base");
	});

	it("admits fixed-duration arithmetic over a whole date", () => {
		expect(
			findOnDeviceDateAddIssue(
				dateAdd(
					term(prop("patient", "visited_on")),
					"hours",
					term(literal(-12)),
				),
				TYPE_CONTEXT,
			),
		).toBeUndefined();
	});

	it("returns the calendar-relative reason at any predicate depth", () => {
		const issue = findOnDeviceDateAddIssueInPredicate(
			eq(
				term(prop("patient", "visited_on")),
				dateAdd(today(), "months", term(literal(1))),
			),
			TYPE_CONTEXT,
		);
		expect(issue).toMatchObject({
			reason: "calendar-interval",
			expression: { kind: "date-add", interval: "months" },
		});
	});
});
