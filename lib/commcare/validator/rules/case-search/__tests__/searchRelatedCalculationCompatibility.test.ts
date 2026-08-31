import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type CaseType,
	calculatedColumn,
	plainColumn,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	anyRelationPath,
	count,
	double,
	prop,
	relationStep,
	subcasePath,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

const CODE = "CASE_SEARCH_RELATED_CALCULATION_UNREPRESENTABLE" as const;

const CASE_TYPES: CaseType[] = [
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{
				name: "case_name",
				label: proseText("Name"),
				data_type: "text",
			},
		],
	},
	{
		name: "household",
		properties: [
			{
				name: "region",
				label: proseText("Region"),
				data_type: "text",
			},
			{
				name: "score",
				label: proseText("Score"),
				data_type: "int",
			},
		],
	},
	{
		name: "visit",
		parent_type: "patient",
		properties: [
			{
				name: "note",
				label: proseText("Note"),
				data_type: "text",
			},
		],
	},
];

const parent = ancestorPath(relationStep("parent", "household"));
const unsupportedWrapped = double(term(prop("patient", "score", parent)));

type SearchActivation = "none" | "explicit" | "markerless";

function findingsFor(
	expression: ValueExpression,
	options: {
		search?: SearchActivation;
		columnSlots?: Parameters<typeof calculatedColumn>[3];
	} = {},
) {
	const search = options.search ?? "explicit";
	const nameColumn = plainColumn(
		testUuid("column-case-name"),
		"case_name",
		"Name",
	);
	const calculated = calculatedColumn(
		testUuid("column-related"),
		"Related value",
		expression,
		options.columnSlots,
	);
	const doc = buildDoc({
		appName: "Test",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListOnly: true,
				caseListConfig: {
					columns: [nameColumn, calculated],
					listColumnOrder: [nameColumn.uuid, calculated.uuid],
					detailColumnOrder: [nameColumn.uuid, calculated.uuid],
					searchInputs:
						search === "markerless"
							? [
									simpleSearchInputDef(
										testUuid("search-case-name"),
										"case_name",
										"Name",
										"text",
										"case_name",
									),
								]
							: [],
				},
				...(search === "explicit" ? { caseSearchConfig: {} } : {}),
			},
		],
		caseTypes: CASE_TYPES,
	});

	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
		(finding) => finding.code === CODE,
	);
}

describe("searchRelatedCalculationCompatibility", () => {
	it("follows effective Search for explicit and markerless activation", () => {
		expect(findingsFor(unsupportedWrapped, { search: "none" })).toEqual([]);
		expect(
			findingsFor(unsupportedWrapped, { search: "explicit" }),
		).toHaveLength(1);
		expect(
			findingsFor(unsupportedWrapped, { search: "markerless" }),
		).toHaveLength(1);
	});

	it.each([
		["an exact ancestor property", term(prop("patient", "region", parent))],
		[
			"an any-parent relation the case graph resolves upward",
			term(prop("patient", "region", anyRelationPath("parent", "household"))),
		],
		[
			"a parent relation whose identifier is user",
			term(
				prop(
					"patient",
					"region",
					ancestorPath(relationStep("user", "household")),
				),
			),
		],
	] satisfies ReadonlyArray<readonly [string, ValueExpression]>)(
		"allows %s",
		(_label, expression) => {
			expect(findingsFor(expression)).toEqual([]);
		},
	);

	it.each([
		[
			"a subcase property",
			term(prop("patient", "note", subcasePath("parent", "visit"))),
		],
		[
			"an ambiguous relation",
			term(prop("patient", "case_name", anyRelationPath("parent"))),
		],
		["a wrapped ancestor property", unsupportedWrapped],
		["a related-case count", count(parent)],
	] satisfies ReadonlyArray<readonly [string, ValueExpression]>)(
		"rejects %s",
		(_label, expression) => {
			const findings = findingsFor(expression);
			expect(findings).toHaveLength(1);
			expect(findings[0]).toMatchObject({
				code: CODE,
				location: { moduleName: "Patients" },
				details: {
					columnUuid: testUuid("column-related"),
					columnHeader: "Related value",
					index: "1",
					slot: "caseListConfig.columns[1].expression",
					registrySlot: "case_list_column_expression",
				},
			});
			expect(findings[0]?.message).toContain(
				"uses related-case information that Search can't show consistently",
			);
			expect(userFacingError(findings[0])).toBe(
				'In "Patients", "Related value" uses related-case information that Search can\'t show consistently. Show one parent property by itself, build the calculation from the current case, or delete this calculated item.',
			);
		},
	);

	it("rejects a fully hidden, unsorted definition before it can be revealed", () => {
		expect(
			findingsFor(unsupportedWrapped, {
				columnSlots: {
					visibleInList: false,
					visibleInDetail: false,
				},
			}),
		).toHaveLength(1);
	});

	it("rejects a fully hidden definition that still drives Default order", () => {
		expect(
			findingsFor(unsupportedWrapped, {
				columnSlots: {
					visibleInList: false,
					visibleInDetail: false,
					sort: { direction: "asc", priority: 0 },
				},
			}),
		).toHaveLength(1);
	});
});
