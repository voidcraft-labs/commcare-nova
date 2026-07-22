import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	advancedSearchInputDef,
	asUuid,
	type CaseSearchConfig,
	type Column,
	calculatedColumn,
	plainColumn,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	anyRelationPath,
	concat,
	count,
	eq,
	exists,
	gt,
	ifExpr,
	literal,
	type Predicate,
	prop,
	relationStep,
	subcasePath,
	term,
	unwrapList,
} from "@/lib/domain/predicate";
import { classifyError, errorIdentity } from "../../../gate";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_EXPRESSION_NOT_ON_DEVICE" as const;

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
		parent_type: "household",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
			{ name: "tags_json", label: "Saved tags", data_type: "text" as const },
		],
	},
	{
		name: "visit",
		parent_type: "patient",
		properties: [{ name: "note", label: "Note", data_type: "text" as const }],
	},
	{
		name: "household",
		parent_type: "program",
		properties: [
			{ name: "district", label: "District", data_type: "text" as const },
		],
	},
	{
		name: "program",
		properties: [
			{ name: "name", label: "Program", data_type: "text" as const },
		],
	},
	{
		name: "followup",
		parent_type: "visit",
		properties: [{ name: "note", label: "Note", data_type: "text" as const }],
	},
];

function listUnwrap() {
	return unwrapList(term(literal('["north","south"]')));
}

function childNote() {
	return term(prop("patient", "note", subcasePath("parent", "visit")));
}

interface FixtureArgs {
	readonly columns?: Column[];
	readonly searchInputs?: SearchInputDef[];
	readonly filter?: Predicate;
	readonly caseSearchConfig?: CaseSearchConfig;
}

function errorsFor(args: FixtureArgs) {
	const doc = buildDoc({
		appName: "Clinic",
		modules: [
			{
				name: "Clients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(asUuid("column-name"), "case_name", "Name"),
						...(args.columns ?? []),
					],
					...(args.filter !== undefined ? { filter: args.filter } : {}),
					searchInputs: args.searchInputs ?? [],
				},
				...(args.caseSearchConfig !== undefined
					? { caseSearchConfig: args.caseSearchConfig }
					: {}),
				forms: [standardForm],
			},
		],
		caseTypes: standardCaseTypes,
	});
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
}

function findingsFor(args: FixtureArgs) {
	return errorsFor(args).filter((error) => error.code === CODE);
}

describe("onDeviceExpressionCompatibility", () => {
	it("rejects unwrap-list anywhere inside the effective case-list filter", () => {
		const hits = findingsFor({
			filter: eq(prop("patient", "tags_json"), listUnwrap()),
		});
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			reason: "unwrap-list",
			slot: "caseListConfig.filter",
			surface: "filter",
		});
		expect(userFacingError(hits[0])).toContain("Cases available rule");
	});

	it("checks latent calculated definitions before a visibility toggle can activate them", () => {
		const columnUuid = asUuid("column-list");
		const hits = findingsFor({
			columns: [
				calculatedColumn(columnUuid, "Saved regions", listUnwrap(), {
					visibleInList: false,
					visibleInDetail: false,
				}),
			],
		});
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			columnLabel: "Saved regions",
			columnUuid,
			surface: "calculated-column",
		});
		expect(userFacingError(hits[0])).toContain(
			'calculation for field "Saved regions"',
		);
	});

	it("rejects a multi-valued child read in a standalone calculated value", () => {
		const hits = findingsFor({
			columns: [
				calculatedColumn(asUuid("column-note"), "Visit note", childNote()),
			],
		});
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			caseType: "patient",
			property: "note",
			reason: "multi-valued-relation-read",
			relationKind: "subcase",
		});
		expect(userFacingError(hits[0])).toContain("Count related cases");
	});

	it("rejects a direction-agnostic related property read in a scalar value", () => {
		const hits = findingsFor({
			columns: [
				calculatedColumn(
					asUuid("column-any-note"),
					"Related note",
					term(prop("patient", "note", anyRelationPath("parent", "visit"))),
				),
			],
		});
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			reason: "multi-valued-relation-read",
			relationKind: "any-relation",
		});
	});

	it("admits a direction-agnostic scalar read when the graph proves it parent-only", () => {
		expect(
			errorsFor({
				columns: [
					calculatedColumn(
						asUuid("column-parent-district"),
						"Parent district",
						term(
							prop(
								"patient",
								"district",
								anyRelationPath("parent", "household"),
							),
						),
					),
				],
			}),
		).toEqual([]);
	});

	it("checks simple and advanced search-input defaults with stable attribution", () => {
		const simpleUuid = asUuid("input-simple");
		const advancedUuid = asUuid("input-advanced");
		const hits = findingsFor({
			searchInputs: [
				simpleSearchInputDef(
					simpleUuid,
					"query",
					"Query",
					"text",
					"case_name",
					{ default: childNote() },
				),
				advancedSearchInputDef(
					advancedUuid,
					"saved_tags",
					"Saved tags",
					"text",
					eq(prop("patient", "case_name"), literal("Alice")),
					{ default: listUnwrap() },
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
		const moved = {
			...hits[1],
			details: {
				...hits[1].details,
				slot: "caseListConfig.searchInputs[99].default",
			},
		};
		expect(errorIdentity(moved)).toBe(errorIdentity(hits[1]));
	});

	it("checks the assigned-cases scalar expression", () => {
		const hits = findingsFor({
			caseSearchConfig: { excludedOwnerIds: childNote() },
		});
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.surface).toBe("excluded-owner-ids");
		expect(userFacingError(hits[0])).toContain("assigned cases setting");
	});

	it("rejects unwrap-list inside the search-button predicate", () => {
		const hits = findingsFor({
			caseSearchConfig: {
				searchButtonDisplayCondition: eq(
					prop("patient", "tags_json"),
					listUnwrap(),
				),
			},
		});
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.surface).toBe("search-button");
		expect(userFacingError(hits[0])).toContain("Search button condition");
	});

	it("preserves genuine server-native unwrap-list in an advanced predicate", () => {
		const hits = findingsFor({
			searchInputs: [
				advancedSearchInputDef(
					asUuid("input-native"),
					"tags",
					"Tags",
					"text",
					eq(prop("patient", "tags_json"), listUnwrap()),
				),
			],
		});
		expect(hits).toEqual([]);
	});

	it("rejects unwrap-list only when a non-native CSQL value subtree moves on-device", () => {
		const hits = findingsFor({
			searchInputs: [
				advancedSearchInputDef(
					asUuid("input-runtime"),
					"tags",
					"Tags",
					"text",
					eq(
						prop("patient", "tags_json"),
						concat(term(literal("")), listUnwrap()),
					),
				),
			],
		});
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			reason: "unwrap-list",
			surface: "advanced-input",
		});
	});

	it("leaves relation reads in predicate scopes to the quantifier normalizer", () => {
		// Per-case slots only: the display condition is a GLOBAL slot where
		// any relation read is rejected by its own case-data rule
		// (`CASE_SEARCH_BUTTON_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE`),
		// so it can't host this fixture's shared comparison.
		const relatedComparison = eq(childNote(), literal("complete"));
		const args = {
			filter: relatedComparison,
			columns: [
				calculatedColumn(
					asUuid("column-flag"),
					"Has complete visit",
					ifExpr(relatedComparison, term(literal("Yes")), term(literal("No"))),
				),
			],
		} satisfies FixtureArgs;
		expect(errorsFor(args)).toEqual([]);
	});

	it("admits single-valued ancestor reads and explicit related-case counts", () => {
		const ancestor = term(
			prop(
				"patient",
				"district",
				ancestorPath(relationStep("parent", "household")),
			),
		);
		const args = {
			columns: [
				calculatedColumn(asUuid("column-parent"), "District", ancestor),
				calculatedColumn(
					asUuid("column-count"),
					"Visits",
					count(subcasePath("parent", "visit")),
				),
			],
		} satisfies FixtureArgs;
		expect(errorsFor(args)).toEqual([]);
	});

	it("admits a child count anchored to a singleton ancestor scope", () => {
		const filter = exists(
			ancestorPath(relationStep("parent", "household")),
			gt(count(subcasePath("parent", "patient")), term(literal(0))),
		);
		expect(errorsFor({ filter })).toEqual([]);
	});

	it("admits a child count when an either-direction path is graph-proven ancestor-only", () => {
		// From patient, household is exclusively the parent destination. The
		// canonicalizer narrows this legacy either-direction path to ancestor,
		// retaining the same singleton anchor as the explicit ancestor shape.
		const filter = exists(
			anyRelationPath("parent", "household"),
			gt(count(subcasePath("parent", "patient")), term(literal(0))),
		);
		expect(errorsFor({ filter })).toEqual([]);
	});

	it("admits a child count after a multi-hop singleton ancestor chain", () => {
		const filter = exists(
			ancestorPath(
				relationStep("parent", "household"),
				relationStep("parent", "program"),
			),
			gt(count(subcasePath("parent", "household")), term(literal(0))),
		);
		expect(errorsFor({ filter })).toEqual([]);
	});

	it("rejects a child count nested under a multi-case child scope", () => {
		const filter = exists(
			subcasePath("parent", "visit"),
			gt(count(subcasePath("parent", "followup")), term(literal(0))),
		);
		const hits = findingsFor({ filter });
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			reason: "nested-multi-case-count",
			relationKind: "subcase",
		});
	});

	it("rejects a child count nested under an either-direction scope", () => {
		const filter = exists(
			anyRelationPath("parent", "visit"),
			gt(count(subcasePath("parent", "followup")), term(literal(0))),
		);
		const hits = findingsFor({ filter });
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			reason: "nested-multi-case-count",
			relationKind: "subcase",
		});
	});

	it("classifies the compatibility finding as soundness", () => {
		const [finding] = findingsFor({
			columns: [
				calculatedColumn(asUuid("column-note"), "Visit note", childNote()),
			],
		});
		expect(classifyError(finding.code)).toBe("soundness");
	});
});
