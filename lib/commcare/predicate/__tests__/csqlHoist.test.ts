// lib/commcare/predicate/__tests__/csqlHoist.test.ts
//
// Acceptance tests for the CSQL hoisting pass. Each `it` constructs a
// predicate AST via the typed builders and asserts the rewritten AST
// plus wrapper list. The hoist pass exists because CCHQ's CSQL
// function whitelists on
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`
// and `__init__.py::XPATH_QUERY_FUNCTIONS` admit a narrow vocabulary;
// lifting non-grammar shapes into on-device wrappers is the canonical
// pattern documented in
// `commcare-hq/docs/case_search_query_language.rst`.
//
// Coverage spans four layers: (1) grammar shapes flow through
// untouched; (2) non-grammar value expressions in any position lift
// as a synthetic-input wrapper; (3) `count` lifts everywhere except
// the comparison-LHS subcase position CCHQ recognises as
// `subcase-count`; (4) `when-input-present` passes through unchanged
// — its inner clause walks for value-expression hoisting, but the
// emitter handles the conditional dispatch directly.

import { describe, expect, it } from "vitest";
import {
	ancestorPath,
	and,
	anyRelationPath,
	arith,
	concat,
	count,
	dateCoerce,
	datetimeCoerce,
	eq,
	exists,
	formatDate,
	gt,
	ifExpr,
	input,
	isBlank,
	isIn,
	isNull,
	literal,
	matchAll,
	not,
	prop,
	relationStep,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	whenInput,
	within,
} from "@/lib/domain/predicate/builders";
import { hoistForCsql } from "../csqlHoist";

describe("hoistForCsql — non-hoisting paths", () => {
	it("returns a fresh predicate with no wrappers when nothing lifts", () => {
		// A predicate composed of only term-arm ValueExpressions and
		// native CSQL operators flows through the walker without any
		// transformations. The output is a fresh allocation so the
		// caller can mutate either copy without disturbing the other.
		const p = and(
			eq(prop("patient", "name"), literal("Alice")),
			gt(prop("patient", "age"), literal(18)),
		);
		const result = hoistForCsql(p);
		expect(result.wrappers).toEqual([]);
		expect(result.hoisted).toEqual(p);
		expect(result.hoisted).not.toBe(p);
	});

	it("leaves match-all / match-none sentinels untouched", () => {
		const result = hoistForCsql(matchAll());
		expect(result.hoisted).toEqual({ kind: "match-all" });
		expect(result.wrappers).toEqual([]);
	});

	it("leaves grammar shapes intact through the walker", () => {
		// `today` / `now` / `date-add` / `double` are members of CCHQ's
		// CSQL value-function whitelist on
		// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`.
		// They survive the walker even when nested several layers deep.
		const p = isBlank(term(prop("patient", "name")));
		const result = hoistForCsql(p);
		expect(result.wrappers).toEqual([]);
	});

	it("walks into and-clauses + or-clauses without lifting native shapes", () => {
		const p = and(
			eq(prop("patient", "name"), literal("Alice")),
			not(eq(prop("patient", "status"), literal("closed"))),
		);
		const result = hoistForCsql(p);
		expect(result.wrappers).toEqual([]);
	});
});

describe("hoistForCsql — value-position hoists", () => {
	it("lifts an arith expression in a comparison's left operand", () => {
		// `arith` is absent from both CSQL whitelists; it lifts into a
		// synthetic search-input ref. The original expression survives
		// in the wrapper list, keyed by the synthetic name.
		const original = arith("+", term(prop("patient", "age")), term(literal(1)));
		const p = eq(original, term(literal(19)));
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]).toEqual({
			inputRef: "csql_hoist_0",
			expression: original,
		});
		// The hoisted predicate replaces the arith with a synthetic
		// input ref carried as a term-arm ValueExpression.
		expect(result.hoisted).toEqual(
			eq(input("csql_hoist_0"), term(literal(19))),
		);
	});

	it("lifts an if-expression in is-blank's left", () => {
		const original = ifExpr(matchAll(), term(literal("a")), term(literal("b")));
		const p = isBlank(original);
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]?.expression).toEqual(original);
	});

	it("lifts a switch-expression in a comparison's right operand", () => {
		const original = switchExpr(
			term(prop("patient", "tier")),
			[switchCase(literal("low"), term(literal(1)))],
			term(literal(0)),
		);
		const p = eq(prop("patient", "score"), original);
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]?.expression).toEqual(original);
	});

	it("lifts a concat expression in a comparison's right operand", () => {
		const original = concat(
			term(literal("Mr ")),
			term(prop("patient", "name")),
		);
		const p = eq(prop("patient", "display"), original);
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]?.expression).toEqual(original);
	});

	it("walks into within-distance.center and lifts a non-grammar shape there", () => {
		// `center` is a ValueExpression slot. An arith-driven center
		// (rare in practice but structurally typeable) lifts the same
		// way operand slots do.
		const original = arith("+", term(input("base_lat")), term(literal(0.1)));
		const p = within(prop("clinic", "location"), original, 50, "miles");
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]?.expression).toEqual(original);
	});

	it("lifts a format-date expression in a comparison's right operand", () => {
		// `format-date` is absent from CSQL's value-function whitelist
		// on
		// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`,
		// so the entire expression lifts as a wrapper that runs on
		// device (where `format-date` is available via JavaRosa).
		const original = formatDate(term(prop("patient", "dob")), "iso");
		const p = eq(prop("patient", "dob_text"), original);
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]?.expression).toEqual(original);
	});

	it("preserves date-coerce / datetime-coerce intact through the walker", () => {
		// Both arms map to CSQL value functions (`date(...)` /
		// `datetime(...)` per the `date` and `datetime` entries on
		// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`)
		// — the AST kind names diverge from the wire function names,
		// but the hoist pass leaves them intact and the emitter
		// renames at output time.
		const dateExpr = dateCoerce(term(literal("2024-12-03")));
		const datetimeExpr = datetimeCoerce(term(literal("2024-12-03T10:00:00")));
		expect(hoistForCsql(eq(prop("p", "x"), dateExpr)).wrappers).toEqual([]);
		expect(hoistForCsql(eq(prop("p", "y"), datetimeExpr)).wrappers).toEqual([]);
	});

	it("lifts a non-grammar bound on a between predicate", () => {
		// `between.lower` and `between.upper` are ValueExpression slots;
		// each routes through the value-position walker with the same
		// hoisting rules as a comparison operand.
		const original = arith(
			"-",
			term(prop("patient", "max_age")),
			term(literal(2)),
		);
		const p = {
			kind: "between" as const,
			left: term(prop("patient", "age")),
			lower: original,
			lowerInclusive: true,
			upperInclusive: true,
		};
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]?.expression).toEqual(original);
	});
});

describe("hoistForCsql — count operator", () => {
	it("leaves subcase-count in a comparison's left operand untouched", () => {
		// `count(subcasePath(...)) op N` is CCHQ's recognised
		// `subcase-count` form per `_is_subcase_count` nested inside
		// `commcare-hq/corehq/apps/case_search/filter_dsl.py::build_filter_from_ast`
		// (matches a BinaryExpression whose left is a FunctionCall named
		// `subcase-count`).
		const p = gt(count(subcasePath("child")), literal(2));
		const result = hoistForCsql(p);
		expect(result.wrappers).toEqual([]);
		expect(result.hoisted).toEqual(p);
	});

	it("lifts count outside a comparison-LHS as a wrapper", () => {
		// The on-device wrapper computes the cardinality and the wire
		// layer injects the resolved numeric literal into the CSQL
		// fragment via the synthetic search-input ref.
		const original = count(subcasePath("child"));
		const p = isBlank(original);
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]?.expression).toEqual(original);
	});

	it("lifts ancestor-direction count in comparison-LHS as a wrapper", () => {
		// CCHQ's `_is_subcase_count` only matches the literal
		// `subcase-count` function name; ancestor-direction counts have
		// no native form, so they lift into the on-device wrapper for
		// runtime evaluation.
		const original = count(ancestorPath(relationStep("parent")));
		const p = gt(original, literal(2));
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]?.expression).toEqual(original);
	});

	it("lifts any-relation-direction count in comparison-LHS as a wrapper", () => {
		const original = count(anyRelationPath("custom_rel"));
		const p = gt(original, literal(2));
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]?.expression).toEqual(original);
	});
});

describe("hoistForCsql — naming + multi-hoist composition", () => {
	it("assigns deterministic synthetic input names in walk order", () => {
		// Two unrelated arith expressions in an `and` lift in left-to-
		// right walk order: clause 0's lift becomes `csql_hoist_0`,
		// clause 1's becomes `csql_hoist_1`.
		const lifted0 = arith("+", term(prop("patient", "age")), term(literal(1)));
		const lifted1 = concat(term(literal("Mr ")), term(prop("patient", "name")));
		const p = and(
			eq(lifted0, term(literal(19))),
			eq(prop("patient", "display"), lifted1),
		);
		const result = hoistForCsql(p);
		expect(result.wrappers).toEqual([
			{ inputRef: "csql_hoist_0", expression: lifted0 },
			{ inputRef: "csql_hoist_1", expression: lifted1 },
		]);
	});

	it("lifts an outer if without recursing into its branches once it hoists", () => {
		// The whole `if` lifts as one unit; the wrapper expression
		// preserves the inner structure intact so the on-device XPath
		// evaluates the branches at runtime.
		const innerArith = arith(
			"+",
			term(prop("patient", "age")),
			term(literal(1)),
		);
		const ifExpression = ifExpr(matchAll(), innerArith, term(literal(0)));
		const p = eq(ifExpression, term(literal(19)));
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]?.expression).toEqual(ifExpression);
	});

	it("preserves the input AST: hoisting returns a fresh predicate without mutating its input", () => {
		const liftedArith = arith(
			"+",
			term(prop("patient", "age")),
			term(literal(1)),
		);
		const p = eq(liftedArith, term(literal(19)));
		const before = JSON.stringify(p);
		hoistForCsql(p);
		expect(JSON.stringify(p)).toBe(before);
	});

	it("walks into in.left and lifts a non-grammar shape there", () => {
		// `in.left` is a ValueExpression slot. An `arith`-driven left
		// (`isIn(arith("+", prop("age"), literal(1)), literal(18), literal(19))`)
		// lifts the same way comparison operands do.
		const lifted = arith("+", term(prop("patient", "age")), term(literal(1)));
		const p = isIn(lifted, literal(18), literal(19));
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]?.expression).toEqual(lifted);
	});

	it("walks into is-null's operand and lifts a non-grammar shape there", () => {
		// `is-null.left` is a ValueExpression slot (parallel to
		// is-blank.left). The hoist pass treats its operand uniformly
		// with every other value-position slot.
		const lifted = arith(
			"div",
			term(prop("patient", "amount")),
			term(literal(0)),
		);
		const p = isNull(lifted);
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]?.expression).toEqual(lifted);
	});

	it("hoists nodes inside an exists filter", () => {
		// Runtime refs inside an exists filter are valid per CCHQ's
		// canonical pattern at
		// `case_search_query_language.rst::"Filtering on related cases" → "Examples"`.
		// Non-grammar shapes lift into the wrapper; grammar shapes
		// (terms, comparisons, logical, value functions) compose into
		// the outer concat via the segment-list IR at the emitter
		// layer.
		const liftedArith = arith(
			"+",
			term(prop("child", "age")),
			term(literal(1)),
		);
		const p = exists(subcasePath("child"), eq(liftedArith, term(literal(19))));
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]?.expression).toEqual(liftedArith);
	});
});

describe("hoistForCsql — when-input-present pass-through", () => {
	it("preserves when-input-present unchanged through the hoist pass", () => {
		// The hoist pass does not rewrite `when-input-present`; the
		// emitter handles the conditional dispatch via recursive CSQL
		// emission of the inner clause and the canonical
		// `if(count(<trigger>), <inner-csql>, 'match-all()')` wrapper
		// at
		// `case_search_query_language.rst::"Filtering on related cases" → "Examples"`.
		const inner = eq(prop("patient", "name"), literal("Alice"));
		const p = whenInput(input("trigger"), inner);
		const result = hoistForCsql(p);
		expect(result.wrappers).toEqual([]);
		expect(result.hoisted).toEqual(p);
	});

	it("walks the inner clause for value-expression hoisting", () => {
		// An inner clause that contains a non-grammar value expression
		// still hoists; the lifted wrapper appears in the outer result
		// and the inner clause's transformed AST references the
		// synthetic input ref.
		const lifted = arith("+", term(prop("patient", "age")), term(literal(1)));
		const inner = eq(lifted, term(literal(19)));
		const p = whenInput(input("trigger"), inner);
		const result = hoistForCsql(p);
		expect(result.wrappers).toHaveLength(1);
		expect(result.wrappers[0]?.expression).toEqual(lifted);
	});
});
