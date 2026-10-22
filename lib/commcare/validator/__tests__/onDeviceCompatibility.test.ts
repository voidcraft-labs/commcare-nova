import { describe, expect, it } from "vitest";
import {
	findOnDeviceDateAddIssue,
	findOnDeviceDateAddIssueInPredicate,
} from "@/lib/commcare/validator/onDeviceCompatibility";
import {
	checkExpression,
	dateAdd,
	eq,
	exists,
	literal,
	prop,
	slotContext,
	subcasePath,
	tableColumn,
	tableLookup,
	term,
	today,
	typeOf,
} from "@/lib/domain/expression";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import { csqlArgumentFixture } from "../../__tests__/csqlFunctionFixture";

const TABLE = lookupTableIdSchema.parse("00000000-0000-7000-8000-000000000001");
const TEXT_COLUMN = lookupColumnIdSchema.parse(
	"10000000-0000-7000-8000-000000000001",
);
const DATETIME_COLUMN = lookupColumnIdSchema.parse(
	"10000000-0000-7000-8000-000000000002",
);

const vocabulary = {
	caseTypes: [
		{
			name: "household",
			properties: [],
		},
		{
			name: "patient",
			parent_type: "household",
			properties: [
				{
					name: "visited_on",
					label: proseText("Visited on"),
					data_type: "date" as const,
				},
				{
					name: "visited_at",
					label: proseText("Visited at"),
					data_type: "datetime" as const,
				},
			],
		},
	],
	knownInputs: [],
	currentCaseType: "patient",
	lookupTables: new Map([
		[
			TABLE,
			new Map([
				[TEXT_COLUMN, "text" as const],
				[DATETIME_COLUMN, "datetime" as const],
			]),
		],
	]),
};

function contextFor(currentCaseType = "patient") {
	const doc = structuredClone(csqlArgumentFixture());
	doc.caseTypes = vocabulary.caseTypes;
	doc.modules[doc.moduleOrder[0]].caseType = currentCaseType;
	const context = slotContext(
		doc,
		{ entity: "module", uuid: doc.moduleOrder[0], slot: "case_list_filter" },
		vocabulary.lookupTables,
	);
	if (context === undefined)
		throw new Error("The fixture has no filter carrier.");
	return context;
}
const TYPE_CONTEXT = contextFor();

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

	it("finds the calendar-relative reason in a comparison operand", () => {
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

	it("resolves a datetime inside a relation destination scope", () => {
		const predicate = exists(
			subcasePath("parent", "patient"),
			eq(
				dateAdd(term(prop("patient", "visited_at")), "days", term(literal(1))),
				term(prop("patient", "visited_at")),
			),
		);
		const context = contextFor("household");

		expect(checkExpression(predicate, context).errors).toEqual([]);
		expect(
			findOnDeviceDateAddIssueInPredicate(predicate, context)?.reason,
		).toBe("datetime-base");
	});

	it("installs lookup-row scope before resolving a datetime column", () => {
		const expression = tableLookup(
			TABLE,
			TEXT_COLUMN,
			eq(
				dateAdd(
					term(tableColumn(TABLE, DATETIME_COLUMN)),
					"hours",
					term(literal(1)),
				),
				term(tableColumn(TABLE, DATETIME_COLUMN)),
			),
		);
		expect(typeOf(expression, TYPE_CONTEXT)?.data).toBe("text");
		expect(findOnDeviceDateAddIssue(expression, TYPE_CONTEXT)?.reason).toBe(
			"datetime-base",
		);
	});
});
