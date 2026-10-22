/**
 * Whether a search's own filter reads related cases, the shape HQ's case
 * search refuses without its related-case lookups. The answer is what the
 * CSQL emitter writes: HQ's compiler gates `ancestor-exists`,
 * `subcase-exists` and `subcase-count` (`case_search/filter_dsl.py::
 * build_filter_from_ast`). What HQ's compiler does with each shape is the
 * proof lane's (`proof/hq/test_flag_probe.py`).
 */
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import { type CaseListConfig, type CaseType, proseText } from "@/lib/domain";
import {
	ancestorPath,
	count,
	eq,
	exists,
	gt,
	literal,
	missing,
	prop,
	relationStep,
	subcasePath,
	term,
} from "@/lib/domain/expression";
import type { Expression } from "@/lib/domain/expression/types";
import { xpathQueryUsesRelatedLookup } from "../xpathQuery";

const parent = ancestorPath(relationStep("parent"));
const visits = subcasePath("parent", "visit");

const caseTypes: CaseType[] = [
	{
		name: "household",
		properties: [
			{ name: "region", label: proseText("Region"), data_type: "text" },
		],
	},
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{ name: "region", label: proseText("Region"), data_type: "text" },
			{ name: "age", label: proseText("Age"), data_type: "int" },
		],
	},
	{
		name: "visit",
		parent_type: "patient",
		properties: [{ name: "kind", label: proseText("Kind"), data_type: "text" }],
	},
];

function uses(filter: Expression | undefined): boolean {
	const config: CaseListConfig = {
		columns: [],
		listColumnOrder: [],
		detailColumnOrder: [],
		searchInputs: [],
		...(filter === undefined ? {} : { filter }),
	};
	const doc = buildDoc({
		caseTypes,
		modules: [
			{ name: "Cases", caseType: "patient", caseListConfig: config, forms: [] },
		],
	});
	return xpathQueryUsesRelatedLookup(
		config,
		"patient",
		moduleExpressionContexts(
			doc,
			doc.moduleOrder[0],
		)({ slot: "case_list_filter" }),
	);
}

describe("xpathQueryUsesRelatedLookup", () => {
	it.each([
		["an exists over a relation", exists(visits)],
		["a missing over a relation", missing(parent)],
		["a subcase count on a comparison's left", gt(count(visits), literal(2))],
		[
			"a comparison on an ancestor's property",
			eq(term(prop("patient", "region", parent)), literal("north")),
		],
		[
			"a comparison on an ancestor's case id, which the emitter writes as ancestor-exists",
			eq(term(prop("patient", "case_id", parent)), literal("abc")),
		],
	])("reads %s as a related lookup", (_, predicate) => {
		expect(uses(predicate)).toBe(true);
	});

	// A count anywhere but a child-case count on a comparison's left, an
	// ancestor count among them, never reaches the wire: the composition
	// refuses it as CSQL cannot carry it (`csqlRepresentability.ts`), as the
	// validator does first. So every count a valid search holds is a
	// `subcase-count` and needs the flag.
	it("refuses an ancestor count rather than answer for it", () => {
		expect(() => uses(gt(count(parent), literal(0)))).toThrow(
			/not representable/,
		);
	});

	it.each([
		["no filter", undefined],
		[
			"a comparison on the case's own property",
			eq(term(prop("patient", "region")), literal("north")),
		],
	])("reads %s as needing nothing", (_, predicate) => {
		expect(uses(predicate)).toBe(false);
	});
});
