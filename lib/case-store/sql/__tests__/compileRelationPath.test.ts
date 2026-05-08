// lib/case-store/sql/__tests__/compileRelationPath.test.ts
//
// Compile-only acceptance tests for the RelationPath compiler.
//
// These tests assert the SQL shape that `compileRelationPath`
// emits when consumers thread the compiled result into a parent
// query. They build a "cold" Kysely instance backed by Kysely's
// `DummyDriver` + `Postgres*` adapters, construct a parent query
// that joins the compiled relation path, and call `.compile()` —
// the resulting `CompiledQuery.sql` string is asserted on shape
// rather than exact whitespace, because identifier quoting and
// parameter placeholder layout are dialect-emitter details that
// are not the contract this test guards.
//
// The contract this test guards:
//
//   1. The four `RelationPath` discriminator arms (`self`,
//      `ancestor`, `subcase`, `any-relation`) each produce the
//      structurally correct join expression with the right
//      anchor / leaf orientation.
//   2. Multi-hop ancestor walks compose correctly — every step
//      adds one `case_indices` lookup + one `cases` lookup.
//   3. The `(app_id, owner_id)` tenant filter is structurally
//      enforced on every joined `cases` row (not just the leaf) —
//      the JOIN-side half of the structural-tenant-scoping contract
//      that makes cross-tenant reads impossible.
//   4. The `case_indices.depth = 1` filter runs on every join, so
//      the emitted SQL stays correct regardless of whether
//      `case_indices` materializes deeper edges or only direct ones.
//   5. `RelationStep.ofCaseType` and `subcase.ofCaseType` /
//      `any-relation.ofCaseType` filters narrow the joined
//      `cases.case_type` column when present.
//
// Tests use the AST builders from `lib/domain/predicate/builders.ts`
// to construct paths — that's the one supported construction
// surface, and using it ensures the schema's invariants
// (non-empty ancestor `via`, single-hop subcase / any-relation)
// are enforced at parse time, not just at compile time.

import {
	type CompiledQuery,
	DummyDriver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from "kysely";
import { describe, expect, it } from "vitest";
import {
	ancestorPath,
	anyRelationPath,
	relationStep,
	selfPath,
	subcasePath,
} from "@/lib/domain/predicate/builders";
import {
	type CompiledRelationPath,
	compileRelationPath,
	type RelationPathCompileContext,
} from "../compileRelationPath";
import type { Database } from "../database";

// -- Shared fixture --------------------------------------------------
//
// A "cold" Kysely instance. The `DummyDriver` makes execute throw,
// but `.compile()` still produces well-formed Postgres SQL — the
// canonical compile-only Kysely pattern (Kysely recipe
// `0004-splitting-query-building-and-execution`).

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

// Standard context used by every test. `anchorAlias` matches the
// alias the parent query uses for the `cases` table — convention
// is `c` so the SQL reads as `c.case_id`.
function makeCtx(): RelationPathCompileContext {
	return {
		db,
		appId: APP_ID,
		ownerId: OWNER_ID,
		anchorAlias: "c",
	};
}

// Compile shorthand — every test calls `.compile()` on a Kysely
// query node, so wrap the access for readability.
function compile(query: { compile: () => CompiledQuery }): CompiledQuery {
	return query.compile();
}

// Build a parent query that selects from the anchor (`cases`
// aliased to `c`) and joins the compiled relation path's leaf
// subquery via the `anchor_case_id` correlation column. This is
// the canonical caller pattern — every consumer (term compiler,
// expression compiler) uses this exact shape to thread a
// compiled relation path into a wider query.
//
// `compiled.buildLeafSubquery()` returns an `AliasedExpression`
// that the Kysely `innerJoin` callback accepts directly — no
// need for the caller to call `.as(...)`.
function buildJoinedQuery(
	compiled: Extract<CompiledRelationPath, { kind: "joined" }>,
) {
	return db
		.selectFrom("cases as c")
		.innerJoin(
			() => compiled.buildLeafSubquery(),
			(join) =>
				join.onRef(`${compiled.leafAlias}.anchor_case_id`, "=", "c.case_id"),
		)
		.select(["c.case_id as outer_anchor_case_id"]);
}

// -- self path --------------------------------------------------

describe("compileRelationPath — self", () => {
	it("returns kind: 'self' so callers read the anchor directly", () => {
		// `self` is the no-traversal degenerate. The compiled result
		// signals "no join required" so the caller reads properties
		// directly off the anchor's `cases` row.
		const compiled = compileRelationPath(selfPath(), makeCtx());
		expect(compiled.kind).toBe("self");
	});
});

// -- ancestor (single hop) -----------------------------------

describe("compileRelationPath — ancestor (single hop)", () => {
	it("compiles a one-hop ancestor walk into a tenant-scoped subquery", () => {
		const compiled = compileRelationPath(
			ancestorPath(relationStep("parent")),
			makeCtx(),
		);
		expect(compiled.kind).toBe("joined");
		if (compiled.kind !== "joined") {
			throw new Error("expected joined kind");
		}
		const sql = compile(buildJoinedQuery(compiled));

		// Anchor side: outer query selects from `cases as c`.
		expect(sql.sql).toContain('from "cases" as "c"');
		// Subquery is joined. The `case_indices` lookup uses the
		// `case_id` -> `ancestor_id` direction for ancestor walks.
		expect(sql.sql).toContain('"case_indices"');
		// Leaf alias is the join target.
		expect(sql.sql).toContain(`as "${compiled.leafAlias}"`);
		// `case_indices.identifier = 'parent'` is a parameter, not
		// inlined — the identifier flows through Kysely's parameter
		// channel for safe interpolation.
		expect(sql.parameters).toContain("parent");
		// Tenant filter parameters are present.
		expect(sql.parameters).toContain(APP_ID);
		expect(sql.parameters).toContain(OWNER_ID);
		// Materialization-agnostic depth filter is present so the
		// query works under both Option A (full closure) and Option B
		// (direct edges only).
		expect(sql.sql).toContain('"depth"');
		expect(sql.parameters).toContain(1);
	});

	it("applies an `ofCaseType`-style filter when the step carries `throughCaseType`", () => {
		const compiled = compileRelationPath(
			ancestorPath(relationStep("parent", "household")),
			makeCtx(),
		);
		expect(compiled.kind).toBe("joined");
		if (compiled.kind !== "joined") {
			throw new Error("expected joined kind");
		}
		const sql = compile(buildJoinedQuery(compiled));
		// The case-type narrowing flows into the joined `cases`
		// row's `case_type` column filter.
		expect(sql.sql).toContain('"case_type"');
		expect(sql.parameters).toContain("household");
	});
});

// -- ancestor (multi-hop) ------------------------------------

describe("compileRelationPath — ancestor (two hop)", () => {
	it("composes two `case_indices` lookups and two `cases` joins", () => {
		// `host of parent` — first hop walks up the parent index,
		// second hop walks up the host index from the parent's
		// destination.
		const compiled = compileRelationPath(
			ancestorPath(relationStep("parent"), relationStep("host")),
			makeCtx(),
		);
		expect(compiled.kind).toBe("joined");
		if (compiled.kind !== "joined") {
			throw new Error("expected joined kind");
		}
		const sql = compile(buildJoinedQuery(compiled));
		// Both identifiers appear as bound parameters.
		expect(sql.parameters).toContain("parent");
		expect(sql.parameters).toContain("host");
		// `case_indices` shows up twice (once per hop) in the
		// generated SQL — the chain-of-joins shape composes one
		// join per step.
		const caseIndicesOccurrences = sql.sql.split('"case_indices"').length - 1;
		expect(caseIndicesOccurrences).toBeGreaterThanOrEqual(2);
	});

	it("applies the tenant filter on every joined `cases` row, not just the leaf", () => {
		// Cross-tenant exposure depends on tenant scoping being
		// structurally enforced rather than caller-disciplined: a
		// missing filter on any intermediate `cases` join would let
		// a relation walk reach a row outside the bound owner's
		// tenant. Two-hop walk = two intermediate `cases` joins, so
		// the tenant filter parameters must appear once per joined
		// `cases` row.
		const compiled = compileRelationPath(
			ancestorPath(relationStep("parent"), relationStep("host")),
			makeCtx(),
		);
		expect(compiled.kind).toBe("joined");
		if (compiled.kind !== "joined") {
			throw new Error("expected joined kind");
		}
		const sql = compile(buildJoinedQuery(compiled));
		// Two `cases` joins inside the subquery (one per hop) =
		// two `app_id` filter parameters and two `owner_id` filter
		// parameters.
		const appIdCount = sql.parameters.filter((p) => p === APP_ID).length;
		const ownerIdCount = sql.parameters.filter((p) => p === OWNER_ID).length;
		expect(appIdCount).toBeGreaterThanOrEqual(2);
		expect(ownerIdCount).toBeGreaterThanOrEqual(2);
	});

	it("filters `depth = 1` on every `case_indices` lookup", () => {
		// The materialization-agnostic discipline: under Option A
		// (full closure), `depth = 1` skips the transitive rows;
		// under Option B (direct edges only), every row has
		// `depth = 1` so the filter is a no-op. Either way, the
		// SQL is correct.
		const compiled = compileRelationPath(
			ancestorPath(relationStep("parent"), relationStep("host")),
			makeCtx(),
		);
		expect(compiled.kind).toBe("joined");
		if (compiled.kind !== "joined") {
			throw new Error("expected joined kind");
		}
		const sql = compile(buildJoinedQuery(compiled));
		// Two hops = two `depth = 1` filters.
		const depthOnes = sql.parameters.filter((p) => p === 1).length;
		expect(depthOnes).toBeGreaterThanOrEqual(2);
	});
});

// -- subcase ---------------------------------------------------

describe("compileRelationPath — subcase", () => {
	it("compiles a single-hop subcase walk with reverse-direction join", () => {
		// Subcase is the reverse direction: `case_indices.ancestor_id`
		// is the anchor, `case_indices.case_id` is the leaf.
		const compiled = compileRelationPath(subcasePath("parent"), makeCtx());
		expect(compiled.kind).toBe("joined");
		if (compiled.kind !== "joined") {
			throw new Error("expected joined kind");
		}
		const sql = compile(buildJoinedQuery(compiled));
		expect(sql.sql).toContain('"case_indices"');
		// Reverse direction: the join correlates `anchor_case_id`
		// against the parent's `case_id`, so the subquery's
		// `anchor_case_id` is sourced from `case_indices.ancestor_id`.
		expect(sql.sql).toContain(`"${compiled.leafAlias}"."anchor_case_id"`);
		expect(sql.parameters).toContain("parent");
		// Tenant filter on the joined `cases` row.
		expect(sql.parameters).toContain(APP_ID);
		expect(sql.parameters).toContain(OWNER_ID);
		// Depth filter still applies — reverse direction reads the
		// same `case_indices` rows.
		expect(sql.parameters).toContain(1);
	});

	it("applies `ofCaseType` narrowing on the subcase leaf", () => {
		const compiled = compileRelationPath(
			subcasePath("parent", "patient"),
			makeCtx(),
		);
		expect(compiled.kind).toBe("joined");
		if (compiled.kind !== "joined") {
			throw new Error("expected joined kind");
		}
		const sql = compile(buildJoinedQuery(compiled));
		expect(sql.sql).toContain('"case_type"');
		expect(sql.parameters).toContain("patient");
	});
});

// -- any-relation ---------------------------------------------

describe("compileRelationPath — any-relation", () => {
	it("unions ancestor and subcase walks for direction-agnostic resolution", () => {
		// `any-relation` admits both directions. The compiler
		// emits a `UNION ALL` of an ancestor variant and a subcase
		// variant against the same `identifier`.
		const compiled = compileRelationPath(anyRelationPath("parent"), makeCtx());
		expect(compiled.kind).toBe("joined");
		if (compiled.kind !== "joined") {
			throw new Error("expected joined kind");
		}
		const sql = compile(buildJoinedQuery(compiled));
		// Both directions: the SQL contains a `union all` between
		// the two sub-queries.
		expect(sql.sql).toContain("union all");
		// The identifier appears twice — once per direction.
		const identifierParams = sql.parameters.filter((p) => p === "parent");
		expect(identifierParams.length).toBeGreaterThanOrEqual(2);
		// Tenant filter applies inside each branch.
		const appIdCount = sql.parameters.filter((p) => p === APP_ID).length;
		expect(appIdCount).toBeGreaterThanOrEqual(2);
	});

	it("threads `ofCaseType` into both union branches", () => {
		const compiled = compileRelationPath(
			anyRelationPath("link", "household"),
			makeCtx(),
		);
		expect(compiled.kind).toBe("joined");
		if (compiled.kind !== "joined") {
			throw new Error("expected joined kind");
		}
		const sql = compile(buildJoinedQuery(compiled));
		// `household` appears twice — once per direction's
		// `cases.case_type` filter.
		const caseTypeParams = sql.parameters.filter((p) => p === "household");
		expect(caseTypeParams.length).toBeGreaterThanOrEqual(2);
	});
});

// -- ownerId IS NULL handling --------------------------------

describe("compileRelationPath — anchor / tenant edges", () => {
	it("emits an IS NULL filter when ownerId is null", () => {
		// HQ-imported cases pre-assignment have a null `owner_id`;
		// the tenant filter must use `IS NULL` rather than
		// `= NULL` (the latter is always false in SQL).
		const compiled = compileRelationPath(ancestorPath(relationStep("parent")), {
			db,
			appId: APP_ID,
			ownerId: null,
			anchorAlias: "c",
		});
		expect(compiled.kind).toBe("joined");
		if (compiled.kind !== "joined") {
			throw new Error("expected joined kind");
		}
		const sql = compile(buildJoinedQuery(compiled));
		expect(sql.sql).toContain('"owner_id" is null');
		// The owner_id filter no longer binds an OWNER_ID
		// parameter — it's an `IS NULL` predicate.
		expect(sql.parameters).not.toContain(OWNER_ID);
	});

	it("honors a custom anchor alias", () => {
		// Callers may anchor against an alias other than `c` —
		// e.g. when the relation path is nested inside an `exists`
		// subquery whose outer table aliases `cases` differently.
		const ctx: RelationPathCompileContext = {
			db,
			appId: APP_ID,
			ownerId: OWNER_ID,
			anchorAlias: "outer_case",
		};
		const compiled = compileRelationPath(
			ancestorPath(relationStep("parent")),
			ctx,
		);
		expect(compiled.kind).toBe("joined");
		if (compiled.kind !== "joined") {
			throw new Error("expected joined kind");
		}
		// The compiled subquery exposes `anchor_case_id` as the
		// correlation column; the caller writes the join with
		// whatever outer alias they chose. The compiled subquery
		// itself doesn't know the outer alias — verifies the API
		// design's encapsulation.
		const sql = compile(
			db
				.selectFrom("cases as outer_case")
				.innerJoin(
					() => compiled.buildLeafSubquery(),
					(join) =>
						join.onRef(
							`${compiled.leafAlias}.anchor_case_id`,
							"=",
							"outer_case.case_id",
						),
				)
				.select([
					"outer_case.case_id as anchor_id",
					`${compiled.leafAlias}.case_id as leaf_id`,
				]),
		);
		expect(sql.sql).toContain('from "cases" as "outer_case"');
		expect(sql.sql).toContain('"outer_case"."case_id"');
	});
});

// -- Leaf alias contract --------------------------------------

describe("compileRelationPath — leafAlias contract", () => {
	it("produces a stable, valid SQL identifier for the leaf alias", () => {
		// The compiler picks the leaf alias; callers thread it.
		// Whatever the alias is, it must be a valid SQL identifier
		// — no spaces, no reserved-word collisions with the
		// `cases` table.
		const compiled = compileRelationPath(
			ancestorPath(relationStep("parent")),
			makeCtx(),
		);
		expect(compiled.kind).toBe("joined");
		if (compiled.kind !== "joined") {
			throw new Error("expected joined kind");
		}
		expect(compiled.leafAlias).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
		expect(compiled.leafAlias).not.toBe("cases");
		expect(compiled.leafAlias).not.toBe("case_indices");
	});
});

// -- Paren-wrap structural assertion ---------------------------------
//
// `INNER JOIN (subquery) AS "alias" ON ...` is the only valid Postgres
// shape for a joined subquery. Without parens the parser reads the
// subquery's `SELECT ... FROM` as part of the outer FROM clause and
// the `AS "alias"` attaches to whatever the body's tail expression is
// — a parse error. `RawBuilder.as` does NOT insert parens; the
// responsibility belongs to whichever helper assembles the body.
//
// This suite exists as a one-line guard that compiles every joined
// arm and asserts the `INNER JOIN (` shape in the emitted SQL. A
// regression that drops the wrap (or adds a body-shape that bypasses
// `composeSubqueryBody`) trips this check before any harness round-
// trip test fails.

describe("compileRelationPath — paren-wrap shape", () => {
	const arms = [
		{
			name: "ancestor single-hop",
			path: ancestorPath(relationStep("parent")),
		},
		{
			name: "ancestor two-hop",
			path: ancestorPath(relationStep("parent"), relationStep("host")),
		},
		{ name: "subcase", path: subcasePath("parent") },
		{ name: "any-relation", path: anyRelationPath("parent") },
	] as const;

	for (const { name, path } of arms) {
		it(`paren-wraps the JOIN target for ${name}`, () => {
			const compiled = compileRelationPath(path, makeCtx());
			if (compiled.kind !== "joined") {
				throw new Error("expected joined kind");
			}
			const sql = compile(buildJoinedQuery(compiled));
			// The JOIN target opens with `inner join (` and the alias
			// `as "rp_leaf"` appears later in the same clause. Use a
			// case-insensitive regex because Kysely's Postgres compiler
			// emits lowercase keywords; `\(` matches the literal open
			// paren regardless of internal whitespace.
			expect(sql.sql).toMatch(/inner join \(/i);
			expect(sql.sql).toContain(`) as "${compiled.leafAlias}"`);
		});
	}
});
