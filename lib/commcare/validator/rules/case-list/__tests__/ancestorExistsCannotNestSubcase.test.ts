import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Tests for `ancestorExistsCannotNestSubcase`. CCHQ's CSQL evaluator
 * rejects a subcase-relation walk nested inside the filter argument
 * of an ancestor-relation walk; the rejection lives in
 * `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::_validate_ancestor_exists_filter`
 * (`subcase-exists is not supported with ancestor-exists`). Nova's
 * AST is more expressive than CCHQ's grammar here, so the lossiness
 * must surface at authoring time rather than at search-execution time.
 *
 * The rule walks the post-`liftPropertyVias` AST (the shape that
 * actually reaches the CSQL emitter) of every CSQL-emission-bound
 * predicate slot:
 *
 *   - `caseListConfig.filter`
 *   - every advanced-arm `caseListConfig.searchInputs[i].predicate`
 *
 * `searchButtonDisplayCondition` is on-device-only and out of scope;
 * `excludedOwnerIds` is on-device-only and out of scope.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	asUuid,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	and,
	anyRelationPath,
	count,
	eq,
	exists,
	gt,
	literal,
	matchAll,
	missing,
	multiSelectAll,
	not,
	prop,
	relationStep,
	subcasePath,
} from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_ANCESTOR_EXISTS_NESTS_CROSS_DIRECTION_WALK" as const;

const standardForm = {
	name: "Reg",
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

const caseTypesWithChain = [
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
			{ name: "tags", label: "Tags", data_type: "multi_select" as const },
		],
	},
	{
		name: "household",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
		],
	},
	{
		name: "child",
		parent_type: "patient",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
			{ name: "tags", label: "Tags", data_type: "multi_select" as const },
			{ name: "value", label: "Value", data_type: "text" as const },
		],
	},
];

describe("ancestorExistsCannotNestSubcase", () => {
	it("fires when an authored ancestor exists wraps a subcase exists", () => {
		// Hand-nested: ancestor(parent) wraps subcase(child).
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: exists(
							ancestorPath(relationStep("parent")),
							exists(subcasePath("child", "child")),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		// Elm-style three-component message in domain vocabulary
		// (ancestor / child, not subcase). State the CCHQ restriction
		// and point at a fix path.
		expect(hits[0].message).toContain("ancestor case");
		expect(hits[0].message).toContain("child case");
		expect(hits[0].message).toContain("server cannot run");
		expect(hits[0].message).toContain("separate top-level conditions");
	});

	it("fires when an ancestor exists wraps a missing subcase walk", () => {
		// CCHQ's filter validator walks operator children (and / or /
		// not) — a `missing(subcase, ...)` nested inside is still a
		// subcase-direction walk.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: exists(
							ancestorPath(relationStep("parent")),
							missing(subcasePath("child", "child")),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
	});

	it("fires when the subcase walk is nested inside `and` / `or` / `not` operators", () => {
		// CCHQ's `_validate_ancestor_exists_filter` descends through
		// `and` / `or` (members of `OPERATOR_MAPPING`); Nova's rule
		// additionally descends through `not` and `when-input-present`
		// because the runtime semantics of a subcase walk nested inside
		// those are unspecified at the CCHQ wire boundary. Either way,
		// hiding the subcase walk inside any of these operators still
		// trips the Nova-side rejection.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: exists(
							ancestorPath(relationStep("parent")),
							and(
								eq(prop("household", "case_name"), literal("A")),
								not(exists(subcasePath("child", "child"))),
							),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
	});

	it("fires when the lift-pass generates the nesting from `prop(via=subcase)` inside an ancestor envelope", () => {
		// The lift rewrites `exists(ancestor, eq(prop(via=subcase), 'v'))`
		// into `exists(ancestor, exists(subcase, eq(prop, 'v')))`. The
		// validator must walk the POST-lift AST so this shape surfaces.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: exists(
							ancestorPath(relationStep("parent")),
							eq(
								prop("patient", "value", subcasePath("child", "child")),
								literal("v"),
							),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
	});

	it("fires when `any-relation` inside an ancestor envelope lifts to a disjunction containing subcase-exists", () => {
		// `any-relation` lifts to `or(ancestor-exists, subcase-exists)`.
		// Wrapping that disjunction inside an outer `ancestor-exists`
		// means the inner filter contains a subcase walk — rejected.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: exists(
							ancestorPath(relationStep("parent")),
							eq(
								prop("patient", "value", anyRelationPath("sibling", "child")),
								literal("v"),
							),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
	});

	it("fires when an outer either-direction walk's ancestor arm contains a child walk", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: exists(
							anyRelationPath("parent", "household"),
							exists(subcasePath("parent", "patient")),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) => error.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("ancestor case");
		expect(hits[0].message).toContain("child case");
	});

	it("admits a nested child walk when the outer parent path is graph-proven child-only", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: exists(
							anyRelationPath("parent", "child"),
							exists(subcasePath("guardian_link", "household")),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("fires when a `subcase-count` sits inside the ancestor envelope's filter", () => {
		// CCHQ's `_validate_ancestor_exists_filter` rejects
		// `subcase-count` calls inside the ancestor-exists filter the
		// same way it rejects `subcase-exists`. The `count` reaches
		// CSQL as `subcase-count('child', ...)` in comparison-LHS
		// position; the rule must walk the comparison's operand to
		// surface it.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: exists(
							ancestorPath(relationStep("parent")),
							gt(count(subcasePath("child", "child")), literal(0)),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("count");
		expect(hits[0].message).toContain("child case");
	});

	it("fires when the ancestor envelope wraps an `exists(subcase, where=...)` filter", () => {
		// The presence of an inner filter on the subcase envelope
		// doesn't change the rejection — CCHQ flags
		// `FunctionCall(name='subcase-exists')` regardless of its arg
		// list shape.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: exists(
							ancestorPath(relationStep("parent")),
							exists(
								subcasePath("child", "child"),
								eq(prop("child", "value"), literal("v")),
							),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
	});

	it("admits subcase walks at top level (no outer ancestor envelope)", () => {
		// The rule fires only inside an outer ancestor envelope's filter.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: exists(subcasePath("child", "child")),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some((e) => e.code === CODE)).toBe(false);
	});

	it("admits sibling top-level walks (ancestor and subcase as separate top-level predicates)", () => {
		// `and(exists(ancestor), exists(subcase))` is the documented
		// fix path — both walks reach the top, and the AND-composition
		// does not nest one inside the other.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: and(
							exists(ancestorPath(relationStep("parent"))),
							exists(subcasePath("child", "child")),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some((e) => e.code === CODE)).toBe(false);
	});

	it("admits ancestor-on-ancestor nesting (no cross-direction walk)", () => {
		// Multi-hop ancestor chains live in the outer envelope's `via`
		// chain, not nested envelopes — but even a hand-authored nested
		// `exists(ancestor, exists(ancestor, ...))` is fine: same
		// direction, no rejection.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: exists(
							ancestorPath(relationStep("parent")),
							exists(ancestorPath(relationStep("host", "household"))),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some((e) => e.code === CODE)).toBe(false);
	});

	it("fires on an advanced-arm searchInput predicate", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							advancedSearchInputDef(
								asUuid("si-adv"),
								"adv",
								"Adv",
								"text",
								exists(
									ancestorPath(relationStep("parent")),
									exists(subcasePath("child", "child")),
								),
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("Adv");
	});

	it("ignores simple-arm searchInputs (no authored predicate to walk)", () => {
		// Simple-arm inputs derive their predicate at wire-emit and
		// always produce a single envelope at most — no nesting to flag.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-simple"),
								"name",
								"Name",
								"text",
								"case_name",
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some((e) => e.code === CODE)).toBe(false);
	});

	it("admits a `multi-select-contains` via subcase at top level (no outer ancestor envelope)", () => {
		// Lifts to `exists(subcase, multi-select-contains(...))` —
		// single envelope, no nesting.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: multiSelectAll(
							prop("patient", "tags", subcasePath("child", "child")),
							literal("a"),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some((e) => e.code === CODE)).toBe(false);
	});

	it("admits `match-all` filter (no envelopes to flag)", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: matchAll(),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some((e) => e.code === CODE)).toBe(false);
	});

	it("admits absent filter and absent searchInputs", () => {
		// Smoke test: no slots in scope, no errors.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some((e) => e.code === CODE)).toBe(false);
	});

	it("walks `not(exists(ancestor, ...))` and `match(prop(via=ancestor))` envelopes too", () => {
		// `missing(ancestor, where: exists(subcase))` lifts to the
		// `missing` arm — still an ancestor envelope; the filter
		// content still rejects subcase walks. The rule walks every
		// `exists` / `missing` with `via.kind === "ancestor"`.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: missing(
							ancestorPath(relationStep("parent")),
							exists(subcasePath("child", "child")),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
	});

	it("does not apply the server-only restriction to an ordinary on-device case list", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: exists(
							ancestorPath(relationStep("parent")),
							exists(subcasePath("child", "child")),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: caseTypesWithChain,
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some((error) => error.code === CODE)).toBe(false);
	});
});
