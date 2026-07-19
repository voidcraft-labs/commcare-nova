/**
 * Preview/Postgres can distinguish an absent case property from a recorded
 * blank, while CommCare's emitted dialects cannot. These tests keep strict
 * `is-null` out of every module Predicate/ValueExpression wire slot without
 * duplicating the CSQL representability finding.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	advancedSearchInputDef,
	asUuid,
	calculatedColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	eq,
	ifExpr,
	isBlank,
	isNull,
	literal,
	matchAll,
	matchNone,
	or,
	type Predicate,
	prop,
	sessionUser,
	term,
} from "@/lib/domain/predicate";
import { classifyError, errorIdentity, evaluateBoundary } from "../../../gate";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_STRICT_NULL_NOT_PORTABLE" as const;
const CSQL_CODE = "CASE_LIST_CSQL_NOT_REPRESENTABLE" as const;

const standardForm = {
	name: "Register client",
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
			{ name: "status_note", label: "Status note", data_type: "text" as const },
		],
	},
];

function buildCaseListDoc(args: {
	readonly filter?: Predicate;
	readonly searchButtonDisplayCondition?: Predicate;
	readonly searchEnabled?: boolean;
}) {
	return buildDoc({
		appName: "Clinic",
		modules: [
			{
				uuid: "module-clients",
				name: "Clients",
				caseType: "patient",
				caseListConfig: {
					columns: [plainColumn(asUuid("column-name"), "case_name", "Name")],
					...(args.filter !== undefined ? { filter: args.filter } : {}),
					searchInputs: [],
				},
				...(args.searchEnabled ||
				args.searchButtonDisplayCondition !== undefined
					? {
							caseSearchConfig: {
								...(args.searchButtonDisplayCondition !== undefined
									? {
											searchButtonDisplayCondition:
												args.searchButtonDisplayCondition,
										}
									: {}),
							},
						}
					: {}),
				forms: [standardForm],
			},
		],
		caseTypes: standardCaseTypes,
	});
}

function strictNullFindings(doc: ReturnType<typeof buildCaseListDoc>) {
	return runValidation(doc).filter((error) => error.code === CODE);
}

function strictNullTextExpression() {
	return ifExpr(
		isNull(sessionUser("assigned_region")),
		term(literal("missing")),
		term(literal("present")),
	);
}

describe("strictNullPortability", () => {
	it("rejects strict is-null in an ordinary on-device case-list filter", () => {
		const doc = buildCaseListDoc({
			filter: isNull(prop("patient", "status_note")),
		});

		const hits = strictNullFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			property: "status_note",
			slot: "caseListConfig.filter",
		});
		expect(userFacingError(hits[0])).toContain("Cases available rule");
		expect(userFacingError(hits[0])).toContain("Use “is blank” instead");
	});

	it("reports one on-device finding, not a duplicate CSQL finding, for a search-enabled filter", () => {
		const doc = buildCaseListDoc({
			filter: isNull(prop("patient", "status_note")),
			searchEnabled: true,
		});
		const errors = runValidation(doc);

		expect(errors.filter((error) => error.code === CODE)).toHaveLength(1);
		expect(errors.filter((error) => error.code === CSQL_CODE)).toHaveLength(0);
	});

	it("rejects strict is-null in the search-button display condition", () => {
		const doc = buildCaseListDoc({
			filter: eq(prop("patient", "case_name"), literal("Alice")),
			searchButtonDisplayCondition: isNull(prop("patient", "status_note")),
		});

		const hits = strictNullFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.slot).toBe(
			"caseSearchConfig.searchButtonDisplayCondition",
		);
		expect(userFacingError(hits[0])).toContain("Search button condition");
	});

	it("finds strict is-null nested in an if condition inside a value expression", () => {
		const doc = buildCaseListDoc({
			filter: eq(
				ifExpr(
					isNull(prop("patient", "status_note")),
					term(literal("missing")),
					term(literal("present")),
				),
				literal("missing"),
			),
		});

		expect(strictNullFindings(doc)).toHaveLength(1);
	});

	it("ignores strict is-null in a branch removed by wire simplification", () => {
		const doc = buildCaseListDoc({
			filter: or(matchAll(), isNull(prop("patient", "status_note"))),
		});

		expect(strictNullFindings(doc)).toEqual([]);
	});

	it("accepts the portable is-blank operator", () => {
		const doc = buildCaseListDoc({
			filter: isBlank(prop("patient", "status_note")),
			searchButtonDisplayCondition: isBlank(prop("patient", "status_note")),
		});

		expect(strictNullFindings(doc)).toEqual([]);
	});

	it("rejects strict is-null nested in a runtime calculated-column expression", () => {
		const columnUuid = asUuid("column-calculated");
		const doc = buildDoc({
			appName: "Clinic",
			modules: [
				{
					name: "Clients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("column-name"), "case_name", "Name"),
							calculatedColumn(
								columnUuid,
								"Availability",
								strictNullTextExpression(),
							),
						],
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		const hits = runValidation(doc).filter((error) => error.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			columnLabel: "Availability",
			columnUuid,
			surface: "calculated-column",
		});
		expect(userFacingError(hits[0])).toContain(
			'calculation for field "Availability"',
		);
	});

	it("ignores a fully off-screen unsorted calculated definition that emits nowhere", () => {
		const doc = buildDoc({
			appName: "Clinic",
			modules: [
				{
					name: "Clients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("column-name"), "case_name", "Name"),
							calculatedColumn(
								asUuid("column-retired"),
								"Retired",
								strictNullTextExpression(),
								{ visibleInList: false, visibleInDetail: false },
							),
						],
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		expect(runValidation(doc).filter((error) => error.code === CODE)).toEqual(
			[],
		);
	});

	it("rejects strict is-null in a search-input default with stable friendly attribution", () => {
		const inputUuid = asUuid("input-note");
		const doc = buildDoc({
			appName: "Clinic",
			modules: [
				{
					name: "Clients",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("column-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								inputUuid,
								"status_note",
								"Status note",
								"text",
								"status_note",
								{ default: strictNullTextExpression() },
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		const hits = runValidation(doc).filter((error) => error.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			inputLabel: "Status note",
			inputName: "status_note",
			inputUuid,
			surface: "search-input-default",
		});
		expect(userFacingError(hits[0])).toContain(
			'default for search field "Status note"',
		);
		expect(userFacingError(hits[0])).not.toContain("status_note");
		const moved = {
			...hits[0],
			details: {
				...hits[0].details,
				slot: "caseListConfig.searchInputs[8].default",
			},
		};
		expect(errorIdentity(moved)).toBe(errorIdentity(hits[0]));
	});

	it("rejects strict is-null in the assigned-cases expression", () => {
		const doc = buildCaseListDoc({
			filter: eq(prop("patient", "case_name"), literal("Alice")),
			searchEnabled: true,
		});
		const moduleUuid = doc.moduleOrder[0];
		doc.modules[moduleUuid] = {
			...doc.modules[moduleUuid],
			caseSearchConfig: {
				...doc.modules[moduleUuid].caseSearchConfig,
				excludedOwnerIds: strictNullTextExpression(),
			},
		};

		const hits = strictNullFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.surface).toBe("excluded-owner-ids");
		expect(userFacingError(hits[0])).toContain("assigned cases setting");
	});

	it("owns strict-null portability for advanced predicates without a duplicate CSQL finding", () => {
		const doc = buildDoc({
			appName: "Clinic",
			modules: [
				{
					name: "Clients",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("column-name"), "case_name", "Name")],
						searchInputs: [
							advancedSearchInputDef(
								asUuid("input-note"),
								"note",
								"Note",
								"text",
								isNull(prop("patient", "status_note")),
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const errors = runValidation(doc);
		const hits = errors.filter((error) => error.code === CODE);

		expect(hits).toHaveLength(1);
		expect(errors.filter((error) => error.code === CSQL_CODE)).toHaveLength(0);
		expect(userFacingError(hits[0])).toContain('search field "Note"');
		expect(userFacingError(hits[0])).not.toContain('search field "note"');
	});

	it("drops dead advanced strict-null clauses when match-none absorbs the CSQL composition", () => {
		const doc = buildDoc({
			appName: "Clinic",
			modules: [
				{
					name: "Clients",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("column-name"), "case_name", "Name")],
						filter: matchNone(),
						searchInputs: [
							advancedSearchInputDef(
								asUuid("input-note"),
								"note",
								"Note",
								"text",
								isNull(prop("patient", "status_note")),
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		expect(runValidation(doc).filter((error) => error.code === CODE)).toEqual(
			[],
		);
	});

	it("keeps the on-device filter finding when an advanced match-none only absorbs CSQL", () => {
		const doc = buildDoc({
			appName: "Clinic",
			modules: [
				{
					name: "Clients",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("column-name"), "case_name", "Name")],
						filter: isNull(prop("patient", "status_note")),
						searchInputs: [
							advancedSearchInputDef(
								asUuid("input-none"),
								"none",
								"None",
								"text",
								matchNone(),
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		const hits = runValidation(doc).filter((error) => error.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.surface).toBe("filter");
	});

	it("is a stable soundness finding at the export boundary", () => {
		const doc = buildCaseListDoc({
			filter: isNull(prop("patient", "status_note")),
			searchButtonDisplayCondition: isNull(prop("patient", "status_note")),
		});
		const hits = evaluateBoundary(doc, new Map()).filter(
			(error) => error.code === CODE,
		);

		expect(hits).toHaveLength(2);
		expect(classifyError(CODE)).toBe("soundness");
		expect(new Set(hits.map(errorIdentity))).toHaveLength(2);
	});
});
