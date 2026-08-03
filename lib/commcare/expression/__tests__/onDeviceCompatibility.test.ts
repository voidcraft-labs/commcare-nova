import { describe, expect, it } from "vitest";
import {
	findOnDeviceDateAddIssue,
	findOnDeviceDateAddIssueInPredicate,
} from "@/lib/commcare/expression/onDeviceCompatibility";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	checkExpression,
	checkPredicate,
	dateAdd,
	eq,
	exists,
	literal,
	prop,
	subcasePath,
	type TypeContext,
	tableColumn,
	tableLookup,
	term,
	today,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

const TABLE = "00000000-0000-7000-8000-000000000001" as LookupTableId;
const TEXT_COLUMN = "10000000-0000-7000-8000-000000000001" as LookupColumnId;
const DATETIME_COLUMN =
	"10000000-0000-7000-8000-000000000002" as LookupColumnId;

const TYPE_CONTEXT: TypeContext = {
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
	lookupTables: new Map([
		[
			TABLE,
			new Map([
				[TEXT_COLUMN, "text"],
				[DATETIME_COLUMN, "datetime"],
			]),
		],
	]),
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

	it("resolves a datetime inside a relation destination scope", () => {
		const predicate = exists(
			subcasePath("parent", "patient"),
			eq(
				dateAdd(term(prop("patient", "visited_at")), "days", term(literal(1))),
				term(prop("patient", "visited_at")),
			),
		);
		const context = { ...TYPE_CONTEXT, currentCaseType: "household" };

		expect(checkPredicate(predicate, context)).toEqual({ ok: true });
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
		const checkErrors: Parameters<typeof checkExpression>[2] = [];

		expect(checkExpression(expression, TYPE_CONTEXT, checkErrors, [])).toBe(
			"text",
		);
		expect(checkErrors).toEqual([]);
		expect(findOnDeviceDateAddIssue(expression, TYPE_CONTEXT)?.reason).toBe(
			"datetime-base",
		);
	});
});
