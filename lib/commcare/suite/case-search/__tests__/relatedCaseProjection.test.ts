import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { type Column, calculatedColumn } from "@/lib/domain";
import {
	ancestorPath,
	anyRelationPath,
	count,
	double,
	prop,
	type RelationEvaluationScopeContext,
	relationStep,
	selfPath,
	subcasePath,
	term,
} from "@/lib/domain/predicate";
import {
	classifyRelatedCaseSearchExpression,
	searchNeedsSupportingCases,
} from "../relatedCaseProjection";

const PARENT_GRAPH: RelationEvaluationScopeContext = {
	caseTypes: [
		{ name: "patient", properties: [], parent_type: "household" },
		{ name: "household", properties: [] },
	],
};

function configWith(columns: Column[]) {
	return resolveCaseListConfig({ columns, searchInputs: [] });
}

describe("classifyRelatedCaseSearchExpression", () => {
	it("classifies current-case expressions as unrelated", () => {
		expect(
			classifyRelatedCaseSearchExpression(term(prop("patient", "case_name"))),
		).toEqual({ kind: "none" });
		expect(
			classifyRelatedCaseSearchExpression(
				term(prop("patient", "case_name", selfPath())),
			),
		).toEqual({ kind: "none" });
		expect(classifyRelatedCaseSearchExpression(count(selfPath()))).toEqual({
			kind: "none",
		});
	});

	it("projects an exact ancestor property to a typed context-relative HQ expression", () => {
		const expression = term(
			prop(
				"patient",
				"case_id",
				ancestorPath(
					relationStep("parent", "household"),
					relationStep("host", "organization"),
				),
			),
		);

		expect(classifyRelatedCaseSearchExpression(expression)).toEqual({
			kind: "ancestor-property",
			hqExpression:
				"current()/../case[@case_id=current()/../case[@case_id=current()/index/parent and @case_type='household']/index/host and @case_type='organization']/@case_id",
		});
	});

	it("projects every reserved case attribute through Nova's wire mapping", () => {
		for (const property of ["case_id", "case_type", "owner_id", "status"]) {
			expect(
				classifyRelatedCaseSearchExpression(
					term(
						prop(
							"patient",
							property,
							ancestorPath(relationStep("parent", "household")),
						),
					),
				),
			).toEqual({
				kind: "ancestor-property",
				hqExpression: `current()/../case[@case_id=current()/index/parent and @case_type='household']/@${property}`,
			});
		}
	});

	it("uses the case graph to narrow an any-relation parent walk", () => {
		const expression = term(
			prop("patient", "region", anyRelationPath("parent", "household")),
		);

		expect(
			classifyRelatedCaseSearchExpression(expression, PARENT_GRAPH),
		).toEqual({
			kind: "ancestor-property",
			hqExpression:
				"current()/../case[@case_id=current()/index/parent and @case_type='household']/region",
		});
	});

	it("keeps child, ambiguous, and calculated relation reads unsupported", () => {
		const parent = ancestorPath(relationStep("parent", "household"));
		const childGraph: RelationEvaluationScopeContext = {
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "patient", properties: [], parent_type: "household" },
			],
		};
		const recursiveGraph: RelationEvaluationScopeContext = {
			caseTypes: [{ name: "person", properties: [], parent_type: "person" }],
		};

		expect(
			classifyRelatedCaseSearchExpression(
				term(
					prop("household", "case_name", anyRelationPath("parent", "patient")),
				),
				childGraph,
			),
		).toEqual({ kind: "unsupported" });
		expect(
			classifyRelatedCaseSearchExpression(
				term(prop("person", "case_name", anyRelationPath("parent", "person"))),
				recursiveGraph,
			),
		).toEqual({ kind: "unsupported" });
		expect(
			classifyRelatedCaseSearchExpression(
				term(prop("household", "case_name", subcasePath("parent", "patient"))),
			),
		).toEqual({ kind: "unsupported" });
		expect(
			classifyRelatedCaseSearchExpression(
				double(term(prop("patient", "region", parent))),
			),
		).toEqual({ kind: "unsupported" });
		expect(classifyRelatedCaseSearchExpression(count(parent))).toEqual({
			kind: "unsupported",
		});
	});

	it("keeps a user-named case relation literal in the calculated expression", () => {
		expect(
			classifyRelatedCaseSearchExpression(
				term(
					prop(
						"patient",
						"case_name",
						ancestorPath(relationStep("user", "household")),
					),
				),
			),
		).toEqual({
			kind: "ancestor-property",
			hqExpression:
				"current()/../case[@case_id=current()/index/user and @case_type='household']/case_name",
		});
	});
});

describe("searchNeedsSupportingCases", () => {
	const parentRegion = term(
		prop(
			"patient",
			"region",
			ancestorPath(relationStep("parent", "household")),
		),
	);

	it("derives support only from emitted related calculations", () => {
		const visibleRelated = calculatedColumn(
			testUuid("visible-related"),
			"Region",
			parentRegion,
		);
		const visibleSelf = calculatedColumn(
			testUuid("visible-self"),
			"Name",
			term(prop("patient", "case_name")),
		);
		const dormantRelated = calculatedColumn(
			testUuid("dormant-related"),
			"Dormant region",
			parentRegion,
			{ visibleInList: false, visibleInDetail: false },
		);
		const sortOnlyRelated = calculatedColumn(
			testUuid("sort-related"),
			"Sort region",
			parentRegion,
			{
				visibleInList: false,
				visibleInDetail: false,
				sort: { direction: "asc", priority: 0 },
			},
		);

		expect(
			searchNeedsSupportingCases(configWith([visibleSelf]), PARENT_GRAPH),
		).toBe(false);
		expect(
			searchNeedsSupportingCases(configWith([dormantRelated]), PARENT_GRAPH),
		).toBe(false);
		expect(
			searchNeedsSupportingCases(configWith([visibleRelated]), PARENT_GRAPH),
		).toBe(true);
		expect(
			searchNeedsSupportingCases(configWith([sortOnlyRelated]), PARENT_GRAPH),
		).toBe(true);
	});
});
