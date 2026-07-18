// lib/commcare/expression/__tests__/onDeviceEmitter.test.ts
//
// Acceptance tests for the on-device value-expression emitter — the
// dialect that produces XPath value strings usable in any on-device
// expression slot (calculated columns, sort keys, late-flag arguments,
// the source of an ID-mapping column, search-input defaults). The
// emitter is total over validator-admitted device expressions. Schema-valid
// CSQL-only list expansion and multi-valued scalar relation reads throw as
// defensive tripwires instead of shipping a runtime failure.
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
	dateLiteral,
	datetimeCoerce,
	datetimeLiteral,
	double,
	eq,
	exists,
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

	it("emits date(<value>) for date-coerce over a date-shaped operand (identity on this evaluator)", () => {
		// The redundant-but-sound shape derived property typing keeps
		// legal: an explicit coerce wrapped around a property that now
		// RESOLVES to date. JavaRosa's `date()` of a date value is
		// identity (`FunctionUtils::toDate` — the String arm parses via
		// `DateUtils::parseDateTime`; the Date arm rounds, identity for
		// a midnight date), so the wire stays the plain wrapped read.
		const expr = dateCoerce(term(prop("patient", "order_date")));
		expect(emitOnDeviceExpression(expr)).toBe("date(order_date)");
	});

	it("emits date(<value>) for datetime-coerce — this dialect has no datetime()", () => {
		// The on-device grammar (`commcare-core`'s XPath, the web-apps
		// evaluator) dispatches exactly one parse-coercion function:
		// `date` (`org.javarosa.xpath.parser.ast.ASTNodeFunctionCall`
		// carries no `datetime` case and no runtime handler registers
		// one) — a `datetime(...)` call fails the case list / search
		// session as an unknown function. `date()`'s String arm
		// (`FunctionUtils::toDate` → `DateUtils::parseDateTime`)
		// preserves time-of-day, so it IS the datetime coercion here.
		const expr = datetimeCoerce(term(input("dt_text")));
		expect(emitOnDeviceExpression(expr)).toBe(
			`date(instance('search-input:results')/input/field[@name='dt_text'])`,
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
			term(prop("p", "full_name")),
			term(literal("!")),
		);
		expect(emitOnDeviceExpression(expr)).toBe(
			`concat('Hello, ', full_name, '!')`,
		);
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
	it.each([
		["short", "%m/%d/%Y"],
		["long", "%B %e, %Y"],
		["iso", "%Y-%m-%d"],
	] as const)("lowers the %s preset to JavaRosa's supported pattern", (preset, pattern) => {
		const expr = formatDate(term(prop("p", "dob")), preset);
		expect(emitOnDeviceExpression(expr)).toBe(`format-date(dob, '${pattern}')`);
	});

	it("emits format-date with a custom pattern", () => {
		const expr = formatDate(term(prop("p", "dob")), "%Y-%m-%d");
		expect(emitOnDeviceExpression(expr)).toBe(`format-date(dob, '%Y-%m-%d')`);
	});
});

describe("emitOnDeviceExpression — date-add", () => {
	it.each([
		["seconds", 43200, "(43200 div 86400)"],
		["minutes", -720, "(-720 div 1440)"],
		["hours", 12.5, "(12.5 div 24)"],
		["days", -0.5, "-0.5"],
		["weeks", 0.5, "(0.5 * 7)"],
	] as const)("scales fractional %s to epoch days and floors the date result", (interval, quantity, scaled) => {
		const expr = dateAdd(today(), interval, term(literal(quantity)));
		expect(emitOnDeviceExpression(expr)).toBe(
			`date(floor(today() + ${scaled}))`,
		);
		expect(emitOnDeviceExpression(expr)).not.toContain("date-add(");
	});

	it("lowers a property base without inventing an unsupported function", () => {
		const expr = dateAdd(term(prop("p", "dob")), "days", term(literal(18)));
		expect(emitOnDeviceExpression(expr)).toBe("date(floor(dob + 18))");
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
			"date(floor(dob + (offset + 7)))",
		);
	});

	it.each([
		"months",
		"years",
	] as const)("rejects the calendar-relative %s interval instead of inventing fixed-day semantics", (interval) => {
		const expr = dateAdd(today(), interval, term(literal(1)));
		expect(() => emitOnDeviceExpression(expr)).toThrow(
			new RegExp(
				`calendar-relative date-add interval '${interval}'.*epoch days`,
				"s",
			),
		);
	});

	it.each([
		["now", now()],
		["datetime-coerce", datetimeCoerce(term(literal("2020-01-01T12:00:00")))],
		["typed datetime literal", term(datetimeLiteral("2020-01-01T12:00:00"))],
		["nested datetime date-add", dateAdd(now(), "days", term(literal(1)))],
		["null-neutral coalesce", coalesce(now(), term(literal(null)))],
		[
			"null-neutral conditional",
			ifExpr(eq(literal(1), literal(1)), now(), term(literal(null))),
		],
		[
			"null-neutral switch",
			switchExpr(
				term(literal("x")),
				[switchCase(literal("x"), now())],
				term(literal(null)),
			),
		],
	] as const)("rejects an obvious %s base before losing its time", (_label, base) => {
		expect(() =>
			emitOnDeviceExpression(dateAdd(base, "days", term(literal(1)))),
		).toThrow(/structurally datetime-typed base.*discard the time-of-day/s);
	});

	it("admits an explicit date coercion as a date-only base", () => {
		const expr = dateAdd(
			dateCoerce(term(literal("2020-01-01"))),
			"days",
			term(literal(1)),
		);
		expect(emitOnDeviceExpression(expr)).toBe(
			"date(floor(date('2020-01-01') + 1))",
		);
	});

	it("keeps floor semantics explicit for fractional arithmetic before the Unix epoch", () => {
		const expr = dateAdd(
			term(dateLiteral("1969-12-31")),
			"days",
			term(literal(-0.5)),
		);
		expect(emitOnDeviceExpression(expr)).toBe(
			"date(floor('1969-12-31' + -0.5))",
		);
	});
});

describe("emitOnDeviceExpression — unwrap-list", () => {
	it("rejects the CSQL-only function instead of emitting an unknown Core call", () => {
		const expr = unwrapList(term(prop("p", "tags")));
		expect(() => emitOnDeviceExpression(expr)).toThrow(
			/unwrap-list.*server-side/i,
		);
	});
});

describe("emitOnDeviceExpression — scalar relation cardinality", () => {
	it("rejects a subcase property read that can return several values", () => {
		const expression = term(
			prop("patient", "visit_date", subcasePath("parent", "visit")),
		);
		expect(() => emitOnDeviceExpression(expression)).toThrow(
			/several values.*scalar/i,
		);
	});

	it("rejects an any-relation property nested in a scalar calculation", () => {
		const expression = concat(
			term(literal("Status: ")),
			term(prop("patient", "status", anyRelationPath("parent", "visit"))),
		);
		expect(() => emitOnDeviceExpression(expression)).toThrow(
			/several values.*scalar/i,
		);
	});

	it("keeps a single-valued ancestor property read", () => {
		const expression = term(
			prop(
				"patient",
				"district",
				ancestorPath(relationStep("parent", "household")),
			),
		);
		expect(() => emitOnDeviceExpression(expression)).not.toThrow();
	});

	it("narrows a graph-proven parent-only any-relation to a scalar ancestor read", () => {
		const expression = term(
			prop("patient", "district", anyRelationPath("parent", "household")),
		);
		const emitted = emitOnDeviceExpression(expression, "casedb", {
			currentCaseType: "patient",
			caseTypes: [
				{ name: "patient", parent_type: "household", properties: [] },
				{ name: "household", properties: [] },
			],
		});
		expect(emitted).toContain("index/parent");
		expect(emitted).toContain("@case_type='household'");
		expect(emitted).not.toContain(" | ");
	});

	it("adds the inferred parent case type to a scalar ancestor read", () => {
		const expression = term(
			prop("patient", "district", ancestorPath(relationStep("parent"))),
		);
		const emitted = emitOnDeviceExpression(expression, "casedb", {
			currentCaseType: "patient",
			caseTypes: [
				{ name: "patient", parent_type: "household", properties: [] },
				{ name: "household", properties: [] },
			],
		});
		expect(emitted).toContain("@case_type='household'");
	});

	it("preserves an explicit custom-index target on a scalar ancestor read", () => {
		const expression = term(
			prop(
				"patient",
				"rating",
				ancestorPath(relationStep("guardian_link", "guardian")),
			),
		);
		const emitted = emitOnDeviceExpression(expression, "casedb", {
			currentCaseType: "patient",
			caseTypes: [
				{ name: "patient", parent_type: "household", properties: [] },
				{ name: "household", properties: [] },
				{ name: "guardian", properties: [] },
			],
		});
		expect(emitted).toContain("index/guardian_link");
		expect(emitted).toContain("@case_type='guardian'");
	});
});

describe("emitOnDeviceExpression — count", () => {
	// `count` expansion mirrors `exists`'s immediate-scope relation semantics.
	// A subcase relation can count a nodeset directly. An ancestor index is a
	// singleton reference, so it emits 1/0 after confirming both that the index is
	// present and that its id belongs to the filtered destination set.

	it("emits count() with an ancestor walk and no filter", () => {
		const expr = count(ancestorPath(relationStep("parent")));
		expect(emitOnDeviceExpression(expr)).toBe(
			`if(count(index/parent) > 0 and selected(join(' ', instance('casedb')/casedb/case[true()]/@case_id), index/parent), 1, 0)`,
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
		// Direction-agnostic count sums the ancestor singleton's 1/0 presence and
		// the subcase nodeset cardinality.
		const expr = count(anyRelationPath("rel"));
		expect(emitOnDeviceExpression(expr)).toBe(
			`(if(count(index/rel) > 0 and selected(join(' ', instance('casedb')/casedb/case[true()]/@case_id), index/rel), 1, 0) + count(instance('casedb')/casedb/case[index/rel=current()/@case_id]))`,
		);
	});

	it("emits count(any-relation, filter) applying the filter on both sides", () => {
		const expr = count(
			anyRelationPath("rel"),
			eq(term(prop("p", "state")), term(literal("open"))),
		);
		expect(emitOnDeviceExpression(expr)).toBe(
			`(if(count(index/rel) > 0 and selected(join(' ', instance('casedb')/casedb/case[state = 'open']/@case_id), index/rel), 1, 0) + count(instance('casedb')/casedb/case[index/rel=current()/@case_id][state = 'open']))`,
		);
	});

	it("anchors a child count to the singleton ancestor currently being filtered", () => {
		const expression = ifExpr(
			exists(
				ancestorPath(relationStep("parent", "household")),
				gt(count(subcasePath("parent", "visit")), term(literal(0))),
			),
			term(literal("yes")),
			term(literal("no")),
		);
		const emitted = emitOnDeviceExpression(expression);
		expect(emitted).toContain(
			"index/parent=instance('casedb')/casedb/case[@case_id=current()/index/parent and @case_type='household']/@case_id",
		);
		expect(emitted).toContain("@case_type='visit'");
	});

	it("fails closed when a child count is nested under a multi-case child scope", () => {
		const expression = ifExpr(
			exists(
				subcasePath("parent", "visit"),
				gt(count(subcasePath("parent", "followup")), term(literal(0))),
			),
			term(literal("yes")),
			term(literal("no")),
		);
		expect(() => emitOnDeviceExpression(expression)).toThrow(
			/child-case count is nested under a relation scope that CommCare Core cannot name/i,
		);
	});
});

describe("emitOnDeviceExpression — term arm structural lifter", () => {
	it("emits a property reference via the term arm", () => {
		expect(emitOnDeviceExpression(term(prop("patient", "full_name")))).toBe(
			"full_name",
		);
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
			concat(term(literal("adult: ")), term(prop("p", "full_name"))),
			arith("+", term(prop("p", "age")), term(literal(1))),
		);
		expect(emitOnDeviceExpression(expr)).toBe(
			`if(age > 18, concat('adult: ', full_name), (age + 1))`,
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
