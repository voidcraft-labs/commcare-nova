import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { simpleSearchInputDef } from "@/lib/domain";
import {
	ancestorPath,
	eq,
	exists,
	gte,
	ifExpr,
	input,
	literal,
	prop,
	relationStep,
	term,
	today,
	whenInput,
	within,
} from "@/lib/domain/expression/builders";
import {
	chosenCaseId,
	chosenCaseProperty,
} from "@/lib/domain/expression/chosenCase";
import type { Expression } from "@/lib/domain/expression/types";
import { chosenCase, valueList } from "../../__tests__/csqlCompositionFixture";
import { csqlInputContext } from "../../__tests__/csqlFunctionFixture";
import { moduleExpressionContexts } from "../../expressionContext";
import { caseListStepDatumId } from "../../formLinkProjection";
import { type CsqlEmissionContext, emitCsqlTree } from "../emitter";
import {
	type CsqlRuntimeReads,
	type CsqlRuntimeValues,
	csqlRuntimeReads,
	csqlRuntimeRow,
	foldCsqlRuntime,
} from "../fold";

// The fold is what Preview's case store compiles a search from: each runtime
// piece the device works out replaced by what it gave. Keys come from the
// emitted tree's own reads, so these tests hold the fold and the emitter to
// one key for one piece.
const names = ["mode", "value", "radius", "unit", "tags"] as const;
const ref = (name: (typeof names)[number]) => input(testUuid(`fold-${name}`));
const context = csqlInputContext(
	names.map((name) =>
		simpleSearchInputDef(
			testUuid(`fold-${name}`),
			name,
			name,
			"text",
			"case_name",
		),
	),
);

function fold(
	predicate: Expression,
	values: (reads: CsqlRuntimeReads) => CsqlRuntimeValues,
	ctx: CsqlEmissionContext = context,
): Expression {
	const reads = csqlRuntimeReads(emitCsqlTree(predicate, ctx));
	return foldCsqlRuntime(predicate, values(reads), ctx);
}

const segments = (reads: CsqlRuntimeReads, ...texts: string[]) =>
	Object.fromEntries(
		reads.segments.map((segment, index) => [segment.key, texts[index] ?? ""]),
	);
const choices = (reads: CsqlRuntimeReads, ...taken: boolean[]) =>
	Object.fromEntries(
		reads.choices.map((choice, index) => [choice.key, taken[index] ?? false]),
	);

describe("foldCsqlRuntime", () => {
	it("makes a runtime value a literal of its node's type", () => {
		const predicate = gte(prop("patient", "visit_date"), today());
		expect(
			fold(predicate, (reads) => ({
				segments: segments(reads, "2026-10-19"),
				choices: {},
			})),
		).toEqual(
			gte(
				prop("patient", "visit_date"),
				term({ kind: "literal", value: "2026-10-19", data_type: "date" }),
			),
		);
	});

	it("leaves a value the device has not given as it is", () => {
		const predicate = gte(prop("patient", "visit_date"), today());
		expect(fold(predicate, () => ({ segments: {}, choices: {} }))).toEqual(
			predicate,
		);
	});

	it("takes the branch the device chose and folds inside it", () => {
		const predicate = ifExpr(
			eq(term(ref("mode")), term(literal("by-name"))),
			eq(prop("patient", "case_name"), term(ref("value"))),
			eq(prop("patient", "first_name"), term(literal("Ada"))),
		);
		expect(
			fold(predicate, (reads) => ({
				segments: segments(reads, "Grace"),
				choices: choices(reads, true),
			})),
		).toEqual(eq(prop("patient", "case_name"), term(literal("Grace"))));
		expect(
			fold(predicate, (reads) => ({
				segments: {},
				choices: choices(reads, false),
			})),
		).toEqual(eq(prop("patient", "first_name"), term(literal("Ada"))));
	});

	it("keeps an undecided choice with both of its branches", () => {
		const predicate = ifExpr(
			eq(term(ref("mode")), term(literal("by-name"))),
			eq(prop("patient", "case_name"), term(ref("value"))),
			eq(prop("patient", "first_name"), term(literal("Ada"))),
		);
		const folded = fold(predicate, (reads) => ({
			segments: segments(reads, "Grace"),
			choices: {},
		}));
		expect(folded).toMatchObject({
			kind: "if",
			// biome-ignore lint/suspicious/noThenProperty: an `if` expression's branch.
			then: eq(prop("patient", "case_name"), term(literal("Grace"))),
			else: eq(prop("patient", "first_name"), term(literal("Ada"))),
		});
	});

	it("resolves an input's presence gate the way the device did", () => {
		const predicate = whenInput(
			ref("value"),
			eq(prop("patient", "case_name"), term(ref("value"))),
		);
		expect(
			fold(predicate, (reads) => ({
				segments: segments(reads, "Grace"),
				choices: choices(reads, true),
			})),
		).toEqual(eq(prop("patient", "case_name"), term(literal("Grace"))));
		expect(
			fold(predicate, (reads) => ({
				segments: {},
				choices: choices(reads, false),
			})),
		).toEqual({ kind: "match-all" });
	});

	it("makes a clause that reads no case row the clause the device chose", () => {
		const predicate = eq(term(ref("mode")), term(literal("everyone")));
		expect(
			fold(predicate, (reads) => ({
				segments: {},
				choices: choices(reads, false),
			})),
		).toEqual({ kind: "match-none" });
	});

	it("makes a row whose obligations hold find nothing", () => {
		const predicate = eq(prop("patient", "case_name"), term(ref("value")));
		expect(
			fold(predicate, () => ({ segments: {}, choices: {}, rejected: true })),
		).toEqual({ kind: "match-none" });
	});

	it("splits a runtime selected value into its tokens", () => {
		const predicate: Expression = {
			kind: "multi-select-contains",
			property: { kind: "prop", caseType: "patient", property: "case_name" },
			values: [term(ref("tags"))],
			quantifier: "any",
		};
		expect(
			fold(predicate, (reads) => ({
				segments: segments(reads, " red\tblue  "),
				choices: {},
			})),
		).toEqual({
			...predicate,
			values: [
				{ kind: "literal", value: "red" },
				{ kind: "literal", value: "blue" },
			],
		});
	});

	it("makes a runtime radius a number and a runtime unit one of the nine", () => {
		const predicate = within(
			{ kind: "prop", caseType: "patient", property: "case_name" },
			term(literal("0 0")),
			term(ref("radius")),
			term(ref("unit")),
		);
		expect(
			fold(predicate, (reads) => ({
				segments: segments(reads, "2.5", "kilometers"),
				choices: {},
			})),
		).toEqual({ ...predicate, distance: 2.5, unit: "kilometers" });
	});

	describe("the case chosen in an earlier menu", () => {
		const doc = chosenCase.doc();
		const households = testUuid("csql-chosen-case-Households-module");
		const members = testUuid("csql-chosen-case-Members by village-module");
		const chosen: CsqlEmissionContext = {
			types: moduleExpressionContexts(
				doc,
				members,
			)({
				slot: "case_list_filter",
			}),
			bindings: { datumId: caseListStepDatumId(doc, members) },
		};
		const parentIs = exists(
			ancestorPath(relationStep("parent")),
			eq(prop("household", "case_id"), chosenCaseId(households)),
		);
		const sameVillage = eq(
			prop("member", "home_village"),
			chosenCaseProperty(households, "household", "village"),
		);

		it("folds its id and its property to what the device read", () => {
			expect(
				fold(
					parentIs,
					(reads) => ({ segments: segments(reads, "north"), choices: {} }),
					chosen,
				),
			).toMatchObject({
				kind: "exists",
				where: { kind: "eq", right: term(literal("north")) },
			});
			expect(
				fold(
					sameVillage,
					(reads) => ({ segments: segments(reads, "North"), choices: {} }),
					chosen,
				),
			).toEqual(eq(prop("member", "home_village"), term(literal("North"))));
		});

		it("leaves its id and its property unfolded without a value", () => {
			expect(
				fold(sameVillage, () => ({ segments: {}, choices: {} }), chosen),
			).toEqual(sameVillage);
		});
	});

	it("folds a node-set item that reads no node to the blank item the device sends", () => {
		// The device prints a node-set item as `"` + join('","', nodes) + `"`,
		// so a node-set with no node sends `[""]`: one blank item.
		const doc = valueList.doc();
		const moduleUuid = doc.moduleOrder[0];
		const rule = doc.modules[moduleUuid]?.caseListConfig?.searchInputs[0];
		if (moduleUuid === undefined || rule === undefined)
			throw new Error("The scenario has a module with a rule.");
		const ctx: CsqlEmissionContext = {
			types: moduleExpressionContexts(
				doc,
				moduleUuid,
			)({
				slot: "search_input_predicate",
				member: { searchInputUuid: rule.uuid },
			}),
			bindings: {},
		};
		const deviceColors: Expression = {
			kind: "project",
			of: { kind: "cases", source: "casedb", where: [] },
			value: prop("item", "color"),
		};
		const list = (...items: Expression[]) =>
			eq(prop("item", "color"), {
				kind: "value-list",
				items: items as [Expression, ...Expression[]],
			});
		const folded = (text: string) =>
			fold(
				list(deviceColors),
				(reads) => ({ segments: segments(reads, text), choices: {} }),
				ctx,
			);
		expect(folded("")).toEqual(list(term(literal(""))));
		expect(folded('red","blue')).toEqual(
			list(term(literal("red")), term(literal("blue"))),
		);
	});
});

describe("a row-reading choice's condition", () => {
	// `((c) and (A)) or (not(c) and (B))` prints `c` twice from one node: its
	// pieces are one piece each, with one value and one obligation.
	const condition = whenInput(
		ref("value"),
		eq(prop("patient", "first_name"), term(ref("value"))),
	);
	const predicate = ifExpr(
		condition,
		gte(prop("patient", "visit_date"), today()),
		eq(prop("patient", "case_name"), term(literal("Ada"))),
	);

	it("lists each piece once", () => {
		const tree = emitCsqlTree(predicate, context);
		const { reads, rejections } = csqlRuntimeRow(tree);
		const keys = (list: readonly { key: string }[]) =>
			list.map(({ key }) => key);
		expect(new Set(keys(reads.segments)).size).toBe(reads.segments.length);
		expect(keys(reads.segments)).toHaveLength(2);
		expect(keys(reads.choices)).toHaveLength(1);
		expect(rejections.map(({ kind }) => kind)).toEqual(["quote"]);
	});

	it("folds both of its printings with the one value", () => {
		const folded = fold(predicate, (reads) => ({
			segments: segments(reads, "Grace", "2026-10-19"),
			choices: choices(reads, true),
		}));
		const named = eq(prop("patient", "first_name"), term(literal("Grace")));
		expect(folded).toEqual(
			ifExpr(
				named,
				gte(
					prop("patient", "visit_date"),
					term({ kind: "literal", value: "2026-10-19", data_type: "date" }),
				),
				eq(prop("patient", "case_name"), term(literal("Ada"))),
			),
		);
	});
});
