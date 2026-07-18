// lib/case-store/sql/__tests__/compileTerm.test.ts
//
// Compile-only acceptance tests for the Term compiler.
//
// Tests build a "cold" Kysely instance backed by `DummyDriver` +
// `Postgres*` adapters, wrap each compiled `Term` expression in a
// `select(... .as("v"))`, and call `.compile()` on the resulting
// query. Assertions inspect the emitted SQL string and parameter
// list rather than exact whitespace, since identifier quoting and
// parameter-placeholder layout are dialect-emitter details that are
// not the contract this test guards.
//
// The contract this test guards:
//
//   1. Each `Term` discriminator arm (`prop`, `input`,
//      `session-user`, `session-context`, `literal`) emits the
//      structurally correct Kysely expression — typed JSONB read
//      for property references, parameter-bound runtime bindings
//      for the three runtime-binding arms, and parameter-bound
//      literals for the `literal` arm.
//   2. Each `data_type` from the blueprint enum
//      (`casePropertyDataTypes` in `lib/domain/blueprint.ts`) maps
//      to the documented Postgres cast token. `multi_select` reads
//      via `->` (returns JSONB) instead of `->>` (returns text)
//      because the predicate compiler's `multi-select-contains`
//      operators (`?|` / `?&` / `@>`) require JSONB on the
//      left-hand side.
//   3. Names in `RESERVED_SCALAR_COLUMN_BY_PROPERTY` (from
//      `dataTypeTokens.ts`) read from their MAPPED scalar columns,
//      not from the JSONB `properties` document.
//   4. Property reads with non-self `via` route through the
//      relation-path leaf alias, leaving the actual join to the
//      caller (the term compiler returns the column-read
//      expression; the wider compiler — predicate or expression —
//      drives the join).
//   5. Runtime bindings for `input` / `session-user` /
//      `session-context` resolve from the `bindings` map and
//      throw a clear error when a referenced binding is missing.
//   6. Tenant scope (`appId` / `ownerId`) is exposed on the context
//      surface but not consumed by the term compiler itself —
//      tenant filtering is the caller's concern (the predicate /
//      expression compilers thread the filter onto their outer
//      query).
//
// Tests use the AST builders from `lib/domain/predicate/builders.ts`
// to construct terms — the one supported construction surface, and
// using it ensures the schema's invariants (kind discriminator,
// optional `via` shape, etc.) are enforced at parse time rather
// than at compile time.

import {
	type CompiledQuery,
	DummyDriver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from "kysely";
import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	dateLiteral,
	datetimeLiteral,
	input,
	literal,
	prop,
	relationStep,
	selfPath,
	sessionContext,
	sessionUser,
	timeLiteral,
} from "@/lib/domain/predicate/builders";
import { RELATION_PATH_LEAF_ALIAS } from "../compileRelationPath";
import { compileTerm, type TermCompileContext } from "../compileTerm";
import type { Database } from "../database";

// ---------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------

const db = new Kysely<Database>({
	dialect: {
		createAdapter: () => new PostgresAdapter(),
		createDriver: () => new DummyDriver(),
		createIntrospector: (instance) => new PostgresIntrospector(instance),
		createQueryCompiler: () => new PostgresQueryCompiler(),
	},
});

const APP_ID = "app-uuid";
const OWNER_ID = "owner-uuid";

// `patient` case-type schema covering every `data_type` variant
// from the blueprint enum. Each test that needs a different schema
// shape constructs its own; this default is the broad compatibility
// shape every cast test reads from.
//
// `parent_type: "household"` lets `ancestorPath(relationStep("parent",
// "household"))` walks resolve to the `household` schema below — the
// type checker's destination-resolution logic (mirrored in the term
// compiler's `resolveDestinationCaseType`) reads the parent chain
// from `CaseType.parent_type`.
const PATIENT_SCHEMA: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "nickname", label: "Nickname", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "bmi", label: "BMI", data_type: "decimal" },
		{ name: "dob", label: "DOB", data_type: "date" },
		{ name: "appointment_at", label: "When", data_type: "time" },
		{ name: "registered_at", label: "When", data_type: "datetime" },
		{ name: "color", label: "Color", data_type: "single_select" },
		{ name: "tags", label: "Tags", data_type: "multi_select" },
		{ name: "loc", label: "Location", data_type: "geopoint" },
		// Property without an explicit data_type — defaults to text.
		{ name: "untyped", label: "Untyped" },
	],
};

// `household` schema for the relation-path test (multi-case-type
// scope). The household carries one int property to verify the
// joined-leaf read picks up the property's declared type.
const HOUSEHOLD_SCHEMA: CaseType = {
	name: "household",
	properties: [{ name: "size", label: "Size", data_type: "int" }],
};

const CASE_TYPE_SCHEMAS = new Map<string, CaseType>([
	["patient", PATIENT_SCHEMA],
	["household", HOUSEHOLD_SCHEMA],
]);

// Build a context that resolves `prop` against the patient schema
// (the default). Tests that need a different anchor or different
// bindings spread over the result.
function makeCtx(
	overrides: Partial<TermCompileContext> = {},
): TermCompileContext {
	return {
		db,
		appId: APP_ID,
		projectId: OWNER_ID,
		anchorAlias: "c",
		caseTypeSchemas: CASE_TYPE_SCHEMAS,
		bindings: {},
		...overrides,
	};
}

// Compile shorthand. Each test wraps its term expression in a
// minimal SELECT so Kysely renders the surrounding SQL consistently.
function compileTerm_(expr: ReturnType<typeof compileTerm>): CompiledQuery {
	return db.selectFrom("cases as c").select(expr.as("v")).compile();
}

// ---------------------------------------------------------------
// `prop` — self via — every data_type → cast
// ---------------------------------------------------------------
//
// The cast mapping pinned here is the contract the predicate /
// expression compilers read at the boundary. Each variant pins:
//   - the JSONB read shape (`(c.properties ->> 'X')::cast` for
//     scalar types, `(c.properties -> 'X')::jsonb` for multi_select)
//   - the cast token
//   - parameter binding for the property name (the name flows as a
//     value, not an identifier — Postgres's `->>` operator takes a
//     text expression for the key, and Kysely's `${value}` template
//     substitution binds it as a parameter)

describe("compileTerm — prop (self via) cast mapping", () => {
	const cases = [
		{ name: "text", property: "nickname", cast: "text", arrow: "->>" },
		{ name: "int", property: "age", cast: "integer", arrow: "->>" },
		{ name: "decimal", property: "bmi", cast: "numeric", arrow: "->>" },
		{ name: "date", property: "dob", cast: "date", arrow: "->>" },
		{ name: "time", property: "appointment_at", cast: "time", arrow: "->>" },
		{
			name: "datetime",
			property: "registered_at",
			cast: "timestamptz",
			arrow: "->>",
		},
		{
			name: "single_select",
			property: "color",
			cast: "text",
			arrow: "->>",
		},
		{ name: "multi_select", property: "tags", cast: "jsonb", arrow: "->" },
		{ name: "geopoint", property: "loc", cast: "text", arrow: "->>" },
		{
			name: "undefined data_type",
			property: "untyped",
			cast: "text",
			arrow: "->>",
		},
	] as const;

	for (const { name, property, cast, arrow } of cases) {
		it(`emits ${arrow} + cast as ${cast} for a ${name} property`, () => {
			const compiled = compileTerm_(
				compileTerm(prop("patient", property), makeCtx()),
			);
			// JSONB read shape — `c.properties` is the anchor read,
			// `arrow` is the operator, and the property name inlines as a
			// quoted JSON key. Kysely 0.29's `ref(col, op).key(name)`
			// serializes the key literally (`properties->>'nickname'`),
			// matching the inlined key in the expression-index DDL. Kysely's
			// typed `eb.cast<T>(expr, type)` emits the SQL-standard
			// `cast(<expr> as <type>)` shape rather than the
			// Postgres-specific `(<expr>)::<type>` shorthand; both
			// are semantically identical at the engine layer
			// (verified by harness round-trips).
			expect(compiled.sql).toContain(`"c"."properties"${arrow}'${property}'`);
			expect(compiled.sql).toContain(`as ${cast})`);
		});
	}
});

// ---------------------------------------------------------------
// `prop` — reserved scalar columns
// ---------------------------------------------------------------
//
// CommCare's standard case-metadata names resolve onto first-class
// `cases` columns (`RESERVED_SCALAR_COLUMN_BY_PROPERTY`). The Term
// compiler reads them via `eb.ref(...)` on the MAPPED column rather
// than through the JSONB document — the values live in the columns,
// and reading through `properties` would return `NULL`.
//
// Truly internal columns (`closed_on` / `parent_case_id`) are NOT
// routed through `prop` at the term layer — plumbing columns with
// no authoring-vocabulary name.

describe("compileTerm — prop (self via) reserved scalar columns", () => {
	const reserved: ReadonlyArray<readonly [property: string, column: string]> = [
		["case_id", "case_id"],
		["case_type", "case_type"],
		["owner_id", "owner_id"],
		["status", "status"],
		["case_name", "case_name"],
		["name", "case_name"],
		["external_id", "external_id"],
		["external-id", "external_id"],
		["date_opened", "opened_on"],
		["date-opened", "opened_on"],
		["last_modified", "modified_on"],
	];

	for (const [property, column] of reserved) {
		it(`reads ${property} from the ${column} scalar column, not from JSONB`, () => {
			const compiled = compileTerm_(
				compileTerm(prop("patient", property), makeCtx()),
			);
			// Anchor's scalar column reference: `"c"."<column>"`.
			expect(compiled.sql).toContain(`"c"."${column}"`);
			// JSONB document is NOT consulted for reserved columns.
			expect(compiled.sql).not.toContain(`'${property}'`);
			expect(compiled.sql).not.toContain('"properties" ->>');
		});
	}

	it("shadows a blueprint-declared property with the same name", () => {
		// The blueprint validator owns rejecting reserved-column
		// names as case-property identifiers (CommCare's wire
		// layer reserves them too). The term compiler trusts that
		// rejection upstream and routes uniformly. This test pins
		// the documented shadowing behavior so a regression that
		// introduced JSONB routing for reserved-name properties
		// would surface here, not at runtime.
		const shadowSchema: CaseType = {
			name: "shadow_test",
			properties: [
				// Property literally named `status` — the SQL
				// reads from `c.status`, not from the JSONB document.
				{ name: "status", label: "Status", data_type: "text" },
			],
		};
		const ctx = makeCtx({
			caseTypeSchemas: new Map([["shadow_test", shadowSchema]]),
		});
		const compiled = compileTerm_(
			compileTerm(prop("shadow_test", "status"), ctx),
		);
		expect(compiled.sql).toContain('"c"."status"');
		expect(compiled.sql).not.toContain('"properties" ->>');
	});
});

// ---------------------------------------------------------------
// `prop` — non-self via reads as correlated scalar subqueries
// ---------------------------------------------------------------
//
// A `prop` term carrying a non-self `via` compiles to a correlated
// scalar subquery: `(SELECT (<leaf>.properties ->> '<key>')::cast
// FROM (<relation-path-leaf>) AS <leafAlias> WHERE
// <leafAlias>.anchor_case_id = <ctx.anchorAlias>.case_id LIMIT 1)`.
// The scalar shape lets the term compiler return a value-bearing
// expression for any operand slot the wider compiler exposes —
// comparison sides, arithmetic operands, concat parts, etc.
//
// The leaf alias is the depth-aware identifier
// `compileRelationPath` emits; at depth 0 it is the bare
// `RELATION_PATH_LEAF_ALIAS` constant.

describe("compileTerm — prop (non-self via)", () => {
	it("emits a correlated scalar subquery for a single-hop ancestor walk", () => {
		const compiled = compileTerm_(
			compileTerm(
				prop(
					"patient",
					"size",
					ancestorPath(relationStep("parent", "household")),
				),
				makeCtx(),
			),
		);
		// Read goes through the leaf alias's `properties` column,
		// not the anchor's. Cast is `integer` because `size` on the
		// `household` schema is declared `int`.
		expect(compiled.sql).toContain(
			`"${RELATION_PATH_LEAF_ALIAS}"."properties"->>'size'`,
		);
		expect(compiled.sql).toContain("as integer)");
		// The term compiler emits the relation-path leaf as part of
		// the scalar subquery — the `inner join` between
		// `case_indices` and `cases` lives inside the subquery body.
		expect(compiled.sql).toMatch(/\binner join\b/i);
		// `LIMIT 1` keeps the result scalar so the subquery
		// composes in any value-bearing operand slot. Kysely's
		// typed `.limit(1)` binds the limit value as a parameter
		// (`limit $N`), so inspect the SQL keyword and the
		// parameter list separately.
		expect(compiled.sql.toLowerCase()).toContain("limit");
		expect(compiled.parameters).toContain(1);
		// The correlation reads back to the anchor alias's
		// `case_id`.
		expect(compiled.sql).toContain('"c"."case_id"');
	});

	it("reads reserved scalar columns through the leaf alias", () => {
		// Reserved-column rule applies to relation-walk reads too —
		// the scalar columns on the leaf row read via `eb.ref`
		// against the leaf alias inside the scalar subquery body.
		const compiled = compileTerm_(
			compileTerm(
				prop(
					"patient",
					"case_id",
					ancestorPath(relationStep("parent", "household")),
				),
				makeCtx(),
			),
		);
		expect(compiled.sql).toContain(`"${RELATION_PATH_LEAF_ALIAS}"."case_id"`);
	});

	it("falls through to self-via behavior when the via path is `selfPath`", () => {
		// Explicit `selfPath()` is semantically equivalent to no
		// `via`. The compiler must accept both shapes and emit the
		// same anchor read.
		const compiled = compileTerm_(
			compileTerm(prop("patient", "nickname", selfPath()), makeCtx()),
		);
		expect(compiled.sql).toContain(`"c"."properties"->>'nickname'`);
		expect(compiled.sql).toContain("as text)");
		// Self-via reads emit no scalar subquery — the read is a
		// direct JSONB extraction off the anchor's `cases` row.
		expect(compiled.sql).not.toMatch(/\binner join\b/i);
		expect(compiled.sql).not.toContain("limit 1");
	});
});

// ---------------------------------------------------------------
// `prop` — schema lookup errors
// ---------------------------------------------------------------
//
// Every property the term compiler reads must exist in the
// case-type schema. A missing schema or a property absent from the
// schema is a bug at the type-checker layer that should never
// reach the SQL compiler — the term compiler throws a clear error
// rather than emit ambiguous SQL.

describe("compileTerm — prop schema-lookup errors", () => {
	it("throws when the case type is absent from the schema map", () => {
		expect(() =>
			compileTerm(prop("missing-case-type", "nickname"), makeCtx()),
		).toThrow(/case type/i);
	});

	it("throws when the property is absent from the case type's schema", () => {
		expect(() =>
			compileTerm(prop("patient", "ghost-property"), makeCtx()),
		).toThrow(/property/i);
	});
});

// ---------------------------------------------------------------
// `literal` — every AST literal type
// ---------------------------------------------------------------
//
// Literals bind via Kysely's parameter channel rather than inline.
// Inlining is unsafe (no escaping) and shifts plan-cache invariants
// off-spec; parameter binding is the canonical pattern. The
// compiler also emits a typed cast when the literal carries a
// declared `data_type` so type-aware comparisons compose with their
// counterpart `prop` reads.

describe("compileTerm — literal", () => {
	it("binds a string literal as a parameter", () => {
		const compiled = compileTerm_(compileTerm(literal("Alice"), makeCtx()));
		expect(compiled.parameters).toContain("Alice");
	});

	it("binds a number literal as a parameter", () => {
		const compiled = compileTerm_(compileTerm(literal(42), makeCtx()));
		expect(compiled.parameters).toContain(42);
	});

	it("binds a boolean literal as a parameter", () => {
		const compiled = compileTerm_(compileTerm(literal(true), makeCtx()));
		expect(compiled.parameters).toContain(true);
	});

	it("compiles a null literal as SQL null (no parameter)", () => {
		// SQL `NULL` is a keyword, not a value — Kysely's `eb.lit(null)`
		// emits the literal token. Binding `null` as a parameter would
		// inflate the parameter list without any expressivity gain.
		const compiled = compileTerm_(compileTerm(literal(null), makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("null");
		expect(compiled.parameters).not.toContain(null);
	});

	it("emits a date cast for a date-typed literal", () => {
		const compiled = compileTerm_(
			compileTerm(dateLiteral("2026-01-01"), makeCtx()),
		);
		expect(compiled.sql).toContain("as date)");
		expect(compiled.parameters).toContain("2026-01-01");
	});

	it("emits a timestamptz cast for a datetime-typed literal", () => {
		const compiled = compileTerm_(
			compileTerm(datetimeLiteral("2026-01-01T12:00:00Z"), makeCtx()),
		);
		expect(compiled.sql).toContain("as timestamptz)");
		expect(compiled.parameters).toContain("2026-01-01T12:00:00Z");
	});

	it("emits a time cast for a time-typed literal", () => {
		const compiled = compileTerm_(compileTerm(timeLiteral("09:00"), makeCtx()));
		expect(compiled.sql).toContain("as time)");
		expect(compiled.parameters).toContain("09:00");
	});

	it.each([
		["date", dateLiteral(""), "as date)"],
		["datetime", datetimeLiteral(""), "as timestamptz)"],
		["time", timeLiteral(""), "as time)"],
	] as const)("turns an unset %s literal into typed null instead of casting an empty string", (_label, value, castToken) => {
		const compiled = compileTerm_(compileTerm(value, makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("nullif(");
		expect(compiled.sql).toContain(castToken);
		expect(compiled.parameters).toContain("");
	});
});

// ---------------------------------------------------------------
// Runtime-binding arms
// ---------------------------------------------------------------

describe("compileTerm — input (search-input ref)", () => {
	it("resolves from the searchInputs binding map", () => {
		const compiled = compileTerm_(
			compileTerm(
				input("region_filter"),
				makeCtx({
					bindings: { searchInputs: new Map([["region_filter", "north"]]) },
				}),
			),
		);
		expect(compiled.parameters).toContain("north");
	});

	it("throws a clear error when the binding is missing", () => {
		// Search-input refs are runtime-required; a compile-time
		// miss is a misuse — the wider compiler must thread the
		// runtime values through `bindings` before calling the
		// term compiler.
		expect(() => compileTerm(input("missing"), makeCtx())).toThrow(/missing/i);
	});
});

describe("compileTerm — session-user", () => {
	it("resolves from the sessionUser binding map", () => {
		const compiled = compileTerm_(
			compileTerm(
				sessionUser("commcare_location_id"),
				makeCtx({
					bindings: {
						sessionUser: new Map([["commcare_location_id", "loc-123"]]),
					},
				}),
			),
		);
		expect(compiled.parameters).toContain("loc-123");
	});

	it("throws when the field is absent from the bindings map", () => {
		expect(() => compileTerm(sessionUser("missing_field"), makeCtx())).toThrow(
			/missing_field/i,
		);
	});

	it("uses an explicit device-compatible fallback for an unknown user field", () => {
		const compiled = compileTerm_(
			compileTerm(
				sessionUser("region"),
				makeCtx({
					bindings: {
						sessionUser: new Map(),
						sessionUserFallback: "",
					},
				}),
			),
		);
		expect(compiled.parameters).toContain("");
	});
});

describe("compileTerm — session-context", () => {
	it("resolves a userid binding from the sessionContext map", () => {
		const compiled = compileTerm_(
			compileTerm(
				sessionContext("userid"),
				makeCtx({
					bindings: { sessionContext: new Map([["userid", "user-42"]]) },
				}),
			),
		);
		expect(compiled.parameters).toContain("user-42");
	});

	it("throws when the userid is absent from the bindings map", () => {
		expect(() => compileTerm(sessionContext("userid"), makeCtx())).toThrow(
			/userid/i,
		);
	});
});

// ---------------------------------------------------------------
// Tenant scope is NOT consumed by the term compiler
// ---------------------------------------------------------------
//
// The `appId` / `ownerId` fields are part of the context surface
// so callers thread one consistent context across every layer of
// the compiler stack (term, predicate, expression, relation-path).
// The term compiler itself does not emit a tenant filter — tenant
// filtering belongs at the layer that emits the outer query's
// `cases` read. This positive assertion of the design choice
// pins the contract against a regression that silently weaves the
// filter into every term-read site.

describe("compileTerm — tenant scope contract", () => {
	it("does not emit appId or ownerId parameters from a self-via term", () => {
		const compiled = compileTerm_(
			compileTerm(prop("patient", "nickname"), makeCtx()),
		);
		// The tenant scope is on the context surface but the
		// compiler doesn't read it for self-via property reads.
		expect(compiled.parameters).not.toContain(APP_ID);
		expect(compiled.parameters).not.toContain(OWNER_ID);
	});

	it("does not emit appId or ownerId parameters from a literal term", () => {
		const compiled = compileTerm_(compileTerm(literal("Alice"), makeCtx()));
		expect(compiled.parameters).not.toContain(APP_ID);
		expect(compiled.parameters).not.toContain(OWNER_ID);
	});
});

// ---------------------------------------------------------------
// Anchor alias contract
// ---------------------------------------------------------------
//
// The anchor alias is the alias the caller's outer query uses for
// the `cases` table. The term compiler reads through that alias
// rather than baking `c` everywhere, so callers nested inside a
// subquery (e.g. an `exists` arm) can anchor against a different
// alias without rewriting the term-level read.

describe("compileTerm — anchor alias contract", () => {
	it("honors a custom anchor alias for self-via property reads", () => {
		const compiled = db
			.selectFrom("cases as outer_case")
			.select(
				compileTerm(
					prop("patient", "nickname"),
					makeCtx({ anchorAlias: "outer_case" }),
				).as("v"),
			)
			.compile();
		expect(compiled.sql).toContain(`"outer_case"."properties"->>'nickname'`);
	});

	it("honors a custom anchor alias for reserved scalar reads", () => {
		const compiled = db
			.selectFrom("cases as outer_case")
			.select(
				compileTerm(
					prop("patient", "case_id"),
					makeCtx({ anchorAlias: "outer_case" }),
				).as("v"),
			)
			.compile();
		expect(compiled.sql).toContain('"outer_case"."case_id"');
	});
});
