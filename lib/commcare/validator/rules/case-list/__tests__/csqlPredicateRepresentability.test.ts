import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * CSQL is narrower than Nova's predicate AST: a server-side case-search
 * comparison needs one query anchor, and the remaining value must not read a
 * case row. These tests pin the validator at that exact wire boundary while
 * leaving ordinary on-device case-list filters alone.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { emitCsql } from "@/lib/commcare/predicate";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import { advancedSearchInputDef, asUuid, plainColumn } from "@/lib/domain";
import {
	ancestorPath,
	arith,
	concat,
	count,
	dateAdd,
	eq,
	exists,
	gt,
	isIn,
	isNull,
	literal,
	lt,
	matchAll,
	matchNone,
	multiSelectAny,
	or,
	type Predicate,
	prop,
	relationStep,
	selfPath,
	subcasePath,
	term,
	today,
} from "@/lib/domain/predicate";
import { classifyError, errorIdentity, evaluateBoundary } from "../../../gate";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_CSQL_NOT_REPRESENTABLE" as const;

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
			{ name: "age", label: "Age", data_type: "int" as const },
			{ name: "score", label: "Score", data_type: "int" as const },
			{
				name: "tags",
				label: "Tags",
				data_type: "multi_select" as const,
			},
		],
	},
	{
		name: "household",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
		],
	},
];

function docWithFilter(
	filter: Predicate,
	options: { readonly searchEnabled?: boolean } = {},
) {
	return buildDoc({
		appName: "Clinic",
		modules: [
			{
				uuid: "module-clients",
				name: "Clients",
				caseType: "patient",
				caseListConfig: {
					columns: [plainColumn(asUuid("column-name"), "case_name", "Name")],
					filter,
					searchInputs: [],
				},
				...(options.searchEnabled === false ? {} : { caseSearchConfig: {} }),
				forms: [standardForm],
			},
		],
		caseTypes: standardCaseTypes,
	});
}

function csqlFindings(doc: ReturnType<typeof docWithFilter>) {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
		(error) => error.code === CODE,
	);
}

function docWithAdvancedPredicate(predicate: Predicate) {
	return buildDoc({
		appName: "Clinic",
		modules: [
			{
				uuid: "module-clients",
				name: "Clients",
				caseType: "patient",
				caseListConfig: {
					columns: [plainColumn(asUuid("column-name"), "case_name", "Name")],
					searchInputs: [
						advancedSearchInputDef(
							asUuid("input-condition"),
							"condition_value",
							"Condition value",
							"text",
							predicate,
						),
					],
				},
				forms: [standardForm],
			},
		],
		caseTypes: standardCaseTypes,
	});
}

function docWithFilterAndAdvanced(
	filter: Predicate,
	advancedPredicate: Predicate,
) {
	const doc = docWithAdvancedPredicate(advancedPredicate);
	const moduleUuid = doc.moduleOrder[0];
	const mod = doc.modules[moduleUuid];
	if (mod.caseListConfig === undefined) {
		throw new Error("expected case-list config");
	}
	doc.modules[moduleUuid] = {
		...mod,
		caseListConfig: { ...mod.caseListConfig, filter },
	};
	return doc;
}

describe("csqlPredicateRepresentability", () => {
	it("accepts a property authored on the RHS when normalization can swap and invert the comparison", () => {
		const doc = docWithFilter(lt(literal(18), prop("patient", "age")));

		expect(csqlFindings(doc)).toEqual([]);
	});

	it("does not apply the CSQL restriction to an ordinary on-device case-list filter", () => {
		const doc = docWithFilter(
			eq(prop("patient", "age"), prop("patient", "score")),
			{ searchEnabled: false },
		);

		expect(csqlFindings(doc)).toEqual([]);
	});

	it("uses the same search-only restriction at the mutation commit gate", () => {
		const searchable = docWithFilter(eq(prop("patient", "age"), literal(18)));
		const onDevice = docWithFilter(eq(prop("patient", "age"), literal(18)), {
			searchEnabled: false,
		});
		const unsupported = eq(prop("patient", "age"), prop("patient", "score"));
		const mutation = (moduleUuid: (typeof searchable.moduleOrder)[number]) => [
			{
				kind: "setCaseListMeta" as const,
				uuid: moduleUuid,
				patch: { filter: unsupported },
			},
		];

		const rejected = mutationCommitVerdict(
			searchable,
			mutation(searchable.moduleOrder[0]),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error("Expected search-backed edit to fail");
		expect(rejected.introduced.map((error) => error.code)).toContain(CODE);

		expect(
			mutationCommitVerdict(
				onDevice,
				mutation(onDevice.moduleOrder[0]),
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(true);
	});

	it("does not reject an unrepresentable branch removed by wire simplification", () => {
		const doc = docWithFilter(
			or(matchAll(), eq(prop("patient", "age"), prop("patient", "score"))),
		);

		expect(csqlFindings(doc)).toEqual([]);
	});

	it("simplifies dead branches inside an advanced predicate before checking", () => {
		const doc = docWithAdvancedPredicate(
			or(matchAll(), eq(prop("patient", "age"), prop("patient", "score"))),
		);

		expect(csqlFindings(doc)).toEqual([]);
	});

	it("returns no CSQL findings when match-none absorbs invalid sibling slots", () => {
		const doc = docWithFilterAndAdvanced(
			matchNone(),
			eq(prop("patient", "age"), prop("patient", "score")),
		);

		expect(csqlFindings(doc)).toEqual([]);
	});

	it("rejects an authored fixed value that CSQL cannot quote", () => {
		const predicate = eq(
			prop("patient", "case_name"),
			literal(`it's "quoted"`),
		);
		const doc = docWithFilter(predicate);

		const hits = csqlFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			reason: "csql-string-not-quotable",
			path: "right",
			slot: "caseListConfig.filter",
		});
		expect(userFacingError(hits[0])).toContain(
			"includes both single and double quotation marks in the same fixed value",
		);
		// Defense in depth remains load-bearing for callers that bypass the
		// document gate; the friendly finding above prevents this throw in the
		// normal compile/export path.
		expect(() => emitCsql(predicate)).toThrow("no portable escape");
	});

	it("checks every fixed value emitted by literal-list operators", () => {
		const inDoc = docWithFilter(
			isIn(
				prop("patient", "case_name"),
				literal("safe"),
				literal(`it's "not safe"`),
			),
		);
		const multiSelectDoc = docWithFilter(
			multiSelectAny(prop("patient", "tags"), literal(`team's "priority"`)),
		);

		expect(csqlFindings(inDoc)[0].details).toMatchObject({
			reason: "csql-string-not-quotable",
			path: "values.[1]",
		});
		expect(csqlFindings(multiSelectDoc)[0].details).toMatchObject({
			reason: "csql-string-not-quotable",
			path: "values.[0]",
		});
	});

	it("rejects a statically unquotable on-device value before its runtime guard", () => {
		const doc = docWithFilter(
			eq(
				prop("patient", "case_name"),
				concat(term(literal("'")), term(literal('"'))),
			),
		);

		const hits = csqlFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			reason: "csql-string-not-quotable",
			path: "right",
		});
	});

	it("does not report a fixed quote value in a CSQL composition absorbed by match-none", () => {
		const doc = docWithFilterAndAdvanced(
			matchNone(),
			eq(prop("patient", "case_name"), literal(`it's "quoted"`)),
		);

		expect(csqlFindings(doc)).toEqual([]);
	});

	it("rejects comparing one case property with another", () => {
		const doc = docWithFilter(
			eq(prop("patient", "age"), prop("patient", "score")),
		);

		const hits = csqlFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			reason: "case-property-on-value-side",
			path: "right",
			slot: "caseListConfig.filter",
		});
		expect(userFacingError(hits[0])).toContain("compares two case properties");
		expect(userFacingError(hits[0])).not.toMatch(/CCHQ|CSQL|server query/i);
	});

	it("uses plain repair copy for cross-case and calendar-value findings", () => {
		const crossCase = csqlFindings(
			docWithFilter(
				eq(
					prop("patient", "age"),
					prop(
						"patient",
						"case_name",
						ancestorPath(relationStep("parent", "household")),
					),
				),
			),
		)[0];
		const calendar = csqlFindings(
			docWithFilter(
				eq(
					prop("patient", "case_name"),
					dateAdd(today(), "months", term(literal(1.5))),
				),
			),
		)[0];

		expect(crossCase.details).toMatchObject({
			reason: "multiple-property-scopes",
		});
		expect(userFacingError(crossCase)).toContain(
			"compares properties from different cases",
		);
		expect(calendar.details).toMatchObject({
			reason: "calendar-date-add-needs-whole-number",
		});
		expect(userFacingError(calendar)).toContain("whole number");
		for (const hit of [crossCase, calendar]) {
			expect(hit.message).not.toMatch(/CCHQ|CSQL|server query/i);
			expect(userFacingError(hit)).not.toMatch(/CCHQ|CSQL|server query/i);
		}
	});

	it("rejects a comparison with no case-property query anchor", () => {
		const doc = docWithFilter(eq(literal(1), literal(2)));

		const hits = csqlFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			reason: "comparison-needs-case-property",
			path: "left",
		});
	});

	it("rejects a parent-case count in the query-anchor position", () => {
		const doc = docWithFilter(
			gt(count(ancestorPath(relationStep("parent", "household"))), literal(0)),
		);

		const hits = csqlFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			reason: "unsupported-related-count",
			path: "left",
		});
	});

	it("accepts a child-case count as the CSQL query anchor", () => {
		const doc = docWithFilter(
			gt(count(subcasePath("parent", "household")), literal(0)),
		);

		expect(csqlFindings(doc)).toEqual([]);
	});

	it("delegates strict-null to the portable-null rule without a duplicate CSQL finding", () => {
		const doc = docWithAdvancedPredicate(isNull(prop("patient", "case_name")));

		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors.filter((error) => error.code === CODE)).toHaveLength(0);
		const portableHits = errors.filter(
			(error) => error.code === "CASE_LIST_STRICT_NULL_NOT_PORTABLE",
		);
		expect(portableHits).toHaveLength(1);
		expect(userFacingError(portableHits[0])).toContain(
			'search field "Condition value"',
		);
		expect(userFacingError(portableHits[0])).not.toContain("CCHQ");
	});

	it("rejects a self relationship envelope", () => {
		const doc = docWithFilter(
			exists(selfPath(), eq(prop("patient", "case_name"), literal("Alice"))),
		);

		const hits = csqlFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			reason: "self-relation-not-queryable",
			path: "exists.via",
		});
	});

	it("finds a case-property read nested inside a runtime value expression", () => {
		const doc = docWithFilter(
			eq(
				prop("patient", "age"),
				arith("+", term(prop("patient", "score")), term(literal(1))),
			),
		);

		const hits = csqlFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			reason: "case-property-on-value-side",
			path: "right.left",
		});
	});

	it("attributes advanced-input findings to the stable input identity", () => {
		const inputUuid = asUuid("input-score");
		const doc = buildDoc({
			appName: "Clinic",
			modules: [
				{
					uuid: "module-clients",
					name: "Clients",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("column-name"), "case_name", "Name")],
						filter: eq(prop("patient", "age"), prop("patient", "score")),
						searchInputs: [
							advancedSearchInputDef(
								inputUuid,
								"minimum_score",
								"Minimum score",
								"text",
								eq(prop("patient", "score"), prop("patient", "age")),
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(error) => error.code === CODE,
		);
		expect(hits).toHaveLength(2);
		const inputHit = hits.find(
			(error) => error.details?.inputUuid === inputUuid,
		);
		if (inputHit === undefined) throw new Error("expected advanced-input hit");
		expect(inputHit.details).toMatchObject({
			inputName: "minimum_score",
			inputLabel: "Minimum score",
			inputUuid,
			reason: "case-property-on-value-side",
			slot: "caseListConfig.searchInputs[0].predicate",
		});
		expect(inputHit.message).toContain('advanced search input "Minimum score"');
		expect(userFacingError(inputHit)).toContain('search field "Minimum score"');
		expect(userFacingError(inputHit)).not.toContain("minimum_score");
		expect(new Set(hits.map(errorIdentity))).toHaveLength(2);
		expect(
			errorIdentity({
				...inputHit,
				details: {
					...inputHit.details,
					slot: "caseListConfig.searchInputs[7].predicate",
				},
			}),
		).toBe(errorIdentity(inputHit));
	});

	it("is a soundness finding that rejects the zero-tolerance export boundary", () => {
		const doc = docWithFilter(
			eq(prop("patient", "age"), prop("patient", "score")),
		);

		const boundaryHits = evaluateBoundary(
			doc,
			new Map(),
			LOOKUP_CONTEXT_UNAVAILABLE,
		).filter((error) => error.code === CODE);
		expect(boundaryHits).toHaveLength(1);
		expect(classifyError(CODE)).toBe("soundness");
	});
});
