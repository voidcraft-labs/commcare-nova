// lib/domain/predicate/__tests__/builders.test.ts
//
// Acceptance tests for the typed predicate builders. Two things every
// builder test confirms:
//   1. The constructed AST has the right `kind` discriminator (so
//      consumers narrowing on `kind` get the correct variant typing).
//   2. The constructed AST round-trips through `predicateSchema.parse`
//      without modification — i.e. the builder layer cannot produce an
//      AST that the schema would reject.
//
// The round-trip check is the load-bearing assertion: it locks the
// builder layer against drift from the schema. If the schema gains a
// new required field on a builder's target arm and the matching builder
// isn't updated, the round-trip parse for that builder fails — the new
// required field is missing from the constructed AST, so
// `predicateSchema.parse(p)` throws.
//
// Because the builders return precise per-operator types (rather than
// the full `Predicate` union), tests access fields like `p.clauses`,
// `p.clause`, `p.values` directly without `if (p.kind === "...")`
// re-narrowing. The continued absence of those guards is itself a
// regression check — if a future refactor widens a builder return type
// back to `Predicate`, the field accesses below would stop compiling.

import { describe, expect, it } from "vitest";
import {
	ancestorPath,
	and,
	anyRelationPath,
	arith,
	between,
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
	gte,
	ifExpr,
	input,
	isBlank,
	isIn,
	isNull,
	literal,
	lt,
	lte,
	match,
	matchAll,
	matchNone,
	missing,
	multiSelectAll,
	multiSelectAny,
	neq,
	not,
	now,
	or,
	prop,
	relationStep,
	selfPath,
	sessionContext,
	sessionUser,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	timeLiteral,
	today,
	toValueExpression,
	unwrapList,
	whenInput,
	within,
} from "../builders";
import {
	MATCH_MODES,
	type Predicate,
	predicateSchema,
	type RelationPath,
	relationPathSchema,
	type ValueExpression,
	valueExpressionSchema,
} from "../types";

describe("predicate builders", () => {
	it("constructs a nested and(eq, gt) predicate", () => {
		const p = and(
			eq(prop("patient", "status"), literal("open")),
			gt(prop("patient", "age"), literal(18)),
		);
		expect(p.kind).toBe("and");
		// `p.clauses` is directly accessible — `and` returns the precise
		// `{ kind: "and"; clauses: Predicate[] }` shape, not the wider
		// `Predicate` union. If a future refactor widens this back to
		// `Predicate`, this line stops compiling.
		expect(p.clauses).toHaveLength(2);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("constructs a within-distance predicate", () => {
		const p = within(
			prop("clinic", "location"),
			input("user_location"),
			50,
			"miles",
		);
		expect(p.kind).toBe("within-distance");
		expect(p.unit).toBe("miles");
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("constructs when-input-present wrapping an eq", () => {
		const p = whenInput(
			input("phone_number"),
			eq(prop("patient", "phone"), input("phone_number")),
		);
		expect(p.kind).toBe("when-input-present");
		// The body slot is named `clause` (not `then`) — see the JSDoc
		// on `whenInputPresentSchema` in `types.ts` for the rationale.
		expect(p.clause.kind).toBe("eq");
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("constructs or(not(...), match(...))", () => {
		const p = or(
			not(eq(prop("patient", "status"), literal("closed"))),
			match(prop("patient", "name"), "alice", "fuzzy"),
		);
		expect(p.kind).toBe("or");
		expect(p.clauses[0].kind).toBe("not");
		expect(p.clauses[1].kind).toBe("match");
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	// Each exported builder gets at least one explicit happy-path test
	// here: silent rename or removal of any export must not pass CI.
	// `sessionUser` / `sessionContext`, `isIn`, and `match` would
	// otherwise be only structurally implied via other builders'
	// arguments or composite tests. (The `isIn` variadic-with-required-
	// first contract is locked separately by the type-level guard at
	// the bottom of this file.)

	it("constructs a sessionUser reference round-tripping inside a comparison", () => {
		// `commcare_project` is a custom user-data field — open-namespace
		// vocabulary populated by `addUserProperties` at
		// `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`.
		// Wrapping the term in `eq` flows it through `predicateSchema`
		// (terms don't parse standalone via `predicateSchema`).
		const t = sessionUser("commcare_project");
		expect(t.kind).toBe("session-user");
		expect(t.field).toBe("commcare_project");
		const p = eq(t, literal("project-x"));
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("constructs a sessionContext reference round-tripping inside a comparison", () => {
		// `userid` is a closed-enum member of `SESSION_CONTEXT_FIELDS`
		// — populated by `addMetadata` at the same
		// `SessionInstanceBuilder.java` symbol anchor. The builder's
		// `field` parameter is typed as `SessionContextField`, so
		// passing a string outside the closed set is a compile-time
		// error rather than a runtime parse rejection.
		const t = sessionContext("userid");
		expect(t.kind).toBe("session-context");
		expect(t.field).toBe("userid");
		const p = eq(prop("patient", "owner_id"), t);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("constructs an isIn membership predicate", () => {
		const p = isIn(
			prop("patient", "status"),
			literal("open"),
			literal("active"),
		);
		expect(p.kind).toBe("in");
		expect(p.values).toHaveLength(2);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	// `match` carries a `mode` discriminator across the four CCHQ
	// text-match variants (`fuzzy` / `phonetic` / `fuzzy-date` /
	// `starts-with`). Each mode round-trips through the schema with
	// the same `{ property, value, mode }` payload — iterating
	// `MATCH_MODES` shares the source of truth with the schema so any
	// silent narrowing of the enum on either side (builder or schema)
	// trips the table.
	it.each(MATCH_MODES)("constructs a match predicate with mode: %s", (mode) => {
		const p = match(prop("patient", "name"), "alice", mode);
		expect(p.kind).toBe("match");
		expect(p.value).toBe("alice");
		expect(p.mode).toBe(mode);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	// `multi-select-contains` builders pin the quantifier discriminator
	// at the call site — `multiSelectAny` always sets `quantifier: "any"`
	// and `multiSelectAll` always sets `quantifier: "all"`. The variadic-
	// with-required-first signature mirrors `isIn` / `and` / `or` so
	// callers cannot construct an empty values list at the type layer.
	it("multiSelectAny constructs a single-value predicate with quantifier: any", () => {
		const p = multiSelectAny(prop("patient", "tags"), literal("vip"));
		expect(p.kind).toBe("multi-select-contains");
		expect(p.quantifier).toBe("any");
		expect(p.values).toHaveLength(1);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("multiSelectAny constructs a multi-value predicate", () => {
		const p = multiSelectAny(
			prop("patient", "tags"),
			literal("vip"),
			literal("urgent"),
		);
		expect(p.values).toHaveLength(2);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("multiSelectAll constructs a single-value predicate with quantifier: all", () => {
		// Tuple-with-rest boundary: the smallest valid input. The
		// rest-spread path in the builder (`[first, ...rest]`) reduces
		// to a single-element array when `rest` is empty; pinning that
		// shape parses through the schema without quantifier-coupled
		// behavior changes. Symmetric with `multiSelectAny`'s single-
		// value test above.
		const p = multiSelectAll(prop("patient", "tags"), literal("vaccinated"));
		expect(p.kind).toBe("multi-select-contains");
		expect(p.quantifier).toBe("all");
		expect(p.values).toHaveLength(1);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("multiSelectAll constructs a multi-value predicate", () => {
		const p = multiSelectAll(
			prop("patient", "tags"),
			literal("vip"),
			literal("urgent"),
		);
		expect(p.kind).toBe("multi-select-contains");
		expect(p.quantifier).toBe("all");
		expect(p.values).toHaveLength(2);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	// Null literal round-trip. `literal(null)` is the structural sentinel
	// for the is-unset filter (the type checker resolves it as
	// universally compatible — see typeChecker.ts). Locking the
	// schema-side accept here ensures the runtime invariant holds across
	// the full builder → parse → check chain, not just at the type-check
	// layer.
	it("round-trips a null literal through predicateSchema", () => {
		const p = eq(prop("patient", "name"), literal(null));
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	// Typed literal builders. Each declares its semantic data_type
	// explicitly so the type checker resolves the literal as the
	// declared type rather than falling back to text inference. The
	// round-trip parse confirms the schema accepts the optional
	// `data_type` field, and the explicit `data_type` assertion guards
	// against a future builder rename / regression that drops the field.
	it("constructs a date-typed literal carrying data_type: 'date'", () => {
		const t = dateLiteral("2000-01-01");
		expect(t.kind).toBe("literal");
		expect(t.value).toBe("2000-01-01");
		expect(t.data_type).toBe("date");
		// Round-trip via a comparison so the literal flows through
		// `predicateSchema` (terms don't parse standalone via the
		// predicate schema).
		const p = eq(prop("patient", "dob"), t);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("constructs a datetime-typed literal carrying data_type: 'datetime'", () => {
		const t = datetimeLiteral("2000-01-01T00:00:00");
		expect(t.data_type).toBe("datetime");
		const p = eq(prop("patient", "dob"), t);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("constructs a time-typed literal carrying data_type: 'time'", () => {
		const t = timeLiteral("12:30");
		expect(t.data_type).toBe("time");
		const p = eq(prop("patient", "dob"), t);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	// All six comparison operators share one curried helper, so a
	// regression in the helper's per-kind return-type pinning could
	// silently widen any one of them. Exercising all six in a single
	// parameterized test pins each kind's `kind` discriminator and
	// round-trip parse without restating six near-identical bodies.

	it.each([
		"eq",
		"neq",
		"gt",
		"gte",
		"lt",
		"lte",
	] as const)("constructs a %s comparison that round-trips", (opName) => {
		const op = { eq, neq, gt, gte, lt, lte }[opName];
		const p = op(prop("patient", "age"), literal(18));
		expect(p.kind).toBe(opName);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	// Variadic-with-required-first boundary check. The single-clause
	// case is the smallest valid input; verifying it parses confirms
	// the spread-into-array path works at the lower bound of the
	// schema's tuple-with-rest shape.

	// `and(x)` and `or(x)` collapse to `x` via the construction-time
	// reductions in `reduction.ts` — the single-clause form of either
	// operator is the boolean-algebra identity over a single
	// predicate, so the reducer unwraps. The unwrap is the visible
	// behavior; the same input shape that historically constructed
	// a one-element clause envelope now flows the inner predicate
	// straight through. `isIn(left, single)` retains its envelope
	// shape because `in.values` is a literal list, not a logical
	// operator subject to algebraic identity.
	it("collapses single-clause and / or to the inner predicate via reductions", () => {
		const single = eq(prop("patient", "status"), literal("open"));
		expect(and(single)).toBe(single);
		expect(or(single)).toBe(single);
		// `isIn` has no parallel reduction — single-element membership
		// stays as the canonical `in` shape, so the round-trip parse
		// against `predicateSchema` confirms the envelope shape is
		// still well-typed.
		const i = isIn(prop("patient", "status"), literal("open"));
		expect(i.kind).toBe("in");
		expect(predicateSchema.parse(i)).toEqual(i);
	});

	// `prop()` carries an optional `via: RelationPath` parameter — the
	// relational read. Backward-compat is the load-bearing assertion:
	// callers that don't pass `via` must produce exactly the same
	// shape they used to (no `via` key, not `via: undefined`). The
	// builder uses a conditional construction shape rather than a
	// `via ?? undefined` assignment so the existing `expect(...).toEqual`
	// shape-pin tests above continue to hold.

	it("constructs a prop with no via (backward-compat shape)", () => {
		const p = prop("patient", "age");
		expect(p).toEqual({ kind: "prop", caseType: "patient", property: "age" });
		// The `via` key must be ABSENT, not present-with-undefined.
		// Existing tests in this file use `expect(predicateSchema.parse(p)).toEqual(p)`
		// shape pins; if `via: undefined` started materializing on the
		// constructed object, the round-trip equality could silently
		// break. Lock the absence here.
		expect("via" in p).toBe(false);
	});

	it("constructs a prop with an ancestor via", () => {
		// Canonical relational read shape: `prop(caseType, property,
		// ancestorPath(...))`. The builder threads the relation path
		// onto the constructed object so the schema's
		// `propertyRefSchema.via` slot resolves to the typed
		// structure rather than a stringy slash-path.
		const p = prop("patient", "region", ancestorPath(relationStep("parent")));
		expect(p.via?.kind).toBe("ancestor");
		// Round-trip via a comparison so the prop flows through
		// `predicateSchema` (terms don't parse standalone).
		const wrapped = eq(p, literal("north"));
		expect(predicateSchema.parse(wrapped)).toEqual(wrapped);
	});
});

// `relationPath` family is the typed structural equivalent of CommCare's
// `index/parent/host/...` slash-strings. Each builder pins one
// discriminator (`self`, `ancestor`, `subcase`, `any-relation`) and
// returns the precise variant shape so call-site narrowing on `kind`
// works without re-narrowing.
describe("relationPath builders", () => {
	it("selfPath() constructs the no-traversal kind", () => {
		const p = selfPath();
		expect(p).toEqual({ kind: "self" });
		expect(relationPathSchema.parse(p)).toEqual(p);
	});

	it("relationStep() constructs a single hop with optional throughCaseType", () => {
		// `relationStep` is a thin object constructor — the value
		// lives in pinning the field name `identifier` so callers
		// don't accidentally use `name` or `id`. The optional
		// `throughCaseType` is the type-checker narrowing hint that
		// resolves the destination scope at this step.
		const a = relationStep("parent");
		expect(a).toEqual({ identifier: "parent" });
		// `throughCaseType` must be ABSENT, not undefined, so
		// downstream consumers' `?? `-checks behave consistently
		// with the schema's `.optional()` strip behavior on parse.
		expect("throughCaseType" in a).toBe(false);

		const b = relationStep("parent", "household");
		expect(b).toEqual({ identifier: "parent", throughCaseType: "household" });
	});

	it("ancestorPath() constructs a single-hop ancestor path", () => {
		const p = ancestorPath(relationStep("parent"));
		expect(p.kind).toBe("ancestor");
		expect(p.via).toHaveLength(1);
		expect(p.via[0].identifier).toBe("parent");
		expect(relationPathSchema.parse(p)).toEqual(p);
	});

	it("ancestorPath() constructs a multi-hop ancestor path", () => {
		// Multi-hop paths compile to nested `instance('casedb')`
		// joins on-device and to chained `walk_ancestor_hierarchy`
		// steps in CSQL. The variadic shape lets authors compose
		// chains without manual array construction.
		const p = ancestorPath(
			relationStep("parent", "household"),
			relationStep("host"),
		);
		expect(p.via).toHaveLength(2);
		expect(p.via[0]).toEqual({
			identifier: "parent",
			throughCaseType: "household",
		});
		expect(p.via[1]).toEqual({ identifier: "host" });
		expect(relationPathSchema.parse(p)).toEqual(p);
	});

	it("subcasePath() constructs a subcase relation", () => {
		const p = subcasePath("parent", "patient");
		expect(p).toEqual({
			kind: "subcase",
			identifier: "parent",
			ofCaseType: "patient",
		});
		expect(relationPathSchema.parse(p)).toEqual(p);
	});

	it("subcasePath() omits ofCaseType when not provided", () => {
		const p = subcasePath("parent");
		expect(p).toEqual({ kind: "subcase", identifier: "parent" });
		// Same absent-not-undefined contract as `prop`'s `via`
		// slot — the schema strips absent optionals on parse, so
		// callers' equality assertions need the constructed shape
		// to omit the key when it's not set.
		expect("ofCaseType" in p).toBe(false);
		expect(relationPathSchema.parse(p)).toEqual(p);
	});

	it("anyRelationPath() constructs a direction-agnostic relation", () => {
		const p = anyRelationPath("linked", "referral");
		expect(p).toEqual({
			kind: "any-relation",
			identifier: "linked",
			ofCaseType: "referral",
		});
		expect(relationPathSchema.parse(p)).toEqual(p);
	});

	it("anyRelationPath() omits ofCaseType when not provided", () => {
		const p = anyRelationPath("linked");
		expect(p).toEqual({ kind: "any-relation", identifier: "linked" });
		expect("ofCaseType" in p).toBe(false);
	});
});

// Sentinel-predicate, is-null, range, and relational-quantifier
// builders. Each pins one discriminator (the value the builder layer
// adds over a hand-written object literal: `kind` is set correctly
// and the surrounding shape parses through the schema). The
// round-trip parse is the load-bearing assertion in every case —
// it locks the builder against schema drift the same way the
// existing comparison + logical builders are locked above.
describe("sentinel + range + relational predicate builders", () => {
	it("matchAll() constructs the always-true sentinel", () => {
		const p = matchAll();
		expect(p).toEqual({ kind: "match-all" });
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("matchNone() constructs the always-false sentinel", () => {
		const p = matchNone();
		expect(p).toEqual({ kind: "match-none" });
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("isNull() constructs an is-null with a property reference", () => {
		// `left` is a `ValueExpression`. The builder auto-wraps Term
		// inputs as the structural `term` arm, so `p.left.kind ===
		// "term"` and the original Term sits at `p.left.term.kind`.
		// The round-trip parse against `predicateSchema` confirms the
		// lifted shape.
		const p = isNull(prop("patient", "status"));
		expect(p.kind).toBe("is-null");
		expect(p.left.kind).toBe("term");
		if (p.left.kind === "term") {
			expect(p.left.term.kind).toBe("prop");
		}
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("isNull() accepts any term shape (input / session-user / session-context / literal)", () => {
		// Pin the parameter type — `Term`, not `PropertyRef`. A future
		// regression that narrowed the builder's parameter to
		// `PropertyRef` would not compile against these inputs. Both
		// session arms (open-namespace and closed-enum) flow through the
		// same `Term` discriminator, so each is covered explicitly.
		const a = isNull(input("phone"));
		const b = isNull(sessionUser("region"));
		const c = isNull(sessionContext("userid"));
		const d = isNull(literal("x"));
		expect(predicateSchema.parse(a)).toEqual(a);
		expect(predicateSchema.parse(b)).toEqual(b);
		expect(predicateSchema.parse(c)).toEqual(c);
		expect(predicateSchema.parse(d)).toEqual(d);
	});

	it("isBlank() constructs an is-blank with a property reference", () => {
		// Parallel to `isNull` — same `left: ValueExpression` slot,
		// same per-Term-variant acceptance via auto-wrap, different
		// wire-emission rule (portable absent-OR-empty rather than
		// strict-absent). The builder pins the discriminator and the
		// round-trip parse through `predicateSchema` locks the builder
		// against schema drift on the new arm.
		const p = isBlank(prop("patient", "status"));
		expect(p.kind).toBe("is-blank");
		expect(p.left.kind).toBe("term");
		if (p.left.kind === "term") {
			expect(p.left.term.kind).toBe("prop");
		}
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("isBlank() accepts any term shape (input / session-user / session-context / literal)", () => {
		// Mirrors `isNull`'s acceptance test — the parameter type is
		// `Term`, so every Term variant must compile through the
		// builder. The closed-enum `session-context` arm and the
		// open-namespace `session-user` arm both flow through the same
		// discriminated-union path; each is exercised explicitly.
		const a = isBlank(input("phone"));
		const b = isBlank(sessionUser("region"));
		const c = isBlank(sessionContext("userid"));
		const d = isBlank(literal("x"));
		expect(predicateSchema.parse(a)).toEqual(a);
		expect(predicateSchema.parse(b)).toEqual(b);
		expect(predicateSchema.parse(c)).toEqual(c);
		expect(predicateSchema.parse(d)).toEqual(d);
	});

	it("between() defaults inclusivity to closed bounds when omitted", () => {
		// Default is `true` for both — the standard mathematical
		// `[lower, upper]` convention. The pin here locks the default
		// against silent change; an "open by default" regression would
		// trip this test.
		const p = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
		});
		expect(p.lowerInclusive).toBe(true);
		expect(p.upperInclusive).toBe(true);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("between() honors explicit inclusivity flags", () => {
		// Each flag is independent — a regression that collapsed them
		// into a single `inclusive` slot would not satisfy both
		// assertions below.
		const p = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
			lowerInclusive: false,
			upperInclusive: true,
		});
		expect(p.lowerInclusive).toBe(false);
		expect(p.upperInclusive).toBe(true);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("between() omits absent bounds (does not materialize undefined keys)", () => {
		// Same absent-not-undefined contract as `prop()` / `relationStep()`
		// / `subcasePath()`. Zod's `.optional()` strips absent keys on
		// parse, so a builder that materialized `lower: undefined` /
		// `upper: undefined` would silently break round-trip equality
		// checks like `expect(predicateSchema.parse(p)).toEqual(p)`.
		const lowerOnly = between(prop("patient", "age"), {
			lower: literal(18),
		});
		expect("upper" in lowerOnly).toBe(false);
		expect(predicateSchema.parse(lowerOnly)).toEqual(lowerOnly);

		const upperOnly = between(prop("patient", "age"), {
			upper: literal(65),
		});
		expect("lower" in upperOnly).toBe(false);
		expect(predicateSchema.parse(upperOnly)).toEqual(upperOnly);
	});

	it("between() with no bounds parses-rejects via the schema refinement", () => {
		// TS can't structurally encode "at least one of two optional
		// fields," so the rejection lives at the schema layer — the
		// builder constructs whatever the caller passes and the
		// schema's `.refine(...)` throws. Same shape as
		// `within(prop, center, -10, "miles")`: builder typeable,
		// schema rejects.
		const invalid = between(prop("patient", "age"), {});
		expect(() => predicateSchema.parse(invalid)).toThrow();
	});

	it("exists() constructs an exists with no where", () => {
		const p = exists(ancestorPath(relationStep("parent")));
		expect(p.kind).toBe("exists");
		expect("where" in p).toBe(false);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("exists() constructs an exists with a where filter", () => {
		// Canonical relational filter — "has a parent in region 'north'".
		// The `where` predicate is whatever predicate the caller passes;
		// the builder threads it through onto the constructed object.
		const p = exists(
			ancestorPath(relationStep("parent", "household")),
			eq(prop("household", "region"), literal("north")),
		);
		expect(p.kind).toBe("exists");
		expect(p.where?.kind).toBe("eq");
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("missing() constructs a missing with no where", () => {
		const p = missing(ancestorPath(relationStep("parent")));
		expect(p.kind).toBe("missing");
		expect("where" in p).toBe(false);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("missing() constructs a missing with a where filter", () => {
		const p = missing(
			subcasePath("parent", "patient"),
			eq(prop("patient", "status"), literal("active")),
		);
		expect(p.kind).toBe("missing");
		expect(p.where?.kind).toBe("eq");
		expect(predicateSchema.parse(p)).toEqual(p);
	});
});

// ---------- Builder-reduction integration tests ----------
//
// The seven construction-time reductions in `reduction.ts` are wired
// through the `and` / `or` / `not` builders. Each test below pins one
// reduction's behavior at the builder boundary — the integration
// surface authors and the SA agent see. The reduction-module unit
// tests in `reduction.test.ts` lock the structural-match logic; this
// block locks that the builders actually call the reducers.
//
// Why every assertion uses the builder rather than the reducer
// directly: the builder is the public surface, and the test's job is
// to verify reductions land at the visible API. A reducer-only test
// can't catch a regression that detaches the builder from the
// reducer (e.g. a bad merge that drops the wiring). Both layers are
// tested independently — the unit tests in `reduction.test.ts` lock
// the reducer's correctness; this block locks the builder's wiring.

describe("builder-reduction integration", () => {
	it("and() with no clauses returns the match-all sentinel", () => {
		// Empty conjunction is the boolean-algebra identity element.
		// The variadic `and()` with no arguments was previously a
		// compile-time error (locked by the `@ts-expect-error void
		// and()` directive in the type-level block below); reductions
		// promote it to the canonical `match-all` sentinel.
		const p = and();
		expect(p).toEqual(matchAll());
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("or() with no clauses returns the match-none sentinel", () => {
		// Empty disjunction is the boolean-algebra absorbing element
		// — `or()` over zero clauses evaluates trivially to false.
		// Symmetric with the `and()` case above.
		const p = or();
		expect(p).toEqual(matchNone());
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("and(x) with a single clause unwraps to x (referential equality)", () => {
		// Single-clause `and` is identity over the inner predicate —
		// the reducer returns the inner clause by reference (no
		// clone). The `toBe(x)` assertion (referential equality, not
		// structural) confirms the inner predicate flows through
		// unchanged. A clone would still pass `toEqual(x)` but fail
		// `toBe(x)`.
		const x = eq(prop("patient", "status"), literal("open"));
		expect(and(x)).toBe(x);
	});

	it("or(x) with a single clause unwraps to x (referential equality)", () => {
		const x = eq(prop("patient", "status"), literal("open"));
		expect(or(x)).toBe(x);
	});

	it("not(matchAll()) returns the match-none sentinel", () => {
		// `not(match-all)` is the boolean-algebra collapse of the
		// universal-true predicate to the universal-false sentinel.
		// The builder's `not` calls `reduceNot` first; if the reducer
		// returns a non-undefined shape, the builder returns it
		// directly without constructing the standard `{ kind: "not",
		// clause }` envelope.
		const p = not(matchAll());
		expect(p).toEqual(matchNone());
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("not(matchNone()) returns the match-all sentinel", () => {
		// Symmetric with the previous case — `not(match-none)`
		// collapses to the universal-true sentinel.
		const p = not(matchNone());
		expect(p).toEqual(matchAll());
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("not(not(x)) collapses via double-negation elimination (referential equality)", () => {
		// Double-negation elimination — the reducer unwraps two
		// layers of `not` to surface the inner predicate. The first
		// `not(x)` constructs the standard `{ kind: "not", clause: x
		// }` envelope (no reduction applies on the inner). The
		// second `not(...)` then matches the double-negation rule:
		// `reduceNot` sees `inner.kind === "not"` and returns
		// `inner.clause` (which is `x`). `toBe(x)` confirms
		// referential equality.
		const x = eq(prop("patient", "status"), literal("open"));
		const inner = not(x);
		expect(inner.kind).toBe("not");
		const collapsed = not(inner);
		expect(collapsed).toBe(x);
	});

	it("not(eq(...)) preserves the standard envelope when no reduction applies", () => {
		// Negative case — no reduction matches `not(eq(...))`, so
		// the builder falls through to the standard `{ kind: "not",
		// clause }` shape. The catch-all overload pins the return
		// type as `Extract<Predicate, { kind: "not" }>`, so `p.clause`
		// is directly accessible without re-narrowing on `kind` —
		// demonstrating the precise return-type contract the file-level
		// comment in `builders.ts` promises.
		const innerEq = eq(prop("patient", "status"), literal("open"));
		const p = not(innerEq);
		expect(p.kind).toBe("not");
		expect(p.clause).toBe(innerEq);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("and(x, y) preserves the n-ary envelope when two-or-more clauses are supplied", () => {
		// Two-clause `and` has no canonical reduction — the standard
		// `{ kind: "and", clauses: [x, y] }` envelope is the canonical
		// shape. The n-ary overload pins the return type as
		// `Extract<Predicate, { kind: "and" }>`, so `p.clauses` is
		// directly accessible without re-narrowing.
		const x = eq(prop("patient", "status"), literal("open"));
		const y = gt(prop("patient", "age"), literal(18));
		const p = and(x, y);
		expect(p.kind).toBe("and");
		expect(p.clauses).toHaveLength(2);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("or(x, y) preserves the n-ary envelope when two-or-more clauses are supplied", () => {
		// Symmetric with the `and(x, y)` case — the n-ary overload pins
		// the precise `Extract<Predicate, { kind: "or" }>` return type.
		const x = eq(prop("patient", "status"), literal("open"));
		const y = eq(prop("patient", "status"), literal("closed"));
		const p = or(x, y);
		expect(p.kind).toBe("or");
		expect(p.clauses).toHaveLength(2);
		expect(predicateSchema.parse(p)).toEqual(p);
	});
});

/* --- Type-level tests -------------------------------------------------
 *
 * Compile-time regression lock for the variadic-with-required-first
 * contract on `isIn`, `multiSelectAny`, and `multiSelectAll`. The
 * `@ts-expect-error` directives below are the assertions: each one
 * expects a real TypeScript error on the call beneath it. If any
 * builder is loosened to plain `...args: T[]`, the matching call
 * becomes valid, the directive becomes unused, and TypeScript emits
 * TS2578.
 *
 * Why `and` / `or` are NOT in this block: the construction-time
 * reductions in `reduction.ts` collapse the empty argument list to a
 * sentinel (`and()` → `match-all`, `or()` → `match-none`), so the
 * zero-argument call is now a legitimate API surface — locking it as
 * a compile-time error would conflict with the documented behavior.
 * The remaining variadic builders (`isIn`, `multiSelectAny`,
 * `multiSelectAll`) have no parallel reduction: their value lists are
 * literal-only and the canonical "empty" shape isn't a sentinel, so
 * the empty-list rejection stays at the type layer.
 *
 * Enforcement surface: `npm run typecheck`, wired into lefthook
 * pre-push. The push fails before the change lands. Vitest itself does
 * not type-check sources by default, so the runtime test runner is not
 * the gate here — the type checker is.
 *
 * Calls are guarded behind a `neverRun` branch so the references don't
 * execute at runtime — the directives ARE the assertions, not any
 * runtime behavior. (Pattern borrowed from
 * `lib/mcp/__tests__/createApp.test.ts`.)
 */
function typeCheckVariadicMinOne(): void {
	const neverRun = false;
	if (neverRun) {
		// @ts-expect-error — isIn requires a left term and at least one literal
		void isIn(prop("patient", "status"));
		// `multiSelectAny` / `multiSelectAll` require at least one literal
		// in `values`. The schema's tuple-with-rest shape rejects an empty
		// array at parse time; the variadic-with-required-first signature
		// lifts the rejection to the type layer so the failure surfaces at
		// the call site rather than at runtime.
		// @ts-expect-error — multiSelectAny requires at least one literal
		void multiSelectAny(prop("patient", "tags"));
		// @ts-expect-error — multiSelectAll requires at least one literal
		void multiSelectAll(prop("patient", "tags"));
	}
}
/* Reference the guard so lint doesn't flag it as unused — the
 * directives inside are what the compiler enforces. */
void typeCheckVariadicMinOne;

/* --- Per-kind comparison narrowing lock -------------------------------
 *
 * The `comparison` curried factory's reason for existing is to produce
 * six per-kind narrowed constructors — `eq` returns
 * `ComparisonPredicate<"eq">`, not `ComparisonPredicate<ComparisonKind>`.
 * Without this lock, a regression that widened the factory's return
 * type generic (e.g. annotating the inner function's return as
 * `ComparisonPredicate<ComparisonKind>`) would silently collapse all
 * six exports back to one shape and call-site narrowing would be lost.
 *
 * The form is "assign a value of type `ReturnType<typeof <op>>["kind"]`
 * to a variable typed as the literal kind." If the factory widens, the
 * source type becomes `ComparisonKind` and the narrow target rejects
 * it → TS2322 fires. The mirror direction `<literal> satisfies
 * <return-kind>` does NOT catch this regression: `"eq" satisfies
 * ComparisonKind` is trivially valid because `"eq"` extends
 * `ComparisonKind`. The assignment direction is the asymmetric one,
 * which is what we need.
 *
 * Same `npm run typecheck` enforcement surface as the variadic block
 * above: lefthook pre-push runs it before the push lands.
 */
function typeCheckComparisonNarrowing(): void {
	const neverRun = false;
	if (neverRun) {
		// One assertion per export. If the curried factory regresses,
		// every line below fires; one would suffice but six is explicit
		// about the intended six-way narrowing the factory promises.
		const _eq: "eq" = null as unknown as ReturnType<typeof eq>["kind"];
		const _neq: "neq" = null as unknown as ReturnType<typeof neq>["kind"];
		const _gt: "gt" = null as unknown as ReturnType<typeof gt>["kind"];
		const _gte: "gte" = null as unknown as ReturnType<typeof gte>["kind"];
		const _lt: "lt" = null as unknown as ReturnType<typeof lt>["kind"];
		const _lte: "lte" = null as unknown as ReturnType<typeof lte>["kind"];
		void _eq;
		void _neq;
		void _gt;
		void _gte;
		void _lt;
		void _lte;
	}
}
void typeCheckComparisonNarrowing;

/* --- Reduction-overload narrowing lock --------------------------------
 *
 * `and` / `or` / `not` are declared as overload sets so each call
 * shape's return type is precisely pinned: `and()` returns
 * `match-all`, `and(x)` returns `T` (the inner clause's type),
 * `and(x, y, ...)` returns `Extract<Predicate, { kind: "and" }>`, and
 * the parallel set on `or` / `not`. The narrowing matters because the
 * rest of this file's contract — `and(...).clauses` directly
 * accessible without re-narrowing in the n-ary case, `not(eq(...))
 * .clause` accessible without re-narrowing in the catch-all case —
 * depends on the precise per-overload return shape.
 *
 * The form is "assign the builder result to a variable typed as the
 * expected narrow shape." If a future regression collapses any
 * overload to `Predicate`, the assignment becomes invalid → TS2322
 * fires on the matching line. Same enforcement surface as
 * `typeCheckComparisonNarrowing` above (`npm run typecheck` via
 * lefthook pre-push).
 */
function typeCheckReductionNarrowing(): void {
	const neverRun = false;
	if (neverRun) {
		const x = eq(prop("patient", "status"), literal("open"));
		// `and()` empty → match-all sentinel
		const _emptyAnd: Extract<Predicate, { kind: "match-all" }> = and();
		// `or()` empty → match-none sentinel
		const _emptyOr: Extract<Predicate, { kind: "match-none" }> = or();
		// `and(x)` single → identity (returns x's exact type)
		const _singleAnd: typeof x = and(x);
		// `or(x)` single → identity
		const _singleOr: typeof x = or(x);
		// `and(x, y)` n-ary → precise and-arm
		const _nAnd: Extract<Predicate, { kind: "and" }> = and(x, x);
		// `or(x, y)` n-ary → precise or-arm
		const _nOr: Extract<Predicate, { kind: "or" }> = or(x, x);
		// `not(matchAll())` → match-none
		const _notMA: Extract<Predicate, { kind: "match-none" }> = not(matchAll());
		// `not(matchNone())` → match-all
		const _notMN: Extract<Predicate, { kind: "match-all" }> = not(matchNone());
		// `not(eq(...))` catch-all → precise not-arm. `_notEq.clause` is
		// directly accessible without `if (_notEq.kind === "not")` — the
		// load-bearing assertion the file-level comment in `builders.ts`
		// promises.
		const _notEq: Extract<Predicate, { kind: "not" }> = not(x);
		void _notEq.clause;
		void _emptyAnd;
		void _emptyOr;
		void _singleAnd;
		void _singleOr;
		void _nAnd;
		void _nOr;
		void _notMA;
		void _notMN;
		void _notEq;
	}
}
void typeCheckReductionNarrowing;

/* --- Empty-collection construction-site lock --------------------------
 *
 * `and`, `or`, `isIn`, and `ancestorPath` return shapes whose schema
 * enforces non-emptiness via Zod 4's tuple-with-rest idiom
 * (`z.tuple([T], T)` infers as `[T, ...T[]]`). At construction sites,
 * the tuple shape rejects empty-array literals at compile time —
 * `{ kind: "and", clauses: [] }` is `Predicate[]`-acceptable but not
 * `[Predicate, ...Predicate[]]`-acceptable. The directives below pin
 * that distinction so a regression to `z.array(T).min(1)` surfaces as
 * an unused `@ts-expect-error` (TS2578).
 *
 * Why the schema check still matters when the builders apply
 * reductions: the `and` / `or` builders thread their inputs through
 * the construction-time reductions in `reduction.ts` and never
 * construct an empty-clauses literal. But code that bypasses the
 * builders — directly composing an AST literal, or parsing
 * persisted JSON via `predicateSchema.parse(...)` — must still be
 * rejected for the empty-clauses shape. This block is the
 * compile-time guard for the direct-literal path; the schema's
 * tuple-with-rest is the runtime guard for the parse path. Both
 * stay in place even after the builders started swallowing empty
 * input.
 *
 * Note on scope: this block does NOT lock the indexed-access form
 * `result.clauses[0]`. Without `noUncheckedIndexedAccess` enabled in
 * the project's `tsconfig.json`, both `T[]` and `[T, ...T[]]` index-
 * access to `T` (not `T | undefined`), so an indexed-access assertion
 * would not differentiate between the two schema shapes — it would
 * pass under both. The construction-site form is the only one that
 * actually fires under the project's current strictness configuration.
 */
function typeCheckNonEmptyConstructionSite(): void {
	const neverRun = false;
	if (neverRun) {
		// `@ts-expect-error` suppresses the error on the following
		// line. The TS error lands on the property line carrying the
		// empty literal (the `clauses: []` / `values: []` / `via: []`
		// line), so the directive is placed directly above each.
		const _emptyAnd: Extract<Predicate, { kind: "and" }> = {
			kind: "and",
			// @ts-expect-error — `clauses: []` violates the tuple-with-rest non-empty shape
			clauses: [],
		};
		const _emptyOr: Extract<Predicate, { kind: "or" }> = {
			kind: "or",
			// @ts-expect-error — `clauses: []` violates the tuple-with-rest non-empty shape
			clauses: [],
		};
		const _emptyIn: Extract<Predicate, { kind: "in" }> = {
			kind: "in",
			left: term(literal(0)),
			// @ts-expect-error — `values: []` violates the tuple-with-rest non-empty shape
			values: [],
		};
		const _emptyAncestor: Extract<RelationPath, { kind: "ancestor" }> = {
			kind: "ancestor",
			// @ts-expect-error — `via: []` violates the tuple-with-rest non-empty shape
			via: [],
		};
		const _emptyMultiSelect: Extract<
			Predicate,
			{ kind: "multi-select-contains" }
		> = {
			kind: "multi-select-contains",
			property: { kind: "prop", caseType: "patient", property: "tags" },
			// @ts-expect-error — `values: []` violates the tuple-with-rest non-empty shape
			values: [],
			quantifier: "any",
		};
		void _emptyAnd;
		void _emptyOr;
		void _emptyIn;
		void _emptyAncestor;
		void _emptyMultiSelect;
	}
}
void typeCheckNonEmptyConstructionSite;
// ---------- Auto-wrap (Term → ValueExpression) tests ----------
//
// `toValueExpression` is the auto-wrap helper that lifts a `Term`
// into the structural `term` arm of `ValueExpression` and leaves a
// ValueExpression unchanged. Predicate-operand builders (`eq`,
// `isIn`, `within`, `isNull`, `isBlank`, `between`) route every
// widened operand through this helper so call-sites can pass
// either Term-shaped or ValueExpression-shaped values
// interchangeably. The block below pins the helper's contract: the
// dispatch is purely on the discriminator-value sets (Term kinds
// vs. ValueExpression kinds), and ValueExpression inputs flow
// through unchanged.

describe("toValueExpression — Term → ValueExpression auto-wrap", () => {
	it("wraps a property reference as a term-arm ValueExpression", () => {
		const wrapped = toValueExpression(prop("patient", "age"));
		expect(wrapped.kind).toBe("term");
		if (wrapped.kind === "term") {
			expect(wrapped.term.kind).toBe("prop");
		}
		expect(valueExpressionSchema.parse(wrapped)).toEqual(wrapped);
	});

	it("wraps a search-input reference as a term-arm ValueExpression", () => {
		const wrapped = toValueExpression(input("phone"));
		expect(wrapped.kind).toBe("term");
		if (wrapped.kind === "term") {
			expect(wrapped.term.kind).toBe("input");
		}
	});

	it("wraps a session-user reference as a term-arm ValueExpression", () => {
		const wrapped = toValueExpression(sessionUser("region"));
		expect(wrapped.kind).toBe("term");
	});

	it("wraps a session-context reference as a term-arm ValueExpression", () => {
		const wrapped = toValueExpression(sessionContext("userid"));
		expect(wrapped.kind).toBe("term");
	});

	it("wraps a literal as a term-arm ValueExpression", () => {
		const wrapped = toValueExpression(literal(42));
		expect(wrapped.kind).toBe("term");
		if (wrapped.kind === "term") {
			expect(wrapped.term.kind).toBe("literal");
		}
	});

	it("leaves a ValueExpression unchanged (idempotent on already-lifted values)", () => {
		// The auto-wrap is structural, not deep — a ValueExpression
		// flows through unchanged regardless of its discriminator.
		// Tested for `today` (zero-payload constant), `arith` (binary
		// recursive), and `if` (cross-family recursive) so all three
		// shapes round-trip identity.
		const constants: ValueExpression[] = [
			today(),
			now(),
			arith("+", term(literal(1)), term(literal(2))),
			ifExpr(matchAll(), term(literal("a")), term(literal("b"))),
		];
		for (const c of constants) {
			expect(toValueExpression(c)).toBe(c);
		}
	});
});

describe("predicate-operand auto-wrap (eq / isIn / within / isNull / isBlank / between)", () => {
	// These tests pin that every widened predicate operand accepts
	// both Term and ValueExpression inputs. The Term path goes through
	// the auto-wrap; the ValueExpression path flows through unchanged.
	// Round-trip parsing through `predicateSchema` confirms each shape
	// is well-typed at the AST.

	it("eq accepts Term operands and auto-wraps them", () => {
		const p = eq(prop("patient", "name"), literal("Alice"));
		expect(p.left.kind).toBe("term");
		expect(p.right.kind).toBe("term");
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("eq accepts ValueExpression operands directly (no double-wrap)", () => {
		const p = eq(
			arith("+", term(prop("patient", "age")), term(literal(1))),
			term(literal(19)),
		);
		expect(p.left.kind).toBe("arith");
		// `right` is a `term`-arm because we passed a `term(...)` lift.
		expect(p.right.kind).toBe("term");
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("isIn accepts a Term left + literal candidates", () => {
		const p = isIn(
			prop("patient", "status"),
			literal("open"),
			literal("active"),
		);
		expect(p.left.kind).toBe("term");
		expect(p.values).toHaveLength(2);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("within accepts a ValueExpression center via the typed term-lift", () => {
		// `property` stays `PropertyRef` (no widening); `center`
		// widens to ValueExpression. The Term auto-wrap admits a bare
		// `input(...)` reference, lifting it into the `term` arm.
		const p = within(
			prop("clinic", "location"),
			input("user_location"),
			50,
			"miles",
		);
		expect(p.center.kind).toBe("term");
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("between accepts ValueExpression bounds (lower / upper widened)", () => {
		const p = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
		});
		expect(p.left.kind).toBe("term");
		expect(p.lower?.kind).toBe("term");
		expect(p.upper?.kind).toBe("term");
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("isNull / isBlank accept ValueExpression operands", () => {
		const a = isNull(prop("patient", "status"));
		const b = isBlank(input("phone"));
		expect(a.left.kind).toBe("term");
		expect(b.left.kind).toBe("term");
		expect(predicateSchema.parse(a)).toEqual(a);
		expect(predicateSchema.parse(b)).toEqual(b);
	});
});

// ---------- ValueExpression builder tests ----------
//
// Each ValueExpression operator gets a dedicated builder. The tests
// below pin three things per builder: (1) the discriminator on the
// constructed AST, (2) the structural payload, (3) the round-trip
// parse through `valueExpressionSchema`. The round-trip is the
// load-bearing assertion — same defense the predicate-side builder
// tests use to lock the builder layer against schema drift.

describe("valueExpression builders — leaf arms", () => {
	it("term() lifts a Term as the term arm", () => {
		const v = term(prop("patient", "age"));
		expect(v.kind).toBe("term");
		expect(v.term.kind).toBe("prop");
		expect(valueExpressionSchema.parse(v)).toEqual(v);
	});

	it("today() / now() construct discriminator-only constants", () => {
		expect(today()).toEqual({ kind: "today" });
		expect(now()).toEqual({ kind: "now" });
		expect(valueExpressionSchema.parse(today())).toEqual(today());
		expect(valueExpressionSchema.parse(now())).toEqual(now());
	});
});

describe("valueExpression builders — date / coercion arms", () => {
	it("dateAdd() constructs a date-add expression with all required slots", () => {
		const v = dateAdd(today(), "days", term(literal(7)));
		expect(v.kind).toBe("date-add");
		expect(v.interval).toBe("days");
		expect(valueExpressionSchema.parse(v)).toEqual(v);
	});

	it("dateCoerce / datetimeCoerce / double construct unary value coercions", () => {
		const text = term(prop("patient", "dob_str"));
		const a = dateCoerce(text);
		const b = datetimeCoerce(text);
		const c = double(term(prop("patient", "weight")));
		expect(a.kind).toBe("date-coerce");
		expect(b.kind).toBe("datetime-coerce");
		expect(c.kind).toBe("double");
		expect(valueExpressionSchema.parse(a)).toEqual(a);
		expect(valueExpressionSchema.parse(b)).toEqual(b);
		expect(valueExpressionSchema.parse(c)).toEqual(c);
	});
});

describe("valueExpression builders — arithmetic + text arms", () => {
	it.each([
		"+",
		"-",
		"*",
		"div",
		"mod",
	] as const)("arith(%s) constructs the matching arith expression", (op) => {
		const v = arith(op, term(prop("patient", "age")), term(literal(1)));
		expect(v.kind).toBe("arith");
		expect(v.op).toBe(op);
		expect(valueExpressionSchema.parse(v)).toEqual(v);
	});

	it("concat / coalesce construct variadic-with-required-first lists", () => {
		const c = concat(term(literal("hello, ")), term(prop("patient", "name")));
		const co = coalesce(
			term(prop("patient", "nickname")),
			term(literal("guest")),
		);
		expect(c.kind).toBe("concat");
		expect(c.parts).toHaveLength(2);
		expect(co.kind).toBe("coalesce");
		expect(co.values).toHaveLength(2);
		expect(valueExpressionSchema.parse(c)).toEqual(c);
		expect(valueExpressionSchema.parse(co)).toEqual(co);
	});
});

describe("valueExpression builders — conditional + aggregation arms", () => {
	it("ifExpr() constructs an if expression carrying a Predicate cond", () => {
		const v = ifExpr(
			isBlank(prop("patient", "name")),
			term(literal("(empty)")),
			term(prop("patient", "name")),
		);
		expect(v.kind).toBe("if");
		expect(v.cond.kind).toBe("is-blank");
		expect(valueExpressionSchema.parse(v)).toEqual(v);
	});

	it("switchCase / switchExpr construct a value-driven multi-case selector", () => {
		const v = switchExpr(
			term(prop("patient", "risk")),
			[
				switchCase(literal("very-risky"), term(literal(1))),
				switchCase(literal("risky"), term(literal(2))),
			],
			term(literal(3)),
		);
		expect(v.kind).toBe("switch");
		expect(v.cases).toHaveLength(2);
		expect(valueExpressionSchema.parse(v)).toEqual(v);
	});

	it("count() constructs a relational aggregation with optional where", () => {
		const a = count(subcasePath("parent"));
		const b = count(subcasePath("parent"), matchAll());
		expect(a.kind).toBe("count");
		expect(b.kind).toBe("count");
		expect("where" in a).toBe(false); // absent-not-undefined contract
		expect(b.where).toBeDefined();
		expect(valueExpressionSchema.parse(a)).toEqual(a);
		expect(valueExpressionSchema.parse(b)).toEqual(b);
	});
});

describe("valueExpression builders — unwrap-list + format-date", () => {
	it("unwrapList() constructs a CSQL-style unwrap-list value", () => {
		const v = unwrapList(term(prop("patient", "tags_json")));
		expect(v.kind).toBe("unwrap-list");
		expect(valueExpressionSchema.parse(v)).toEqual(v);
	});

	it("formatDate() constructs a format-date with a preset pattern", () => {
		const v = formatDate(today(), "iso");
		expect(v.kind).toBe("format-date");
		expect(v.pattern).toBe("iso");
		expect(valueExpressionSchema.parse(v)).toEqual(v);
	});

	it("formatDate() accepts an arbitrary custom pattern string", () => {
		const v = formatDate(today(), "%Y/%m/%d");
		expect(v.kind).toBe("format-date");
		expect(valueExpressionSchema.parse(v)).toEqual(v);
	});
});
