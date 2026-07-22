import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	advancedSearchInputDef,
	asUuid,
	calculatedColumn,
	type Module,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	and,
	arith,
	dateAdd,
	eq,
	formatDate,
	ifExpr,
	literal,
	matchAll,
	matchNone,
	now,
	or,
	prop,
	term,
	today,
} from "@/lib/domain/predicate";
import { errorIdentity } from "../../../gate";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_DATE_ADD_NOT_ON_DEVICE" as const;

const standardForm = {
	name: "Reg",
	type: "registration" as const,
	fields: [
		f({
			kind: "text" as const,
			id: "case_name",
			label: "Name",
			case_property_on: "patient",
		}),
	],
};

const standardCaseTypes = [
	{
		name: "patient",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
			{ name: "dob", label: "Date of birth", data_type: "date" as const },
			{
				name: "visited_at",
				label: "Visited at",
				data_type: "datetime" as const,
			},
			{ name: "day_offset", label: "Day offset", data_type: "int" as const },
			{
				name: "partial_days",
				label: "Partial days",
				data_type: "decimal" as const,
			},
		],
	},
];

function errorsFor(
	caseListPatch: Partial<NonNullable<Module["caseListConfig"]>> = {},
	caseSearchConfig?: Module["caseSearchConfig"],
) {
	const doc = buildDoc({
		appName: "T",
		modules: [
			{
				name: "Clients",
				caseType: "patient",
				caseListConfig: {
					columns: [plainColumn(asUuid("column-name"), "case_name", "Name")],
					searchInputs: [],
					...caseListPatch,
				},
				...(caseSearchConfig !== undefined ? { caseSearchConfig } : {}),
				forms: [standardForm],
			},
		],
		caseTypes: standardCaseTypes,
	});
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) => error.code === CODE);
}

describe("dateAddOnDeviceCompatibility", () => {
	it.each([
		["seconds", term(literal(0.5))],
		["minutes", term(literal(-0.5))],
		["hours", term(prop("patient", "partial_days"))],
		["days", term(prop("patient", "day_offset"))],
		["weeks", arith("div", term(literal(1)), term(literal(2)))],
	] as const)(
		"admits fractional and negative %s quantities for a date base",
		(interval, quantity) => {
			const hits = errorsFor({
				filter: eq(
					prop("patient", "dob"),
					dateAdd(today(), interval, quantity),
				),
			});
			expect(hits).toEqual([]);
		},
	);

	it("rejects a calendar-relative interval in the effective case-list filter", () => {
		const hits = errorsFor({
			filter: eq(
				prop("patient", "dob"),
				dateAdd(today(), "months", term(literal(1))),
			),
		});
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			interval: "months",
			reason: "calendar-interval",
			slot: "caseListConfig.filter",
			surface: "filter",
		});
		expect(userFacingError(hits[0])).toContain(
			"month and year calculations aren't available here",
		);
	});

	it("rejects date arithmetic that would discard a datetime's time-of-day", () => {
		const hits = errorsFor({
			filter: eq(
				prop("patient", "visited_at"),
				dateAdd(now(), "days", term(literal(1))),
			),
		});
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.reason).toBe("datetime-base");
		expect(userFacingError(hits[0])).toContain("the time would be lost");
	});

	it("leaves an invalid null quantity to the ordinary expression type checker", () => {
		const hits = errorsFor({
			filter: eq(
				prop("patient", "dob"),
				dateAdd(today(), "days", term(literal(null))),
			),
		});
		expect(hits).toEqual([]);
	});

	it("finds nested date arithmetic but reports one repair target per slot", () => {
		const hits = errorsFor({
			filter: and(
				eq(
					prop("patient", "dob"),
					ifExpr(
						matchAll(),
						dateAdd(today(), "months", term(literal(1))),
						today(),
					),
				),
				eq(prop("patient", "dob"), dateAdd(today(), "years", term(literal(1)))),
			),
		});
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.surface).toBe("filter");
	});

	it("checks runtime calculated columns, including a hidden sort key", () => {
		const columnUuid = asUuid("column-derived");
		const hits = errorsFor({
			columns: [
				plainColumn(asUuid("column-name"), "case_name", "Name"),
				calculatedColumn(
					columnUuid,
					"Follow-up date",
					dateAdd(today(), "months", term(literal(1))),
					{
						visibleInList: false,
						visibleInDetail: false,
						sort: { direction: "asc", priority: 0 },
					},
				),
			],
		});
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			columnLabel: "Follow-up date",
			columnUuid,
			surface: "calculated-column",
		});
		expect(userFacingError(hits[0])).toContain(
			'The calculation for field "Follow-up date"',
		);
	});

	it("ignores a fully off-screen unsorted calculated definition", () => {
		const hits = errorsFor({
			columns: [
				plainColumn(asUuid("column-name"), "case_name", "Name"),
				calculatedColumn(
					asUuid("column-retired"),
					"Retired",
					dateAdd(today(), "months", term(literal(1))),
					{ visibleInList: false, visibleInDetail: false },
				),
			],
		});
		expect(hits).toEqual([]);
	});

	it("checks both simple and advanced search-input defaults", () => {
		const simpleUuid = asUuid("input-simple");
		const advancedUuid = asUuid("input-advanced");
		const unsupportedDefault = dateAdd(today(), "months", term(literal(1)));
		const hits = errorsFor({
			searchInputs: [
				simpleSearchInputDef(
					simpleUuid,
					"dob_q",
					"Date of birth",
					"date",
					"dob",
					{ default: unsupportedDefault },
				),
				advancedSearchInputDef(
					advancedUuid,
					"other_dob_q",
					"Other date",
					"date",
					eq(prop("patient", "dob"), today()),
					{ default: unsupportedDefault },
				),
			],
		});
		expect(hits).toHaveLength(2);
		expect(hits.map((hit) => hit.details?.inputUuid)).toEqual([
			simpleUuid,
			advancedUuid,
		]);
		expect(
			hits.every((hit) => hit.details?.surface === "search-input-default"),
		).toBe(true);
		expect(userFacingError(hits[1])).toContain(
			'The default for search field "Other date"',
		);

		const moved = {
			...hits[1],
			details: {
				...hits[1].details,
				slot: "caseListConfig.searchInputs[99].default",
			},
		};
		expect(errorIdentity(moved)).toBe(errorIdentity(hits[1]));
	});

	it("checks the assigned-cases expression and search-button condition", () => {
		const hits = errorsFor(
			{},
			{
				excludedOwnerIds: formatDate(
					dateAdd(today(), "years", term(literal(1))),
					"iso",
				),
				searchButtonDisplayCondition: eq(
					formatDate(dateAdd(today(), "months", term(literal(1))), "iso"),
					literal("2020-01-01"),
				),
			},
		);
		expect(hits).toHaveLength(2);
		expect(hits.map((hit) => hit.details?.surface)).toEqual([
			"excluded-owner-ids",
			"search-button",
		]);
		expect(userFacingError(hits[0])).toContain("assigned cases setting");
		expect(userFacingError(hits[1])).toContain("Search button condition");
	});

	it("ignores date-add nodes removed by on-device wire simplification", () => {
		const dead = or(
			matchAll(),
			eq(prop("patient", "dob"), dateAdd(today(), "months", term(literal(1)))),
		);
		const hits = errorsFor(
			{ filter: dead },
			{ searchButtonDisplayCondition: dead },
		);
		expect(hits).toEqual([]);
	});

	it("keeps direct date-add in an advanced predicate on native CSQL", () => {
		const hits = errorsFor({
			searchInputs: [
				advancedSearchInputDef(
					asUuid("input-native"),
					"native_date",
					"Native date",
					"date",
					eq(
						prop("patient", "dob"),
						dateAdd(today(), "months", term(literal(1))),
					),
				),
			],
		});
		expect(hits).toEqual([]);
	});

	it("keeps direct datetime-add in an advanced predicate on native CSQL", () => {
		const hits = errorsFor({
			searchInputs: [
				advancedSearchInputDef(
					asUuid("input-native-datetime"),
					"native_datetime",
					"Native date and time",
					"text",
					eq(
						prop("patient", "visited_at"),
						dateAdd(now(), "months", term(literal(1))),
					),
				),
			],
		});
		expect(hits).toEqual([]);
	});

	it("rejects date-add nested under an advanced expression root that CSQL inlines on-device", () => {
		const inputUuid = asUuid("input-runtime");
		const hits = errorsFor({
			searchInputs: [
				advancedSearchInputDef(
					inputUuid,
					"runtime_date",
					"Runtime date",
					"date",
					eq(
						prop("patient", "dob"),
						ifExpr(
							matchAll(),
							dateAdd(today(), "months", term(literal(1))),
							today(),
						),
					),
				),
			],
		});
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			inputUuid,
			surface: "advanced-input",
		});
		expect(userFacingError(hits[0])).toContain(
			'The condition for search field "Runtime date"',
		);
	});

	it("drops an advanced finding when match-none absorbs the composed CSQL", () => {
		const hits = errorsFor({
			filter: matchNone(),
			searchInputs: [
				advancedSearchInputDef(
					asUuid("input-dead"),
					"dead_date",
					"Dead date",
					"date",
					eq(
						prop("patient", "dob"),
						ifExpr(
							matchAll(),
							dateAdd(today(), "months", term(literal(1))),
							today(),
						),
					),
				),
			],
		});
		expect(hits).toEqual([]);
	});

	it("drops only absorbed advanced findings and keeps the filter's independent on-device finding", () => {
		const hits = errorsFor({
			filter: eq(
				prop("patient", "dob"),
				dateAdd(today(), "months", term(literal(1))),
			),
			searchInputs: [
				advancedSearchInputDef(
					asUuid("input-match-none"),
					"nothing",
					"Nothing",
					"text",
					matchNone(),
				),
				advancedSearchInputDef(
					asUuid("input-dead-advanced"),
					"dead_advanced",
					"Dead advanced",
					"date",
					eq(
						prop("patient", "dob"),
						ifExpr(
							matchAll(),
							dateAdd(today(), "years", term(literal(1))),
							today(),
						),
					),
				),
			],
		});
		// The match-none advanced predicate absorbs every sibling advanced body in
		// the composed server query. The case-list filter still independently emits
		// as on-device XPath, so its finding must survive.
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.surface).toBe("filter");
	});
});
