// lib/preview/engine/__tests__/runtimeBindings.test.ts
//
// Acceptance tests for `composeRuntimeFilter` — the running-app
// runtime-bindings layer that translates per-input typed values into a
// single `Predicate` for the case-list query.
//
// The tests cover three concerns:
//
//   1. Per-mode dispatch on the `simple` arm — every applicable mode
//      builds the right comparison shape, the per-`type` default kicks
//      in when `mode` is absent, and `via` (relation walk) threads
//      through `prop()` correctly.
//   2. Advanced-arm `input(name)` substitution — the recursive AST
//      rewriter substitutes value-position term refs across every
//      Predicate / ValueExpression / Term arm, preserves the
//      structurally-non-value `whenInputPresent.input` trigger slot,
//      and leaves orphan `input(other)` refs untouched.
//   3. Composition + empty-value short-circuit — empty / absent values
//      contribute nothing per input; multiple contributing inputs
//      AND-compose; zero-input or all-empty calls return `matchAll()`.
//
// Round-trip parse via `predicateSchema.parse` is the load-bearing
// regression check on every constructed result — if the bindings layer
// produces an AST the schema rejects, the test fails loudly. Mirrors
// the same discipline `lib/domain/predicate/__tests__/builders.test.ts`
// uses on the construction-side surface.

import { describe, expect, it } from "vitest";
import {
	APPLICABLE_SEARCH_MODES,
	advancedSearchInputDef,
	asUuid,
	exactMode,
	fuzzyDateMode,
	fuzzyMode,
	multiSelectContainsMode,
	phoneticMode,
	rangeMode,
	type SearchInputType,
	simpleSearchInputDef,
	startsWithMode,
} from "@/lib/domain";
import {
	ancestorPath,
	and,
	arith,
	between,
	coalesce,
	concat,
	dateAdd,
	dateCoerce,
	dateLiteral,
	datetimeCoerce,
	double,
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
	match,
	matchAll,
	matchNone,
	missing,
	multiSelectAll,
	multiSelectAny,
	not,
	now,
	or,
	predicateSchema,
	prop,
	relationStep,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	today,
	unwrapList,
	whenInput,
	within,
} from "@/lib/domain/predicate";
import { composeRuntimeFilter } from "../runtimeBindings";

const PATIENT = "patient";

describe("composeRuntimeFilter — empty-input contributions", () => {
	it("returns matchAll() when no search inputs are declared", () => {
		const result = composeRuntimeFilter(
			[],
			new Map(Object.entries({})),
			PATIENT,
		);
		expect(result).toEqual(matchAll());
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("returns matchAll() when every input value is empty / absent", () => {
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "name", "Name", "text", "name"),
			simpleSearchInputDef(asUuid("b"), "status", "Status", "select", "status"),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({})),
			PATIENT,
		);
		expect(result).toEqual(matchAll());
	});

	it("treats an empty-string value as absent (per-input short-circuit)", () => {
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "name", "Name", "text", "name"),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ name: "" })),
			PATIENT,
		);
		expect(result).toEqual(matchAll());
	});
});

describe("composeRuntimeFilter — simple arm, per-mode dispatch", () => {
	it("builds an `eq` clause for `exact` mode (explicit)", () => {
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "name", "Name", "text", "name", {
				mode: exactMode(),
			}),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ name: "alice" })),
			PATIENT,
		);
		const expected = eq(prop(PATIENT, "name"), literal("alice"));
		expect(result).toEqual(expected);
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("defaults to `exact` for `text` inputs when mode is absent", () => {
		// `APPLICABLE_SEARCH_MODES.text[0] === "exact"` — first entry is
		// the default. The result must be structurally identical to the
		// explicit-mode case above.
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "name", "Name", "text", "name"),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ name: "alice" })),
			PATIENT,
		);
		expect(result).toEqual(eq(prop(PATIENT, "name"), literal("alice")));
	});

	it("defaults to `exact` for `select` inputs when mode is absent", () => {
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "status", "Status", "select", "status"),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ status: "open" })),
			PATIENT,
		);
		expect(result).toEqual(eq(prop(PATIENT, "status"), literal("open")));
	});

	it("defaults to `exact` for `barcode` inputs when mode is absent", () => {
		const inputs = [
			simpleSearchInputDef(
				asUuid("a"),
				"barcode_id",
				"Barcode",
				"barcode",
				"barcode_id",
			),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ barcode_id: "BC-1234" })),
			PATIENT,
		);
		expect(result).toEqual(eq(prop(PATIENT, "barcode_id"), literal("BC-1234")));
	});

	it("builds a `fuzzy` `match` clause for `fuzzy` mode", () => {
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "name", "Name", "text", "name", {
				mode: fuzzyMode(),
			}),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ name: "alic" })),
			PATIENT,
		);
		expect(result).toEqual(
			match(prop(PATIENT, "name"), literal("alic"), "fuzzy"),
		);
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("builds a `starts-with` `match` clause for `starts-with` mode", () => {
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "name", "Name", "text", "name", {
				mode: startsWithMode(),
			}),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ name: "ali" })),
			PATIENT,
		);
		expect(result).toEqual(
			match(prop(PATIENT, "name"), literal("ali"), "starts-with"),
		);
	});

	it("builds a `phonetic` `match` clause for `phonetic` mode", () => {
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "name", "Name", "text", "name", {
				mode: phoneticMode(),
			}),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ name: "alis" })),
			PATIENT,
		);
		expect(result).toEqual(
			match(prop(PATIENT, "name"), literal("alis"), "phonetic"),
		);
	});

	it("builds a `fuzzy-date` `match` clause for `fuzzy-date` mode", () => {
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "dob", "Date of Birth", "text", "dob", {
				mode: fuzzyDateMode(),
			}),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ dob: "2000-01-01" })),
			PATIENT,
		);
		expect(result).toEqual(
			match(prop(PATIENT, "dob"), literal("2000-01-01"), "fuzzy-date"),
		);
	});

	it("threads `via` (relation walk) into the `prop` reference", () => {
		const via = ancestorPath(relationStep("parent", "household"));
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "region", "Region", "text", "region", {
				via,
			}),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ region: "north" })),
			PATIENT,
		);
		expect(result).toEqual(eq(prop(PATIENT, "region", via), literal("north")));
		expect(predicateSchema.parse(result)).toEqual(result);
	});
});

describe("composeRuntimeFilter — multi-select-contains mode", () => {
	it("builds a `quantifier: any` predicate for the `any` quantifier", () => {
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "tags", "Tags", "select", "tags", {
				mode: multiSelectContainsMode("any"),
			}),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ tags: "red, green, blue" })),
			PATIENT,
		);
		expect(result).toEqual(
			multiSelectAny(
				prop(PATIENT, "tags"),
				literal("red"),
				literal("green"),
				literal("blue"),
			),
		);
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("builds a `quantifier: all` predicate for the `all` quantifier", () => {
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "tags", "Tags", "select", "tags", {
				mode: multiSelectContainsMode("all"),
			}),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ tags: "vip,priority" })),
			PATIENT,
		);
		expect(result).toEqual(
			multiSelectAll(
				prop(PATIENT, "tags"),
				literal("vip"),
				literal("priority"),
			),
		);
	});

	it("returns matchAll() when the value is comma-only / whitespace-only", () => {
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "tags", "Tags", "select", "tags", {
				mode: multiSelectContainsMode("any"),
			}),
		];
		// After split + trim + filter-empty, `tags: ", , "` produces an
		// empty list. The input contributes nothing; the global call
		// returns the conjunction identity.
		expect(
			composeRuntimeFilter(
				inputs,
				new Map(Object.entries({ tags: ", , " })),
				PATIENT,
			),
		).toEqual(matchAll());
	});

	it("trims whitespace around tokens", () => {
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "tags", "Tags", "select", "tags", {
				mode: multiSelectContainsMode("any"),
			}),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ tags: "  red  ,  green  " })),
			PATIENT,
		);
		expect(result).toEqual(
			multiSelectAny(prop(PATIENT, "tags"), literal("red"), literal("green")),
		);
	});
});

describe("composeRuntimeFilter — range mode", () => {
	it("reads `:from` and `:to` keys for an explicit `range` mode on a `date` input", () => {
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "dob", "Date of Birth", "date", "dob", {
				mode: rangeMode(),
			}),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(
				Object.entries({
					"dob:from": "2000-01-01",
					"dob:to": "2010-12-31",
				}),
			),
			PATIENT,
		);
		expect(result).toMatchObject({
			kind: "between",
			lowerInclusive: true,
			upperInclusive: true,
			lower: {
				kind: "term",
				term: { kind: "literal", value: "2000-01-01", data_type: "date" },
			},
			upper: {
				kind: "term",
				term: { kind: "literal", value: "2010-12-31", data_type: "date" },
			},
		});
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("defaults to `range` for `date-range` inputs (per-type default)", () => {
		const inputs = [
			simpleSearchInputDef(
				asUuid("a"),
				"visit_dates",
				"Visit Dates",
				"date-range",
				"visit_date",
			),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(
				Object.entries({
					"visit_dates:from": "2025-01-01",
					"visit_dates:to": "2025-06-30",
				}),
			),
			PATIENT,
		);
		expect(result).toMatchObject({
			kind: "between",
			lower: {
				kind: "term",
				term: { kind: "literal", value: "2025-01-01", data_type: "date" },
			},
			upper: {
				kind: "term",
				term: { kind: "literal", value: "2025-06-30", data_type: "date" },
			},
		});
	});

	it("emits a lower-only `between` when only `:from` is set", () => {
		const inputs = [
			simpleSearchInputDef(
				asUuid("a"),
				"visit_dates",
				"Visit Dates",
				"date-range",
				"visit_date",
			),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ "visit_dates:from": "2025-01-01" })),
			PATIENT,
		);
		expect(result).toMatchObject({
			kind: "between",
			lower: {
				kind: "term",
				term: { kind: "literal", value: "2025-01-01", data_type: "date" },
			},
		});
		// Round-trip parse confirms the at-least-one-bound `.refine(...)`
		// admits the lower-only shape.
		expect(predicateSchema.parse(result)).toEqual(result);
		// `upper` key is structurally absent (Zod's `.optional()` strip)
		// rather than `upper: undefined`.
		if (result.kind === "between") {
			expect("upper" in result).toBe(false);
		}
	});

	it("emits an upper-only `between` when only `:to` is set", () => {
		const inputs = [
			simpleSearchInputDef(
				asUuid("a"),
				"visit_dates",
				"Visit Dates",
				"date-range",
				"visit_date",
			),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ "visit_dates:to": "2025-06-30" })),
			PATIENT,
		);
		expect(result).toMatchObject({
			kind: "between",
			upper: {
				kind: "term",
				term: { kind: "literal", value: "2025-06-30", data_type: "date" },
			},
		});
		expect(predicateSchema.parse(result)).toEqual(result);
		if (result.kind === "between") {
			expect("lower" in result).toBe(false);
		}
	});

	it("returns matchAll() when both `:from` and `:to` are absent", () => {
		const inputs = [
			simpleSearchInputDef(
				asUuid("a"),
				"visit_dates",
				"Visit Dates",
				"date-range",
				"visit_date",
			),
		];
		expect(
			composeRuntimeFilter(inputs, new Map(Object.entries({})), PATIENT),
		).toEqual(matchAll());
	});

	it("treats malformed date bounds as absent (mid-edit value safety)", () => {
		const inputs = [
			simpleSearchInputDef(
				asUuid("a"),
				"visit_dates",
				"Visit Dates",
				"date-range",
				"visit_date",
			),
		];
		// `2025-` is partially-typed; `xx` is non-date. The input
		// contributes nothing rather than crashing the SQL layer with a
		// malformed `dateLiteral`.
		expect(
			composeRuntimeFilter(
				inputs,
				new Map(
					Object.entries({
						"visit_dates:from": "2025-",
						"visit_dates:to": "xx",
					}),
				),
				PATIENT,
			),
		).toEqual(matchAll());
	});

	it("treats one malformed bound as absent while the other contributes", () => {
		const inputs = [
			simpleSearchInputDef(
				asUuid("a"),
				"visit_dates",
				"Visit Dates",
				"date-range",
				"visit_date",
			),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(
				Object.entries({
					"visit_dates:from": "2025-01-01",
					"visit_dates:to": "junk",
				}),
			),
			PATIENT,
		);
		expect(result).toMatchObject({
			kind: "between",
			lower: {
				kind: "term",
				term: { kind: "literal", value: "2025-01-01", data_type: "date" },
			},
		});
		if (result.kind === "between") {
			expect("upper" in result).toBe(false);
		}
	});
});

describe("composeRuntimeFilter — advanced arm substitution", () => {
	it("substitutes a value-position `input(name)` term across `compare`", () => {
		// Authored predicate: `prop("name") === input("name_search")`.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"name_search",
			"Name search",
			"text",
			eq(prop(PATIENT, "name"), input("name_search")),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ name_search: "alice" })),
			PATIENT,
		);
		// Substitution replaces `term(input("name_search"))` with
		// `term(literal("alice"))`. `prop("name")` is unchanged.
		expect(result).toEqual(eq(prop(PATIENT, "name"), literal("alice")));
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("substitutes through `match.value`", () => {
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			match(prop(PATIENT, "name"), input("q"), "fuzzy"),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "alic" })),
			PATIENT,
		);
		expect(result).toEqual(
			match(prop(PATIENT, "name"), literal("alic"), "fuzzy"),
		);
	});

	it("substitutes through nested `and`/`or` clauses", () => {
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			and(
				eq(prop(PATIENT, "status"), literal("open")),
				or(
					eq(prop(PATIENT, "name"), input("q")),
					eq(prop(PATIENT, "alias"), input("q")),
				),
			),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "alice" })),
			PATIENT,
		);
		expect(result).toEqual(
			and(
				eq(prop(PATIENT, "status"), literal("open")),
				or(
					eq(prop(PATIENT, "name"), literal("alice")),
					eq(prop(PATIENT, "alias"), literal("alice")),
				),
			),
		);
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("substitutes through `arith` operands inside a comparison (cross-family)", () => {
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"min_age",
			"Min age",
			"text",
			// `(prop("age") + input("min_age")) > literal(0)` — the
			// input sits inside an arith operand, which sits in the
			// left-side of a comparison. Substitution must reach
			// through arith into the term arm.
			eq(
				arith("+", term(prop(PATIENT, "age")), term(input("min_age"))),
				literal(0),
			),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ min_age: "5" })),
			PATIENT,
		);
		expect(result).toEqual(
			eq(
				arith("+", term(prop(PATIENT, "age")), term(literal("5"))),
				literal(0),
			),
		);
	});

	it("substitutes through `if.cond` (cross-family Predicate slot)", () => {
		// Authored predicate uses `ifExpr` in a value position:
		// `eq(if(prop("name") === input("q"), literal("yes"),
		// literal("no")), literal("yes"))`. Substitution must reach
		// into the `if.cond` predicate slot via the cross-family
		// recursion path.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			eq(
				ifExpr(
					eq(prop(PATIENT, "name"), input("q")),
					term(literal("yes")),
					term(literal("no")),
				),
				literal("yes"),
			),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "alice" })),
			PATIENT,
		);
		expect(result).toEqual(
			eq(
				ifExpr(
					eq(prop(PATIENT, "name"), literal("alice")),
					term(literal("yes")),
					term(literal("no")),
				),
				literal("yes"),
			),
		);
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("substitutes through `switch.cases[].then` and `switch.fallback`", () => {
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"alias",
			"Alias",
			"text",
			eq(
				switchExpr(
					term(prop(PATIENT, "tier")),
					[switchCase(literal("vip"), term(input("alias")))],
					term(input("alias")),
				),
				literal("alice"),
			),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ alias: "ALICE-VIP" })),
			PATIENT,
		);
		expect(result).toEqual(
			eq(
				switchExpr(
					term(prop(PATIENT, "tier")),
					[switchCase(literal("vip"), term(literal("ALICE-VIP")))],
					term(literal("ALICE-VIP")),
				),
				literal("alice"),
			),
		);
	});

	it("substitutes through `count.where` (cross-family Predicate slot)", () => {
		// `count(subcasePath("parent"), where: status === input("status_filter"))`
		// inside a comparison.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"status_filter",
			"Filter",
			"text",
			exists(
				subcasePath("parent", "household"),
				eq(prop("household", "owner"), input("status_filter")),
			),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ status_filter: "alice@example.com" })),
			PATIENT,
		);
		expect(result).toEqual(
			exists(
				subcasePath("parent", "household"),
				eq(prop("household", "owner"), literal("alice@example.com")),
			),
		);
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("substitutes inside a `not(...)` clause", () => {
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			not(eq(prop(PATIENT, "name"), input("q"))),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "alice" })),
			PATIENT,
		);
		expect(result).toEqual(not(eq(prop(PATIENT, "name"), literal("alice"))));
	});

	it("preserves the trigger slot of `whenInputPresent` (no substitution on the SearchInputRef)", () => {
		// `whenInputPresent.input` is structurally a `SearchInputRef`,
		// NOT a value-position term. The substitution must NOT replace
		// it with a literal — that would violate the slot's
		// discriminator. Only the inner `clause` is recursed into.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			whenInput(input("q"), eq(prop(PATIENT, "name"), input("q"))),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "alice" })),
			PATIENT,
		);
		// The trigger slot stays as `input("q")`; the inner-clause
		// `input("q")` is substituted with the literal.
		expect(result).toEqual(
			whenInput(input("q"), eq(prop(PATIENT, "name"), literal("alice"))),
		);
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("leaves orphan `input(other)` references untouched", () => {
		// The author's predicate references TWO inputs by name (`q` and
		// `region`). Only `q` is declared in this test's input list, so
		// only `input("q")` substitutes; `input("region")` stays as-is.
		// (The validator catches structurally-orphan refs at parse
		// time; this test confirms the runtime substitution doesn't
		// silently rewrite a different input's ref.)
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			and(
				eq(prop(PATIENT, "name"), input("q")),
				eq(prop(PATIENT, "region"), input("region")),
			),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "alice" })),
			PATIENT,
		);
		expect(result).toEqual(
			and(
				eq(prop(PATIENT, "name"), literal("alice")),
				eq(prop(PATIENT, "region"), input("region")),
			),
		);
	});

	it("returns matchAll() for an advanced arm whose value is empty", () => {
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			eq(prop(PATIENT, "name"), input("q")),
		);
		expect(
			composeRuntimeFilter([advanced], new Map(Object.entries({})), PATIENT),
		).toEqual(matchAll());
	});

	it("substitutes through `is-blank.left` (advanced arm)", () => {
		// `isBlank(input("q"))` — substitution replaces the value-
		// position term with a literal. Structurally degenerate at
		// runtime (asking "is the literal 'alice' blank") but
		// semantically faithful: the AST is preserved through the
		// substitution.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			isBlank(input("q")),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "alice" })),
			PATIENT,
		);
		expect(result).toEqual(isBlank(literal("alice")));
	});

	it("substitutes through `concat.parts` (advanced arm)", () => {
		// `eq(concat(prop("name"), input("suffix")), literal("alice-vip"))` —
		// the input ref sits inside one of the variadic `concat` parts.
		// Substitution must reach into every part position.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"suffix",
			"Suffix",
			"text",
			eq(
				concat(term(prop(PATIENT, "name")), term(input("suffix"))),
				literal("alice-vip"),
			),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ suffix: "-vip" })),
			PATIENT,
		);
		expect(result).toEqual(
			eq(
				concat(term(prop(PATIENT, "name")), term(literal("-vip"))),
				literal("alice-vip"),
			),
		);
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("substitutes through `coalesce.values` (advanced arm)", () => {
		// Variadic `coalesce` — substitute through every fallback slot.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			eq(
				coalesce(term(input("q")), term(prop(PATIENT, "default_name"))),
				literal("alice"),
			),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "alice" })),
			PATIENT,
		);
		expect(result).toEqual(
			eq(
				coalesce(term(literal("alice")), term(prop(PATIENT, "default_name"))),
				literal("alice"),
			),
		);
	});

	it("substitutes through `format-date.date` (advanced arm)", () => {
		// `format-date` carries a single `date` slot; the input ref
		// drives the date value.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"raw_date",
			"Raw date",
			"text",
			eq(formatDate(term(input("raw_date")), "iso"), literal("2025-01-01")),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ raw_date: "2025-01-01" })),
			PATIENT,
		);
		expect(result).toEqual(
			eq(formatDate(term(literal("2025-01-01")), "iso"), literal("2025-01-01")),
		);
	});

	it("substitutes through `within-distance.center` (advanced arm)", () => {
		// The `center` slot accepts a `ValueExpression`; an
		// input-ref-driven center expression is the load-bearing case
		// for runtime distance filtering.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"user_location",
			"User location",
			"text",
			within(prop("clinic", "location"), input("user_location"), 50, "miles"),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ user_location: "37.7749,-122.4194" })),
			PATIENT,
		);
		expect(result).toEqual(
			within(
				prop("clinic", "location"),
				literal("37.7749,-122.4194"),
				50,
				"miles",
			),
		);
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("substitutes through `in.left` and preserves the literal-only `values` slot", () => {
		// `in.left` is `ValueExpression` — substitution reaches it.
		// `in.values` is literal-only (schema-enforced); the runtime
		// passes the values list through unchanged.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			isIn(
				term(input("q")),
				literal("alice"),
				literal("bob"),
				literal("carol"),
			),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "alice" })),
			PATIENT,
		);
		expect(result).toEqual(
			isIn(
				term(literal("alice")),
				literal("alice"),
				literal("bob"),
				literal("carol"),
			),
		);
	});

	it("substitutes through `between` bounds (advanced arm)", () => {
		// `between.lower` / `between.upper` are `ValueExpression` slots;
		// an input-ref-driven bound exercises both.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"max_age",
			"Max age",
			"text",
			between(prop(PATIENT, "age"), {
				lower: literal(0),
				upper: term(input("max_age")),
			}),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ max_age: "100" })),
			PATIENT,
		);
		expect(result).toEqual(
			between(prop(PATIENT, "age"), {
				lower: literal(0),
				upper: term(literal("100")),
			}),
		);
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("substitutes through `gt` (a comparison-family alias) inside an `and`", () => {
		// Verifies the comparison family's `gt` arm specifically — the
		// switch handles all six comparison kinds via one fall-through,
		// so any of `gt` / `gte` / `lt` / `lte` exercises the same
		// branch. `gt` is the most idiomatic age-gate example.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"min_age",
			"Min age",
			"text",
			and(
				gt(prop(PATIENT, "age"), term(input("min_age"))),
				eq(prop(PATIENT, "status"), literal("open")),
			),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ min_age: "18" })),
			PATIENT,
		);
		expect(result).toEqual(
			and(
				gt(prop(PATIENT, "age"), term(literal("18"))),
				eq(prop(PATIENT, "status"), literal("open")),
			),
		);
	});
});

describe("composeRuntimeFilter — mixed-arm composition", () => {
	it("AND-composes simple + advanced contributions in declaration order", () => {
		const simple = simpleSearchInputDef(
			asUuid("a"),
			"status",
			"Status",
			"text",
			"status",
		);
		const advanced = advancedSearchInputDef(
			asUuid("b"),
			"q",
			"Query",
			"text",
			match(prop(PATIENT, "name"), input("q"), "fuzzy"),
		);
		const result = composeRuntimeFilter(
			[simple, advanced],
			new Map(Object.entries({ status: "open", q: "alice" })),
			PATIENT,
		);
		expect(result).toEqual(
			and(
				eq(prop(PATIENT, "status"), literal("open")),
				match(prop(PATIENT, "name"), literal("alice"), "fuzzy"),
			),
		);
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("collapses to the lone clause when only one input contributes", () => {
		// `and(...)` reduces a one-clause conjunction to the lone
		// clause (per `lib/domain/predicate/reduction.ts`). The result
		// should be the bare `eq` clause, not a one-clause `and`
		// envelope.
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "status", "Status", "text", "status"),
			simpleSearchInputDef(asUuid("b"), "name", "Name", "text", "name"),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ status: "open" })),
			PATIENT,
		);
		expect(result).toEqual(eq(prop(PATIENT, "status"), literal("open")));
		expect(result.kind).toBe("eq");
	});

	it("composes range + advanced inputs into one AND chain", () => {
		const simple = simpleSearchInputDef(
			asUuid("a"),
			"visit_dates",
			"Visit Dates",
			"date-range",
			"visit_date",
		);
		const advanced = advancedSearchInputDef(
			asUuid("b"),
			"q",
			"Query",
			"text",
			eq(prop(PATIENT, "name"), input("q")),
		);
		const result = composeRuntimeFilter(
			[simple, advanced],
			new Map(
				Object.entries({
					"visit_dates:from": "2025-01-01",
					"visit_dates:to": "2025-12-31",
					q: "alice",
				}),
			),
			PATIENT,
		);
		// The range arm contributes a between; the advanced arm
		// contributes an eq with the substituted literal. The two
		// AND-compose.
		expect(result.kind).toBe("and");
		if (result.kind === "and") {
			expect(result.clauses).toHaveLength(2);
			expect(result.clauses[0]).toMatchObject({
				kind: "between",
				lower: {
					kind: "term",
					term: { kind: "literal", value: "2025-01-01", data_type: "date" },
				},
				upper: {
					kind: "term",
					term: { kind: "literal", value: "2025-12-31", data_type: "date" },
				},
			});
			expect(result.clauses[1]).toEqual(
				eq(prop(PATIENT, "name"), literal("alice")),
			);
		}
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("produces matchAll() when one populated input is empty among others", () => {
		// The `name` input is populated; the `status` input is empty.
		// Only `name` contributes; the result collapses to the lone
		// clause (single-clause `and` reduction).
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "status", "Status", "text", "status"),
			simpleSearchInputDef(asUuid("b"), "name", "Name", "text", "name"),
			simpleSearchInputDef(asUuid("c"), "alias", "Alias", "text", "alias"),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ name: "alice", status: "", alias: "" })),
			PATIENT,
		);
		expect(result).toEqual(eq(prop(PATIENT, "name"), literal("alice")));
	});
});

describe("composeRuntimeFilter — round-trip + builder reuse", () => {
	it("uses builders (not literals) so the result round-trips through the schema unchanged", () => {
		// Smoke test: a predicate that exercises every operator family
		// the bindings layer constructs. Round-trip parse confirms the
		// schema accepts every shape produced.
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "name", "Name", "text", "name", {
				mode: fuzzyMode(),
			}),
			simpleSearchInputDef(asUuid("b"), "tags", "Tags", "select", "tags", {
				mode: multiSelectContainsMode("any"),
			}),
			simpleSearchInputDef(
				asUuid("c"),
				"visit_dates",
				"Visit Dates",
				"date-range",
				"visit_date",
			),
			advancedSearchInputDef(
				asUuid("d"),
				"q",
				"Query",
				"text",
				and(
					eq(prop(PATIENT, "alias"), input("q")),
					not(eq(prop(PATIENT, "alias"), literal("admin"))),
				),
			),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(
				Object.entries({
					name: "alic",
					tags: "vip,priority",
					"visit_dates:from": "2025-01-01",
					"visit_dates:to": "2025-12-31",
					q: "alice",
				}),
			),
			PATIENT,
		);
		// The exact AST shape isn't asserted here — the test above
		// already pins per-arm correctness — but the round-trip parse
		// confirms the bindings layer never produces an
		// schema-rejected AST shape.
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("returns matchNone() never (the bindings layer only builds positive clauses)", () => {
		// Defensive check: the bindings layer never synthesizes a
		// `match-none` clause directly. `match-none` only surfaces if
		// an input value path is structurally impossible (e.g. an
		// always-false advanced predicate the author hand-wrote and
		// that the substitution + reduction collapsed). Making the
		// invariant explicit here means a future regression that
		// silently produces `match-none` from this layer fails this
		// test loudly.
		const inputs = [
			simpleSearchInputDef(asUuid("a"), "name", "Name", "text", "name"),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(Object.entries({ name: "alice" })),
			PATIENT,
		);
		expect(result).not.toEqual(matchNone());
	});

	it("supports the full `dateLiteral` shape parity with builders", () => {
		// Confirms the range-mode bound shape is structurally identical
		// to a hand-built `dateLiteral` — no shape drift that downstream
		// equality checks would fail.
		const inputs = [
			simpleSearchInputDef(
				asUuid("a"),
				"visit_dates",
				"Visit Dates",
				"date-range",
				"visit_date",
			),
		];
		const result = composeRuntimeFilter(
			inputs,
			new Map(
				Object.entries({
					"visit_dates:from": "2025-01-01",
					"visit_dates:to": "2025-12-31",
				}),
			),
			PATIENT,
		);
		if (result.kind === "between") {
			expect(result.lower).toEqual(term(dateLiteral("2025-01-01")));
			expect(result.upper).toEqual(term(dateLiteral("2025-12-31")));
		} else {
			throw new Error(
				`expected the result to be a \`between\` clause; got \`${result.kind}\`.`,
			);
		}
	});
});

describe("composeRuntimeFilter — advanced arm rewriter, Predicate-side arm coverage", () => {
	// Exhaustive-switch coverage in the AST rewriter catches missing-arm
	// regressions at compile time, but existing-arm regressions (wrong
	// slot recursed, wrong slot preserved) compile cleanly. The tests
	// below pin per-arm rewrite behavior so a future edit that breaks
	// one arm fails one named test rather than slipping past as a
	// silent miscompile.

	it("substitutes through `is-null.left` (advanced arm)", () => {
		// `isNull` carries a single `left: ValueExpression` slot. The
		// input ref sits in value position via the `term` arm.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			isNull(input("q")),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "alice" })),
			PATIENT,
		);
		expect(result).toEqual(isNull(literal("alice")));
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("substitutes through `missing.where` (advanced arm)", () => {
		// `missing.where` is a `Predicate` (cross-family). The
		// `via` slot is a `RelationPath` and carries no input refs.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			missing(
				subcasePath("parent", "household"),
				eq(prop("household", "owner"), input("q")),
			),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "alice@example.com" })),
			PATIENT,
		);
		expect(result).toEqual(
			missing(
				subcasePath("parent", "household"),
				eq(prop("household", "owner"), literal("alice@example.com")),
			),
		);
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("preserves `match-all` unchanged when wrapped in an advanced predicate", () => {
		// `match-all` is a discriminator-only sentinel; the rewriter
		// hits the no-op return arm and the sentinel node flows
		// through unchanged. The wrapping `and` puts a substitutable
		// sibling next to it so the rewriter must actually recurse
		// through both clauses — a regression that touches the
		// sentinel surfaces as a structural mismatch on the `and.clauses[0]`
		// slot. The builder's `reduceAndImpl` only collapses
		// empty / single-clause inputs (per `lib/domain/predicate/reduction.ts`),
		// so the constructed multi-clause `and` keeps the sentinel
		// at index 0 and substitution flows through to index 1.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			and(matchAll(), eq(prop(PATIENT, "name"), input("q"))),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "alice" })),
			PATIENT,
		);
		expect(result).toEqual(
			and(matchAll(), eq(prop(PATIENT, "name"), literal("alice"))),
		);
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("preserves `match-none` unchanged when wrapped in an advanced predicate", () => {
		// Symmetric to the match-all test — `match-none` flows
		// through the rewriter's no-op return arm. `or` keeps both
		// clauses intact (the builder reducer doesn't drop sentinels
		// from a multi-clause envelope), so the sentinel survives at
		// index 0 and substitution flows through to index 1.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			or(matchNone(), eq(prop(PATIENT, "name"), input("q"))),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "alice" })),
			PATIENT,
		);
		expect(result).toEqual(
			or(matchNone(), eq(prop(PATIENT, "name"), literal("alice"))),
		);
		expect(predicateSchema.parse(result)).toEqual(result);
	});
});

describe("composeRuntimeFilter — advanced arm rewriter, ValueExpression-side arm coverage", () => {
	it("substitutes through `date-add` operands (both `date` AND `quantity` slots)", () => {
		// Two-input fixture so we can pin that BOTH the `date` slot
		// and the `quantity` slot recurse. A single-input + single-
		// slot fixture would let a regression that recurses only one
		// slot pass; the two-slot pin catches that bug class.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"base",
			"Base date",
			"date",
			eq(
				dateAdd(term(input("base")), "days", term(input("offset"))),
				literal("2025-01-15"),
			),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ base: "2025-01-01", offset: "14" })),
			PATIENT,
		);
		// `input("base")` substitutes because the input def's name is
		// `base`. `input("offset")` is an orphan ref (no matching
		// input def in this fixture's list); it survives unchanged —
		// the rewriter only substitutes for the target input's name.
		expect(result).toEqual(
			eq(
				dateAdd(term(literal("2025-01-01")), "days", term(input("offset"))),
				literal("2025-01-15"),
			),
		);
		expect(predicateSchema.parse(result)).toEqual(result);
	});

	it("substitutes through `date-add`'s `quantity` slot when the input drives that operand", () => {
		// Sister test: substitution lands on the `quantity` slot when
		// the input ref sits there. Combined with the previous test,
		// both slots have explicit coverage.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"offset",
			"Offset",
			"text",
			eq(
				dateAdd(term(prop(PATIENT, "dob")), "days", term(input("offset"))),
				literal("2025-01-15"),
			),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ offset: "30" })),
			PATIENT,
		);
		expect(result).toEqual(
			eq(
				dateAdd(term(prop(PATIENT, "dob")), "days", term(literal("30"))),
				literal("2025-01-15"),
			),
		);
	});

	it("substitutes through `date-coerce.value` (advanced arm)", () => {
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"raw",
			"Raw date",
			"text",
			eq(dateCoerce(term(input("raw"))), literal("2025-01-01")),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ raw: "2025-01-01" })),
			PATIENT,
		);
		expect(result).toEqual(
			eq(dateCoerce(term(literal("2025-01-01"))), literal("2025-01-01")),
		);
	});

	it("substitutes through `datetime-coerce.value` (advanced arm)", () => {
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"raw",
			"Raw datetime",
			"text",
			eq(datetimeCoerce(term(input("raw"))), literal("2025-01-01T00:00:00")),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ raw: "2025-01-01T00:00:00" })),
			PATIENT,
		);
		expect(result).toEqual(
			eq(
				datetimeCoerce(term(literal("2025-01-01T00:00:00"))),
				literal("2025-01-01T00:00:00"),
			),
		);
	});

	it("substitutes through `double.value` (advanced arm)", () => {
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			eq(double(term(input("q"))), literal(42)),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "42" })),
			PATIENT,
		);
		expect(result).toEqual(eq(double(term(literal("42"))), literal(42)));
	});

	it("substitutes through `unwrap-list.value` (advanced arm)", () => {
		// `unwrap-list` is the CSQL-only value function lifting a
		// JSON-encoded array property. The runtime rewriter still
		// has to recurse into the `value` slot — substitution is
		// AST-level and indifferent to the wire target.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			eq(unwrapList(term(input("q"))), literal("tag")),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "tags-json" })),
			PATIENT,
		);
		expect(result).toEqual(
			eq(unwrapList(term(literal("tags-json"))), literal("tag")),
		);
	});

	it("preserves `today` unchanged (no-op return arm)", () => {
		// `today` is a discriminator-only constant — no slots, no
		// substitution. The rewriter hits the no-op return arm and
		// the AST flows through unchanged.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			eq(today(), term(input("q"))),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "2025-01-01" })),
			PATIENT,
		);
		// `today()` survives untouched; `input("q")` substitutes.
		expect(result).toEqual(eq(today(), term(literal("2025-01-01"))));
	});

	it("preserves `now` unchanged (no-op return arm)", () => {
		// Symmetric to the `today` test — `now` is a discriminator-
		// only constant.
		const advanced = advancedSearchInputDef(
			asUuid("a"),
			"q",
			"Query",
			"text",
			eq(now(), term(input("q"))),
		);
		const result = composeRuntimeFilter(
			[advanced],
			new Map(Object.entries({ q: "2025-01-01T00:00:00" })),
			PATIENT,
		);
		expect(result).toEqual(eq(now(), term(literal("2025-01-01T00:00:00"))));
	});
});

describe("composeRuntimeFilter — default-mode table contract", () => {
	// Pins the agreement between the runtime's internal default-
	// mode table and `APPLICABLE_SEARCH_MODES` in
	// `lib/domain/modules.ts`. The contract: each type's default
	// mode is the FIRST entry of its applicable-modes tuple. The
	// runtime construction reads off a typed table, but the test
	// asserts the values agree with the canonical source so a
	// table-drift regression fails one named test rather than
	// surfacing through a downstream wire-emission divergence.

	it("each type's default-mode dispatch agrees with the head of its applicable-modes tuple", () => {
		const types: ReadonlyArray<SearchInputType> = [
			"text",
			"select",
			"date",
			"date-range",
			"barcode",
		];
		for (const type of types) {
			const expected = APPLICABLE_SEARCH_MODES[type][0];
			const inputs = [
				simpleSearchInputDef(asUuid("a"), "field", "Field", type, "field"),
			];
			// Use the input.name key for non-range defaults; the
			// `:from`/`:to` key shape for the range default.
			const inputValues =
				expected === "range"
					? new Map(
							Object.entries({
								"field:from": "2025-01-01",
								"field:to": "2025-12-31",
							}),
						)
					: new Map(Object.entries({ field: "value" }));
			const result = composeRuntimeFilter(inputs, inputValues, PATIENT);
			// Confirm the expected wire shape per the head-of-tuple
			// expected mode. The Postgres compiler / wire emitters
			// downstream branch on this kind, so getting it wrong here
			// silently produces wrong wire output.
			switch (expected) {
				case "exact":
					expect(result.kind).toBe("eq");
					break;
				case "range":
					expect(result.kind).toBe("between");
					break;
				default:
					throw new Error(
						`unexpected default mode \`${expected}\` for type \`${type}\` — ` +
							"the default-mode test asserts only the modes that any " +
							"current type defaults to. Adding a new default kind in " +
							"`APPLICABLE_SEARCH_MODES` requires extending this switch.",
					);
			}
		}
	});
});
