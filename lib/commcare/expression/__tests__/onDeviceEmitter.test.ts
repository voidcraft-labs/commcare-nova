// lib/commcare/expression/__tests__/onDeviceEmitter.test.ts
//
// Acceptance tests for the on-device value-expression emitter — the
// dialect that produces XPath value strings usable in any on-device
// expression slot (calculated columns, sort keys, late-flag arguments,
// the source of an ID-mapping column, search-input defaults). The
// emitter is total: every `ValueExpression` AST node produces a wire
// string. Every well-formed AST produces a well-formed wire
// emission with no structural rejection.
//
// Each test pins the exact wire string the emitter produces against
// CCHQ HQ's wire grammar. Source citations live in the source file
// alongside each operator arm.
//
// Coverage organizes around three shells:
//   1. Per-operator emissions for every arm of `ValueExpression`.
//   2. Recursive composition — operators nesting inside other
//      operators, including the cross-family `if` / `switch` /
//      `count` arms whose conditional clauses recurse through the
//      on-device predicate emitter.
//   3. Term-arm structural lifter — every `Term` flavor reaches the
//      emitter through the `term` arm, so a small spot-check pins
//      the lifter's pass-through to the shared on-device term
//      emitter.

import { describe, expect, it } from "vitest";
import {
	ancestorPath,
	and,
	anyRelationPath,
	arith,
	coalesce,
	concat,
	count,
	dateAdd,
	dateCoerce,
	datetimeCoerce,
	double,
	eq,
	formatDate,
	gt,
	ifExpr,
	input,
	literal,
	now,
	prop,
	relationStep,
	selfPath,
	sessionContext,
	sessionUser,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	today,
	unwrapList,
} from "@/lib/domain/predicate/builders";
import { emitOnDeviceExpression } from "../onDeviceEmitter";

// ============================================================
// SHELL 1 — per-operator emissions
// ============================================================

describe("emitOnDeviceExpression — discriminator-only constants", () => {
	it("emits today() for the today arm", () => {
		expect(emitOnDeviceExpression(today())).toBe("today()");
	});

	it("emits now() for the now arm", () => {
		expect(emitOnDeviceExpression(now())).toBe("now()");
	});
});

describe("emitOnDeviceExpression — coercion functions", () => {
	it("emits date(<value>) for date-coerce", () => {
		const expr = dateCoerce(term(input("dob_text")));
		expect(emitOnDeviceExpression(expr)).toBe(
			`date(instance('search-input:results')/input/field[@name='dob_text'])`,
		);
	});

	it("emits datetime(<value>) for datetime-coerce", () => {
		const expr = datetimeCoerce(term(input("dt_text")));
		expect(emitOnDeviceExpression(expr)).toBe(
			`datetime(instance('search-input:results')/input/field[@name='dt_text'])`,
		);
	});

	it("emits double(<value>) for double", () => {
		const expr = double(term(prop("patient", "age")));
		expect(emitOnDeviceExpression(expr)).toBe("double(age)");
	});
});

describe("emitOnDeviceExpression — arithmetic", () => {
	it("emits the plus operator wrapped in parentheses", () => {
		const expr = arith("+", term(prop("patient", "age")), term(literal(1)));
		expect(emitOnDeviceExpression(expr)).toBe("(age + 1)");
	});

	it("emits the minus operator", () => {
		const expr = arith("-", term(prop("patient", "x")), term(literal(2)));
		expect(emitOnDeviceExpression(expr)).toBe("(x - 2)");
	});

	it("emits the star operator", () => {
		const expr = arith("*", term(literal(3)), term(literal(4)));
		expect(emitOnDeviceExpression(expr)).toBe("(3 * 4)");
	});

	it("emits the div operator with the spelled-out form", () => {
		const expr = arith("div", term(literal(10)), term(literal(2)));
		expect(emitOnDeviceExpression(expr)).toBe("(10 div 2)");
	});

	it("emits the mod operator with the spelled-out form", () => {
		const expr = arith("mod", term(literal(10)), term(literal(3)));
		expect(emitOnDeviceExpression(expr)).toBe("(10 mod 3)");
	});

	it("nests arithmetic recursively, each level wrapping in parens", () => {
		const expr = arith(
			"+",
			arith("*", term(prop("p", "a")), term(literal(2))),
			term(literal(1)),
		);
		expect(emitOnDeviceExpression(expr)).toBe("((a * 2) + 1)");
	});
});

describe("emitOnDeviceExpression — concat / coalesce", () => {
	it("emits concat with comma-joined args", () => {
		const expr = concat(
			term(literal("Hello, ")),
			term(prop("p", "name")),
			term(literal("!")),
		);
		expect(emitOnDeviceExpression(expr)).toBe(`concat('Hello, ', name, '!')`);
	});

	it("emits a single-arg concat as concat('X')", () => {
		const expr = concat(term(literal("only")));
		expect(emitOnDeviceExpression(expr)).toBe(`concat('only')`);
	});

	it("emits coalesce with comma-joined args", () => {
		const expr = coalesce(
			term(prop("p", "primary")),
			term(prop("p", "fallback")),
			term(literal("default")),
		);
		expect(emitOnDeviceExpression(expr)).toBe(
			`coalesce(primary, fallback, 'default')`,
		);
	});
});

describe("emitOnDeviceExpression — if / switch (cross-family)", () => {
	it("emits if(<predicate>, <then>, <else>) with the on-device predicate emitter recursively", () => {
		const expr = ifExpr(
			gt(term(prop("p", "age")), term(literal(18))),
			term(literal("adult")),
			term(literal("minor")),
		);
		expect(emitOnDeviceExpression(expr)).toBe(`if(age > 18, 'adult', 'minor')`);
	});

	it("expands switch into a nested if-chain (XPath has no native switch)", () => {
		// One case + fallback collapses to one nested if.
		const expr = switchExpr(
			term(prop("p", "state")),
			[switchCase(literal("active"), term(literal("on")))],
			term(literal("off")),
		);
		expect(emitOnDeviceExpression(expr)).toBe(
			`if(state = 'active', 'on', 'off')`,
		);
	});

	it("expands a multi-case switch into a right-nested if chain", () => {
		const expr = switchExpr(
			term(prop("p", "level")),
			[
				switchCase(literal("low"), term(literal(1))),
				switchCase(literal("mid"), term(literal(2))),
				switchCase(literal("high"), term(literal(3))),
			],
			term(literal(0)),
		);
		expect(emitOnDeviceExpression(expr)).toBe(
			`if(level = 'low', 1, if(level = 'mid', 2, if(level = 'high', 3, 0)))`,
		);
	});
});

describe("emitOnDeviceExpression — format-date", () => {
	it("emits format-date(<value>, '<preset>') with the preset name quoted", () => {
		const expr = formatDate(term(prop("p", "dob")), "iso");
		expect(emitOnDeviceExpression(expr)).toBe(`format-date(dob, 'iso')`);
	});

	it("emits format-date with a custom pattern", () => {
		const expr = formatDate(term(prop("p", "dob")), "%Y-%m-%d");
		expect(emitOnDeviceExpression(expr)).toBe(`format-date(dob, '%Y-%m-%d')`);
	});
});

describe("emitOnDeviceExpression — date-add", () => {
	// CCHQ's wire signature: `date-add(date, interval, quantity)` —
	// three separate arguments. Source: `value_functions.py:115`
	// (`date-add('2022-01-01', 'days', -1) => '2021-12-31'`).
	it("emits date-add(<date>, '<interval>', <quantity>)", () => {
		const expr = dateAdd(today(), "days", term(literal(-1)));
		expect(emitOnDeviceExpression(expr)).toBe(`date-add(today(), 'days', -1)`);
	});

	it("emits a months interval", () => {
		const expr = dateAdd(today(), "months", term(literal(3)));
		expect(emitOnDeviceExpression(expr)).toBe(`date-add(today(), 'months', 3)`);
	});

	it("emits with a property reference as the date base", () => {
		const expr = dateAdd(term(prop("p", "dob")), "years", term(literal(18)));
		expect(emitOnDeviceExpression(expr)).toBe(`date-add(dob, 'years', 18)`);
	});

	it("composes recursively in the date and quantity slots", () => {
		// `quantity` is a ValueExpression slot; an arith expression in
		// that slot composes through the emitter's recursive walk.
		const expr = dateAdd(
			term(prop("p", "dob")),
			"days",
			arith("+", term(prop("p", "offset")), term(literal(7))),
		);
		expect(emitOnDeviceExpression(expr)).toBe(
			`date-add(dob, 'days', (offset + 7))`,
		);
	});
});

describe("emitOnDeviceExpression — unwrap-list", () => {
	it("emits unwrap-list(<value>) literally", () => {
		const expr = unwrapList(term(prop("p", "tags")));
		expect(emitOnDeviceExpression(expr)).toBe("unwrap-list(tags)");
	});
});

describe("emitOnDeviceExpression — count", () => {
	// `count` expansion mirrors `exists`'s relational join shape; the
	// emission is the bare `count(<nodeset>)` call, NOT the `count(...)
	// > 0` presence test the predicate emitter wraps.

	it("emits count() with an ancestor walk and no filter", () => {
		const expr = count(ancestorPath(relationStep("parent")));
		expect(emitOnDeviceExpression(expr)).toBe(
			`count(instance('casedb')/casedb/case[@case_id=current()/index/parent])`,
		);
	});

	it("emits count() with a subcase walk and no filter", () => {
		const expr = count(subcasePath("parent"));
		expect(emitOnDeviceExpression(expr)).toBe(
			`count(instance('casedb')/casedb/case[index/parent=current()/@case_id])`,
		);
	});

	it("emits count() with a filter clause as a bracketed predicate", () => {
		const expr = count(
			subcasePath("parent"),
			eq(term(prop("p", "state")), term(literal("open"))),
		);
		expect(emitOnDeviceExpression(expr)).toBe(
			`count(instance('casedb')/casedb/case[index/parent=current()/@case_id][state = 'open'])`,
		);
	});

	it("emits count(self) with no filter as the constant 1", () => {
		// `via.kind === "self"` is the no-traversal case. The cardinality
		// of the current case alone is `1`; emitting `count()` over a
		// single-element nodeset has no useful CCHQ wire form, so the
		// emitter collapses to the constant.
		const expr = count(selfPath());
		expect(emitOnDeviceExpression(expr)).toBe("1");
	});

	it("emits count(self, filter) as if(<filter>, 1, 0)", () => {
		// Self-count with a filter produces 1 when the filter holds, 0
		// otherwise. The conditional-collapse shape keeps the wire form
		// well-defined without inventing a single-element nodeset.
		const expr = count(
			selfPath(),
			eq(term(prop("p", "state")), term(literal("open"))),
		);
		expect(emitOnDeviceExpression(expr)).toBe(`if(state = 'open', 1, 0)`);
	});

	it("emits count(any-relation) as the sum of ancestor and subcase counts", () => {
		// Direction-agnostic count: cardinality summed across both
		// directions. Each side computes a directed count
		// independently; their sum is the total reachable count.
		const expr = count(anyRelationPath("rel"));
		expect(emitOnDeviceExpression(expr)).toBe(
			`(count(instance('casedb')/casedb/case[@case_id=current()/index/rel]) + count(instance('casedb')/casedb/case[index/rel=current()/@case_id]))`,
		);
	});

	it("emits count(any-relation, filter) applying the filter on both sides", () => {
		const expr = count(
			anyRelationPath("rel"),
			eq(term(prop("p", "state")), term(literal("open"))),
		);
		expect(emitOnDeviceExpression(expr)).toBe(
			`(count(instance('casedb')/casedb/case[@case_id=current()/index/rel][state = 'open']) + count(instance('casedb')/casedb/case[index/rel=current()/@case_id][state = 'open']))`,
		);
	});
});

describe("emitOnDeviceExpression — term arm structural lifter", () => {
	it("emits a property reference via the term arm", () => {
		expect(emitOnDeviceExpression(term(prop("patient", "name")))).toBe("name");
	});

	it("emits a literal via the term arm", () => {
		expect(emitOnDeviceExpression(term(literal("Alice")))).toBe("'Alice'");
	});

	it("emits a search-input ref via the term arm", () => {
		expect(emitOnDeviceExpression(term(input("name_query")))).toBe(
			`instance('search-input:results')/input/field[@name='name_query']`,
		);
	});

	it("emits a session-user ref via the term arm", () => {
		expect(emitOnDeviceExpression(term(sessionUser("clinic_id")))).toBe(
			`instance('commcaresession')/session/user/data/clinic_id`,
		);
	});

	it("emits a session-context ref via the term arm", () => {
		expect(emitOnDeviceExpression(term(sessionContext("userid")))).toBe(
			`instance('commcaresession')/session/context/userid`,
		);
	});
});

// ============================================================
// SHELL 2 — recursive composition + cross-family
// ============================================================

describe("emitOnDeviceExpression — recursive composition", () => {
	it("composes if + arith + concat in a single tree", () => {
		const expr = ifExpr(
			gt(term(prop("p", "age")), term(literal(18))),
			concat(term(literal("adult: ")), term(prop("p", "name"))),
			arith("+", term(prop("p", "age")), term(literal(1))),
		);
		expect(emitOnDeviceExpression(expr)).toBe(
			`if(age > 18, concat('adult: ', name), (age + 1))`,
		);
	});

	it("composes a switch with cross-family conditional checking", () => {
		// `cond` is a Predicate; `then` / `else` and `case.then` are
		// ValueExpressions. The predicate side recurses through the on-
		// device predicate emitter.
		const expr = ifExpr(
			and(
				gt(term(prop("p", "age")), term(literal(18))),
				eq(term(prop("p", "state")), term(literal("active"))),
			),
			term(literal("yes")),
			term(literal("no")),
		);
		expect(emitOnDeviceExpression(expr)).toBe(
			`if(age > 18 and state = 'active', 'yes', 'no')`,
		);
	});
});
