import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	type CaseType,
	type SimpleSearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	anyRelationPath,
	checkPredicate,
	eq,
	input,
	prop,
	relationStep,
	subcasePath,
} from "@/lib/domain/predicate";
import { proseTemplateText, proseText } from "@/lib/domain/prose";
import {
	canSeedCustomConditionFaithfully,
	recoverAnchoredProperty,
	resolveDestinationCaseType,
	resolveProperty,
	resolveRows,
	searchInputDecls,
	seedCustomCondition,
} from "../searchInputResolution";
import { admittedWorkspace, commitWorkspace } from "./admittedWorkspace";

const caseTypes: CaseType[] = [
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{ name: "case_name", label: proseText("Name"), data_type: "text" },
			{ name: "dob", label: proseText("Birth date"), data_type: "date" },
		],
	},
	{
		name: "household",
		properties: [
			{ name: "region", label: proseText("Region"), data_type: "text" },
			{ name: "opened", label: proseText("Opened"), data_type: "date" },
		],
	},
];
function workspace(row: SimpleSearchInputDef) {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [row];
	return admittedWorkspace(caseTypes, config, "patient");
}

describe("Search custom-condition conversion", () => {
	it.each([
		["exact", "text", "region"],
		["fuzzy", "text", "region"],
		["starts-with", "text", "region"],
		["phonetic", "text", "region"],
		["fuzzy-date", "date", "opened"],
	] as const)(
		"commits %s conversion with the parent binding and input envelope intact",
		(kind, type, property) => {
			const via = ancestorPath(relationStep("parent"));
			const row = simpleSearchInputDef(
				testUuid(`convert-${kind}`),
				"query",
				"Query",
				type,
				property,
				{ via, mode: { kind } },
			);
			const { doc, moduleUuid } = workspace(row);
			expect(canSeedCustomConditionFaithfully(row)).toBe(true);
			const predicate = seedCustomCondition(row, "patient");
			expect(predicate).toMatchObject({
				kind: "when-input-present",
				input: { kind: "input", searchInputUuid: row.uuid },
			});
			const advanced = advancedSearchInputDef(
				row.uuid,
				row.name,
				row.label,
				row.type,
				predicate,
			);
			const { uuid, ...searchInput } = advanced;
			const next = commitWorkspace(doc, [
				{ kind: "updateSearchInput", moduleUuid, uuid, searchInput },
			]);
			const saved = next.modules[moduleUuid].caseListConfig?.searchInputs[0];
			expect(saved).toEqual(advanced);
			if (predicate.kind !== "when-input-present")
				throw new Error("missing envelope");
			if (predicate.clause.kind === "eq")
				expect(predicate.clause.left).toMatchObject({
					kind: "term",
					term: { kind: "prop", caseType: "patient", property, via },
				});
			if (predicate.clause.kind === "match")
				expect(predicate.clause.property).toEqual({
					kind: "prop",
					caseType: "patient",
					property,
					via,
				});
			expect(predicate.clause.kind).toBe(kind === "exact" ? "eq" : "match");
			if (predicate.clause.kind === "match")
				expect(predicate.clause.mode).toBe(kind);
			expect(recoverAnchoredProperty(predicate)).toBeUndefined();
		},
	);
	it("commits a self-bound conversion and includes its own declaration in editor scope", () => {
		const row = simpleSearchInputDef(
			testUuid("self-query"),
			"by_name",
			"Client name",
			"text",
			"case_name",
		);
		const { doc, moduleUuid } = workspace(row);
		const predicate = seedCustomCondition(row, "patient");
		const { uuid, ...searchInput } = advancedSearchInputDef(
			row.uuid,
			row.name,
			row.label,
			row.type,
			predicate,
		);
		const next = commitWorkspace(doc, [
			{ kind: "updateSearchInput", moduleUuid, uuid, searchInput },
		]);
		const decls = searchInputDecls(
			next.modules[moduleUuid].caseListConfig?.searchInputs ?? [],
		);
		expect(decls).toEqual([
			{
				uuid: row.uuid,
				name: "by_name",
				label: "Client name",
				data_type: "text",
			},
		]);
		expect(
			checkPredicate(predicate, {
				caseTypes,
				knownInputs: [...decls],
				currentCaseType: "patient",
			}).ok,
		).toBe(true);
		expect(
			checkPredicate(predicate, {
				caseTypes,
				knownInputs: [],
				currentCaseType: "patient",
			}).ok,
		).toBe(false);
		expect(recoverAnchoredProperty(predicate)).toBe("case_name");
	});
	it.each([undefined, { kind: "range" }] as const)(
		"requires a consequence review for date-range conversion (%j)",
		(mode) => {
			const row = simpleSearchInputDef(
				testUuid("range-query"),
				"dob",
				"Date range",
				"date-range",
				"dob",
				mode ? { mode } : {},
			);
			workspace(row);
			expect(canSeedCustomConditionFaithfully(row)).toBe(false);
		},
	);
	it("derives date and date-range runtime declarations from admitted widgets", () => {
		const config = caseListConfig([{ field: "case_name", header: "Name" }]);
		const date = simpleSearchInputDef(
			testUuid("date-query"),
			"by_date",
			"Date",
			"date",
			"dob",
		);
		const range = simpleSearchInputDef(
			testUuid("range-query"),
			"dob",
			"Range",
			"date-range",
			"dob",
		);
		config.searchInputs = [date, range];
		admittedWorkspace(caseTypes, config, "patient");
		expect(searchInputDecls(config.searchInputs)).toEqual([
			{ uuid: date.uuid, name: "by_date", label: "Date", data_type: "date" },
			{ uuid: range.uuid, name: "dob", label: "Range", data_type: "text" },
		]);
	});
});

// Recovery is a lower-level AST shape projection; this deliberately bare input
// predicate is not asserted to be an admissible app condition.
it("recovers a bare self-bound property's identity", () => {
	expect(
		recoverAnchoredProperty(
			eq(prop("patient", "case_name"), input(testUuid("bare-query"))),
		),
	).toBe("case_name");
});

describe("Search property resolution follows the admitted relationship", () => {
	const caseTypes: CaseType[] = [
		{
			name: "patient",
			parent_type: "household",
			properties: [
				{ name: "code", label: proseText("Patient code"), data_type: "text" },
			],
		},
		{
			name: "household",
			parent_type: "district",
			properties: [
				{ name: "code", label: proseText("Household code"), data_type: "text" },
			],
		},
		{
			name: "district",
			properties: [
				{ name: "code", label: proseText("District date"), data_type: "date" },
			],
		},
		{
			name: "visit",
			parent_type: "patient",
			properties: [
				{ name: "code", label: proseText("Visit date"), data_type: "date" },
			],
		},
	];
	it.each([
		[
			"grandparent",
			ancestorPath(relationStep("parent"), relationStep("parent")),
			"district",
		],
		["child", subcasePath("parent", "visit"), "visit"],
		["related child", anyRelationPath("parent", "visit"), "visit"],
		[
			"custom parent",
			ancestorPath(relationStep("referral", "district")),
			"district",
		],
	] as const)(
		"uses the %s property's actual type, not a same-name origin property",
		(_name, via, destination) => {
			const row = simpleSearchInputDef(
				testUuid(`resolve-${destination}`),
				"query",
				"Date",
				"date",
				"code",
				{ via },
			);
			const config = caseListConfig([{ field: "case_name", header: "Name" }]);
			config.searchInputs = [row];
			admittedWorkspace(caseTypes, config, "patient");
			expect(resolveProperty(caseTypes, row, "patient")).toEqual(
				caseTypes.find((c) => c.name === destination)?.properties[0],
			);
			expect(
				resolveRows([row], caseTypes, "patient", (label) =>
					label.parts
						.flatMap((p) => (p.kind === "text" ? [p.text] : []))
						.join(""),
				)[0].typeCouplingErrors,
			).toEqual([]);
		},
	);
});

it("leaves malformed or ambiguous walks unresolved instead of borrowing origin properties", () => {
	expect(
		resolveDestinationCaseType(
			caseTypes,
			ancestorPath(relationStep("parent", "patient")),
			"patient",
		),
	).toBeUndefined();
	expect(
		resolveDestinationCaseType(
			caseTypes,
			ancestorPath(relationStep("parent")),
			"household",
		),
	).toBeUndefined();
	const ambiguous = [
		...caseTypes,
		{ name: "visit", parent_type: "patient", properties: [] },
		{ name: "referral", parent_type: "patient", properties: [] },
	];
	expect(
		resolveDestinationCaseType(ambiguous, subcasePath("parent"), "patient"),
	).toBeUndefined();
	const row = simpleSearchInputDef(
		testUuid("invalid-walk"),
		"query",
		"Name",
		"text",
		"case_name",
		{ via: subcasePath("parent") },
	);
	expect(resolveProperty(ambiguous, row, "patient")).toBeUndefined();
	expect(
		resolveRows([row], ambiguous, "patient", proseTemplateText)[0]
			.propertyState,
	).toEqual({ kind: "dangling", destination: undefined });
});
