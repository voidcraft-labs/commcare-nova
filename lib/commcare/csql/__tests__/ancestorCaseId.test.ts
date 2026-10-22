import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	ancestorPath,
	eq,
	exists,
	literal,
	neq,
	prop,
	relationStep,
	sessionUser,
	term,
} from "@/lib/domain/expression/builders";
import { chosenCaseId } from "@/lib/domain/expression/chosenCase";
import type { Expression } from "@/lib/domain/expression/types";
import { chosenCase } from "../../__tests__/csqlCompositionFixture";
import { moduleExpressionContexts } from "../../expressionContext";
import { caseListStepDatumId } from "../../formLinkProjection";
import {
	type CsqlEmissionContext,
	collectRelatedCaseQueries,
	emitCsqlTree,
} from "../emitter";
import type { CsqlNode } from "../tree";

// HQ's flag-free ancestor comparison (`parent/@case_id = v`) against
// `ancestor-exists`, which always needs CASE_SEARCH_RELATED_LOOKUPS.
// The meaning of each is HQ's and the native family's;
// this holds which spelling the emitter picks and what it reports.
const doc = chosenCase.doc();
const households = testUuid("csql-chosen-case-Households-module");
const members = testUuid("csql-chosen-case-Members by village-module");
const context: CsqlEmissionContext = {
	types: moduleExpressionContexts(doc, members)({ slot: "case_list_filter" }),
	bindings: { datumId: caseListStepDatumId(doc, members) },
};

const parentIs = (value: Expression) =>
	exists(
		ancestorPath(relationStep("parent")),
		eq(prop("household", "case_id"), value),
	);

function emit(predicate: Expression) {
	return collectRelatedCaseQueries(() => emitCsqlTree(predicate, context));
}

/** Every query function the tree calls. */
function calls(node: CsqlNode, out: string[] = []): string[] {
	switch (node.k) {
		case "query-call":
			out.push(node.fn);
			for (const arg of node.args) calls(arg, out);
			break;
		case "cmp":
			calls(node.left, out);
			calls(node.right, out);
			break;
		case "and":
		case "or":
			for (const item of node.items) calls(item, out);
			break;
		case "not":
		case "group":
		case "guarded":
			calls(node.item, out);
			break;
		default:
			break;
	}
	return out;
}

describe("an ancestor case-id equality", () => {
	it("is HQ's flag-free comparison against the case chosen in an earlier menu", () => {
		const { result, written } = emit(parentIs(chosenCaseId(households)));
		expect(result).toMatchObject({
			k: "cmp",
			op: "=",
			left: { k: "step", path: ["parent", "@case_id"] },
			right: { k: "runtime", hole: { quoting: "quoted" } },
		});
		expect(calls(result)).toEqual([]);
		expect([...written]).toEqual([]);
	});

	it.each([
		[
			"a fixed id, which the inferred qualifier still filters",
			term(literal("abc")),
		],
		[
			"a worker field, which names no case type",
			term(sessionUser("household_id")),
		],
	])("keeps ancestor-exists for %s", (_label, value) => {
		const { result, written } = emit(parentIs(value));
		expect(calls(result)).toContain("ancestor-exists");
		expect([...written]).toEqual(["ancestor-exists"]);
	});

	it("keeps ancestor-exists for not-equal, which HQ answers with an unbounded index query", () => {
		const { result, written } = emit(
			exists(
				ancestorPath(relationStep("parent")),
				neq(prop("household", "case_id"), chosenCaseId(households)),
			),
		);
		expect(calls(result)).toContain("ancestor-exists");
		expect([...written]).toEqual(["ancestor-exists"]);
	});

	it("keeps ancestor-exists when the inferred qualifier names another type than the case chosen", () => {
		// The parent of a member is a household; a member chosen in another
		// menu is no household, so the qualifier still filters.
		const { written } = collectRelatedCaseQueries(() =>
			emitCsqlTree(
				parentIs(
					chosenCaseId(
						testUuid("csql-chosen-case-Members by household-module"),
					),
				),
				{ ...context, bindings: { datumId: () => "member_id" } },
			),
		);
		expect([...written]).toEqual(["ancestor-exists"]);
	});
});
