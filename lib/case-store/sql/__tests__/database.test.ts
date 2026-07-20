// lib/case-store/sql/__tests__/database.test.ts
//
// Compile-only acceptance tests for the Kysely Database interface.
//
// These tests are TYPE-level + COMPILE-level guards. They build a
// `Kysely<Database>` instance backed by Kysely's `DummyDriver` and
// the `Postgres*` dialect adapters, then construct representative
// typed queries against each table and call `.compile()`. The
// resulting `CompiledQuery.sql` is asserted on shape (table /
// column identifiers and the structural shape of the query) rather
// than exact punctuation, because identifier quoting and parameter
// placeholder formatting are dialect-emitter details that aren't
// the contract this test guards. The contract this test guards is:
//
//   1. Every column on the four base tables (`cases`, `case_indices`,
//      `case_type_schemas`, `cases_quarantine`) declared in the
//      migration modules under `lib/case-store/migrations/` is
//      reachable from a typed Kysely query.
//   2. The Postgres dialect adapter compiles those queries into
//      well-formed SQL with parameters captured as a positional
//      array — the same shape every Term/Predicate/Expression
//      compiler will rely on when it lands on top of this type.
//   3. JSONB column reads ((properties->>'key')::cast) and JSON
//      key-existence checks (?, ?|, ?&) round-trip through the
//      type system without escape hatches.
//
// A type-level assertion on column types (the `Selectable<...>` /
// `Insertable<...>` shapes) is also pinned per table — this is
// what catches a typo in `database.ts` that would otherwise show
// up only when the compilers integrate.
//
// The migration modules under `lib/case-store/migrations/` are the
// authority on column names, types, and nullability; this file's type
// contract mirrors them.

import {
	type CompiledQuery,
	DummyDriver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
	type Selectable,
	sql,
} from "kysely";
import { describe, expect, it } from "vitest";
import type {
	CaseIndicesTable,
	CasesTable,
	CaseTypeSchemasTable,
	Database,
	ParkedCaseValuesTable,
} from "../database";

// -- Shared fixture --------------------------------------------------
//
// A "cold" Kysely instance — no driver behind it, so executing a
// query throws, but `.compile()` produces real Postgres SQL. This
// is the canonical test pattern for compile-only Kysely tests
// (Kysely docs: recipes/0004-splitting-query-building-and-execution).

const db = new Kysely<Database>({
	dialect: {
		createAdapter: () => new PostgresAdapter(),
		createDriver: () => new DummyDriver(),
		createIntrospector: (instance) => new PostgresIntrospector(instance),
		createQueryCompiler: () => new PostgresQueryCompiler(),
	},
});

// Compile shorthand — every test calls `.compile()` on a Kysely
// query expression node, so wrap the access for readability.
function compile(query: { compile: () => CompiledQuery }): CompiledQuery {
	return query.compile();
}

// -- `cases` table --------------------------------------------------

describe("Database.cases", () => {
	it("compiles a tenant-scoped select with the (app_id, owner_id) isolation pair", () => {
		// The structural tenancy contract: every read filters by
		// `(app_id, owner_id)` — the isolation key on the `cases`
		// table.
		const compiled = compile(
			db
				.selectFrom("cases")
				.select([
					"case_id",
					"app_id",
					"case_type",
					"owner_id",
					"status",
					"opened_on",
					"modified_on",
					"closed_on",
					"parent_case_id",
					"properties",
				])
				.where("app_id", "=", "app-uuid")
				.where("owner_id", "=", "owner-uuid")
				.where("case_type", "=", "patient"),
		);

		expect(compiled.sql).toContain('from "cases"');
		expect(compiled.sql).toContain('"app_id"');
		expect(compiled.sql).toContain('"owner_id"');
		expect(compiled.sql).toContain('"case_type"');
		expect(compiled.parameters).toEqual(["app-uuid", "owner-uuid", "patient"]);
	});

	it("compiles a JSONB property read with ->> and a typed cast", () => {
		// The Term compiler emits this exact shape for a property
		// reference of an int property. Pinning the SQL fragment
		// here means a regression in the column type that breaks
		// raw-SQL composition surfaces immediately.
		const compiled = compile(
			db
				.selectFrom("cases")
				.select([
					"case_id",
					sql<number>`(${sql.ref("properties")} ->> 'age')::int`.as("age"),
				])
				.where("app_id", "=", "app-uuid"),
		);

		expect(compiled.sql).toContain('from "cases"');
		expect(compiled.sql).toContain(`"properties" ->> 'age'`);
		expect(compiled.sql).toContain("::int");
	});

	it("compiles a JSONB top-level-key existence check (`?`)", () => {
		// Postgres-strict null semantics live in the SQL layer:
		// `properties ? 'key'` matches "key present in the JSONB
		// document," distinguishing absent from present-with-null.
		// The Predicate compiler's `is-null` arm emits this.
		const compiled = compile(
			db
				.selectFrom("cases")
				.select(["case_id"])
				.where(sql<boolean>`${sql.ref("properties")} ? 'name'`),
		);

		expect(compiled.sql).toContain(`"properties" ? 'name'`);
	});

	it("compiles an open-cases query (closed_on IS NULL)", () => {
		// Domain idiom: an open case has a null `closed_on`. Every
		// case-list read filters this way unless the user explicitly
		// opts into closed cases. `closed_on` is nullable on `cases`
		// — closed cases retain a close timestamp, open cases hold
		// null.
		const compiled = compile(
			db
				.selectFrom("cases")
				.select(["case_id"])
				.where("app_id", "=", "app-uuid")
				.where("closed_on", "is", null),
		);

		expect(compiled.sql).toContain('"closed_on" is null');
		expect(compiled.parameters).toEqual(["app-uuid"]);
	});

	it("compiles an insert that includes the JSONB properties payload", () => {
		// Insert-side shape: the Selectable/Insertable wrappers
		// give us the right type for `properties` (a JSON object
		// stringified by the dialect). A type error here means the
		// `JSONColumnType<...>` wrapper drifted.
		const compiled = compile(
			db.insertInto("cases").values({
				case_id: "case-uuid",
				app_id: "app-uuid",
				case_type: "patient",
				project_id: "project-uuid",
				owner_id: "owner-uuid",
				status: "open",
				opened_on: new Date("2026-05-02T00:00:00Z"),
				modified_on: new Date("2026-05-02T00:00:00Z"),
				closed_on: null,
				case_name: "Alice",
				parent_case_id: null,
				properties: JSON.stringify({ age: 30 }),
			}),
		);

		expect(compiled.sql).toContain('insert into "cases"');
		expect(compiled.sql).toContain('"properties"');
		// 12 columns, 12 placeholders. `case_name` is a top-level scalar
		// column alongside the reserved-scalar columns, and `project_id`
		// is the tenant key; see `lib/case-store/sql/database.ts` for the
		// full per-column rationale.
		expect(compiled.parameters).toHaveLength(12);
	});

	it("exposes the schema column shape via Selectable<CasesTable>", () => {
		// Type-level assertion: `Selectable<CasesTable>` matches
		// the schema column-by-column. The `_typecheck` value is
		// never read at runtime; the assignment failing TypeScript
		// compilation is the test.
		type SelectedRow = Selectable<CasesTable>;
		const _typecheck: SelectedRow = {
			case_id: "case-uuid",
			app_id: "app-uuid",
			case_type: "patient",
			project_id: "project-uuid",
			owner_id: "owner-uuid",
			status: "open",
			opened_on: new Date(),
			modified_on: new Date(),
			closed_on: null,
			case_name: "Alice",
			external_id: null,
			parent_case_id: null,
			properties: { name: "Alice" },
		};
		expect(_typecheck.case_id).toBe("case-uuid");
	});
});

// -- `case_type_schemas` table --------------------------------------

describe("Database.case_type_schemas", () => {
	it("compiles a (app_id, case_type) lookup against the JSON Schema row", () => {
		// The blueprint-write pipeline upserts one row per
		// `(app_id, case_type)`. This test pins the lookup shape
		// the case-store uses to fetch the schema for write-time
		// validation.
		const compiled = compile(
			db
				.selectFrom("case_type_schemas")
				.select(["app_id", "case_type", "schema"])
				.where("app_id", "=", "app-uuid")
				.where("case_type", "=", "patient"),
		);

		expect(compiled.sql).toContain('from "case_type_schemas"');
		expect(compiled.sql).toContain('"app_id"');
		expect(compiled.sql).toContain('"case_type"');
		expect(compiled.parameters).toEqual(["app-uuid", "patient"]);
	});

	it("compiles an upsert (insert ... on conflict) on the composite PK", () => {
		// `applySchemaChange` upserts the JSON Schema for
		// `(app_id, case_type)`. The composite primary key
		// `(app_id, case_type)` is the conflict target.
		const compiled = compile(
			db
				.insertInto("case_type_schemas")
				.values({
					app_id: "app-uuid",
					case_type: "patient",
					schema: JSON.stringify({
						type: "object",
						properties: { age: { type: "integer" } },
					}),
				})
				.onConflict((oc) =>
					oc
						.columns(["app_id", "case_type"])
						.doUpdateSet({ schema: (eb) => eb.ref("excluded.schema") }),
				),
		);

		expect(compiled.sql).toContain('insert into "case_type_schemas"');
		expect(compiled.sql).toContain("on conflict");
		expect(compiled.sql).toContain('"app_id"');
		expect(compiled.sql).toContain('"case_type"');
	});

	it("exposes the schema column shape via Selectable<CaseTypeSchemasTable>", () => {
		type SelectedRow = Selectable<CaseTypeSchemasTable>;
		const _typecheck: SelectedRow = {
			app_id: "app-uuid",
			case_type: "patient",
			schema: { type: "object", properties: { age: { type: "integer" } } },
			// `synced_seq` reads as a string (the column is bigint, which
			// node-postgres returns as a string; a reader coerces with `Number(...)`).
			synced_seq: "0",
		};
		expect(_typecheck.case_type).toBe("patient");
	});
});

// -- `case_indices` table -------------------------------------------

describe("Database.case_indices", () => {
	it("compiles a one-hop ancestor join from cases to case_indices", () => {
		// The simplest relational read: a child case wants its
		// parent. The join key is `case_id` — `case_indices` keys
		// on the composite PK `(case_id, ancestor_id, identifier)`,
		// and the leading column is what the join targets.
		const compiled = compile(
			db
				.selectFrom("cases")
				.innerJoin("case_indices", "case_indices.case_id", "cases.case_id")
				.select([
					"cases.case_id",
					"case_indices.ancestor_id",
					"case_indices.identifier",
					"case_indices.relationship",
					"case_indices.depth",
				])
				.where("cases.app_id", "=", "app-uuid")
				.where("case_indices.identifier", "=", "parent"),
		);

		expect(compiled.sql).toContain('from "cases"');
		expect(compiled.sql).toContain('inner join "case_indices"');
		expect(compiled.sql).toContain('"identifier"');
		expect(compiled.sql).toContain('"depth"');
		expect(compiled.parameters).toEqual(["app-uuid", "parent"]);
	});

	it("compiles a depth-1 direct-edge insert", () => {
		// The materialization policy stores direct edges only
		// (`depth = 1`); transitive walks compose at read time as a
		// chain of `(case_indices, cases)` joins, one per AST step.
		const compiled = compile(
			db.insertInto("case_indices").values({
				case_id: "child-uuid",
				ancestor_id: "parent-uuid",
				identifier: "parent",
				relationship: "child",
				depth: 1,
			}),
		);

		expect(compiled.sql).toContain('insert into "case_indices"');
		expect(compiled.parameters).toEqual([
			"child-uuid",
			"parent-uuid",
			"parent",
			"child",
			1,
		]);
	});

	it("constrains relationship to 'child' | 'extension'", () => {
		// Type-level assertion: only the two literal values are
		// valid. Anything else must be a TypeScript error. The
		// narrowed literal-union type catches a stray "ancestor"
		// / "host" string slipping in via app code. The valid-arm
		// half is exercised at runtime; the invalid-arm half is
		// exercised at typecheck time via the expect-error directive
		// on the line below — its contract is "if this line stops
		// failing typecheck, tsc errors out on an unused directive,"
		// which is the actual signal we want.
		type Row = Selectable<CaseIndicesTable>;
		const child: Row["relationship"] = "child";
		const extension: Row["relationship"] = "extension";
		expect([child, extension]).toEqual(["child", "extension"]);
		// @ts-expect-error — only "child" and "extension" are valid.
		const _invalid: Row["relationship"] = "host";
		void _invalid;
	});

	it("exposes the schema column shape via Selectable<CaseIndicesTable>", () => {
		type SelectedRow = Selectable<CaseIndicesTable>;
		const _typecheck: SelectedRow = {
			case_id: "child-uuid",
			ancestor_id: "parent-uuid",
			identifier: "parent",
			relationship: "child",
			depth: 1,
		};
		expect(_typecheck.depth).toBe(1);
	});
});

// -- `parked_case_values` table ------------------------------------

describe("Database.parked_case_values", () => {
	it("compiles a park-entry insert with server-defaulted id + timestamp", () => {
		// `applySchemaChange`'s per-row migrations write here for
		// values that cannot carry into a property's new declaration.
		// `id` (uuidv7) and `created_at` (now()) are server-defaulted,
		// so omitting both is the canonical insert shape.
		const compiled = compile(
			db.insertInto("parked_case_values").values({
				app_id: "app-uuid",
				case_id: "case-uuid",
				case_type: "patient",
				property: "age",
				original_value: JSON.stringify("abc"),
				reason:
					"cast text→int failed for property 'age': value \"abc\" is not a whole number",
				// `id` + `created_at` omitted — server defaults fire.
			}),
		);

		expect(compiled.sql).toContain('insert into "parked_case_values"');
		expect(compiled.sql).toContain('"original_value"');
		// 6 explicit columns set; `id` + `created_at` are defaulted.
		expect(compiled.parameters).toHaveLength(6);
	});

	it("exposes the schema column shape via Selectable<ParkedCaseValuesTable>", () => {
		type SelectedRow = Selectable<ParkedCaseValuesTable>;
		// Type-level assertion: every column reachable, with the
		// scalar-capable `original_value` (a bare string is valid
		// jsonb) typed as `JsonValue` on the select side.
		const _typecheck: SelectedRow = {
			id: "entry-uuid",
			app_id: "app-uuid",
			case_id: "case-uuid",
			case_type: "patient",
			property: "age",
			original_value: "abc",
			reason: "cast failed",
			created_at: new Date(),
		};
		expect(_typecheck.reason).toBe("cast failed");
	});
});
