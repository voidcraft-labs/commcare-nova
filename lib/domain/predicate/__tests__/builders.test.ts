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
	between,
	dateLiteral,
	datetimeLiteral,
	eq,
	exists,
	gt,
	gte,
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
	or,
	prop,
	relationStep,
	selfPath,
	sessionContext,
	sessionUser,
	subcasePath,
	timeLiteral,
	whenInput,
	within,
} from "../builders";
import {
	MATCH_MODES,
	type Predicate,
	predicateSchema,
	type RelationPath,
	relationPathSchema,
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

	it("accepts a single-clause and / or / isIn (tuple-with-rest boundary)", () => {
		const single = eq(prop("patient", "status"), literal("open"));
		const a = and(single);
		const o = or(single);
		const i = isIn(prop("patient", "status"), literal("open"));
		expect(predicateSchema.parse(a)).toEqual(a);
		expect(predicateSchema.parse(o)).toEqual(o);
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
		const p = isNull(prop("patient", "status"));
		expect(p.kind).toBe("is-null");
		expect(p.left.kind).toBe("prop");
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
		// Parallel to `isNull` — same `left: Term` slot, same
		// per-Term-variant acceptance, different wire-emission rule
		// (portable absent-OR-empty rather than strict-absent). The
		// builder pins the discriminator and the round-trip parse
		// through `predicateSchema` locks the builder against schema
		// drift on the new arm.
		const p = isBlank(prop("patient", "status"));
		expect(p.kind).toBe("is-blank");
		expect(p.left.kind).toBe("prop");
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

/* --- Type-level tests -------------------------------------------------
 *
 * Compile-time regression lock for the variadic-with-required-first
 * contract on `and`, `or`, and `isIn`. The `@ts-expect-error`
 * directives below are the assertions: each one expects a real
 * TypeScript error on the call beneath it. If any builder is loosened
 * to plain `...args: T[]`, the matching call becomes valid, the
 * directive becomes unused, and TypeScript emits TS2578.
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
		// @ts-expect-error — and() with no arguments must not type-check
		void and();
		// @ts-expect-error — or() with no arguments must not type-check
		void or();
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
			left: { kind: "literal", value: 0 },
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
