import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	blueprintDocSchema,
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
	type Expression,
	prop,
	relationStep,
	term,
} from "@/lib/domain/expression";
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
	expression: Expression,
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
				caseListMenuItem: {},
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

	blueprintDocSchema.parse(toPersistableDoc(doc));
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
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
	] satisfies ReadonlyArray<readonly [string, Expression]>)(
		"allows %s",
		(_label, expression) => {
			expect(findingsFor(expression)).toEqual([]);
		},
	);

	it.each([
		["a wrapped ancestor property", unsupportedWrapped],
		["a related-case count", count(parent)],
	] satisfies ReadonlyArray<readonly [string, Expression]>)(
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

	it.each([
		["a link this app does not declare", "host"],
		["the declared parent link", "parent"],
	] as const)(
		"refuses, by name, a reached read through %s, which Search can't supply",
		(_label, identifier) => {
			// `property('patient', 'region', reached('<link>'))`: a read of whatever
			// case the index names, of any type. Without Search the list reads it.
			const reached: Expression = {
				kind: "term",
				term: {
					kind: "prop",
					caseType: "patient",
					property: "region",
					via: { kind: "ancestor", via: [{ identifier }] },
					readReached: true,
				},
			};
			expect(findingsFor(reached, { search: "none" })).toEqual([]);
			for (const search of ["explicit", "markerless"] as const) {
				const findings = findingsFor(reached, { search }).filter(
					(finding) => finding.code === CODE,
				);
				expect(findings).toHaveLength(1);
				expect(findings[0]?.details).toMatchObject({
					columnUuid: testUuid("column-related"),
					reason: "reached",
				});
				expect(userFacingError(findings[0])).toBe(
					'In "Patients", "Related value" reads whichever case its link reaches, of any type, and Search can\'t supply that case. You can read the parent through a link this app declares, build the calculation from the current case, or delete it.',
				);
			}
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
