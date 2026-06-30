// lib/case-store/sql/__tests__/compileRelationPath.harness.test.ts
//
// Execute-against-real-Postgres tests for the RelationPath
// compiler. These tests insert real `cases` and `case_indices`
// rows, build a wider query that joins the compiled relation-path
// subquery, and execute the whole thing through the testcontainers
// harness. The point is to catch failures the compile-only suite
// (sibling `compileRelationPath.test.ts`) can't see — most
// notably, malformed SQL that Kysely accepts at compile time but
// Postgres rejects at parse time.
//
// ## Why a separate file from the cold compile-only suite
//
// Cold tests use Kysely's `DummyDriver` and assert on the
// `.compile()` output's string shape. They never execute. A
// regression that produces invalid SQL would still pass every
// `toContain(...)` assertion the cold suite makes — the cold suite
// answers "does the emitted SQL contain these tokens", not "does
// Postgres parse and execute it correctly". This file's tests
// answer the second question for every joined arm.
//
// File-placement rationale: the sibling file is import-ergonomics
// for the cold path (vitest's `it`, raw `Kysely<Database>` with
// `DummyDriver`). The harness path imports `test` from
// `./setup.ts` to pick up the per-test `db` / `pgClient` fixtures.
// Co-locating both shapes in one file would force every cold test
// to boot the container or every harness test to construct its
// own dummy `db` — splitting the file is cleaner.
//
// ## What this file covers
//
//   1. Each joined arm round-trips one row through the compiled
//      subquery against the live engine. The cold suite covers
//      every shape variant (case-type filters, multi-hop walks,
//      etc.); this file covers the execution path for the
//      structurally distinct arms (single-hop ancestor, multi-hop
//      ancestor, subcase, any-relation).
//   2. The `case_indices.depth = 1` filter excludes transitive
//      rows. The depth-filter test seeds a `depth = 2` row
//      alongside the `depth = 1` rows and asserts the compiler
//      ignores it — a regression that drops the depth pin would
//      surface as the wrong leaf returning from a single-hop
//      ancestor walk.
//
// ## Fixture data shape
//
// Each test seeds a small case graph through the per-test `db`
// fixture. The harness's BEGIN/ROLLBACK envelope rolls back every
// write, so tests can use stable case IDs without conflicting
// with sibling tests. The IDs are valid UUIDs so the `cases`
// table's `case_id UUID PRIMARY KEY` accepts them.

import { describe } from "vitest";
import {
	ancestorPath,
	anyRelationPath,
	relationStep,
	subcasePath,
} from "@/lib/domain/predicate/builders";
import { compileRelationPath } from "../compileRelationPath";
import { expect, makeCaseRow, test } from "./setup";

// ---------------------------------------------------------------
// Stable test fixture IDs
// ---------------------------------------------------------------
//
// Per-test rollback isolation means these IDs can be reused across
// tests without conflicting. Picking deterministic UUIDs (rather
// than `crypto.randomUUID()`) keeps assertions readable and lets
// future authors trace which row a `WHERE case_id = ...` query
// is reaching.

const APP_ID = "app-relation-path";
const OWNER_ID = "owner-relation-path";

// Anchor case (the "current case" the relation path walks from).
const ANCHOR_CASE_ID = "00000000-0000-0000-0000-000000000001";
// Direct parent of the anchor.
const PARENT_CASE_ID = "00000000-0000-0000-0000-000000000002";
// Direct host of the parent (used for two-hop ancestor walks).
const HOST_CASE_ID = "00000000-0000-0000-0000-000000000003";
// A subcase of the anchor (the anchor's child via the `parent`
// index pointing back at the anchor).
const SUBCASE_CASE_ID = "00000000-0000-0000-0000-000000000004";
// A grandparent of the anchor — only reachable via two hops.
// Inserted with a `case_indices` row at `depth = 2` to test the
// depth-filter discipline.
const GRANDPARENT_CASE_ID = "00000000-0000-0000-0000-000000000005";

// ---------------------------------------------------------------
// Compile-context helper
// ---------------------------------------------------------------
//
// The `db` argument is the per-test transaction-scoped Kysely
// instance the harness fixture provides. Threading it into the
// compile context preserves the contract that production code
// shares one `Kysely<Database>` instance across compiler and
// runtime layers.

function makeCtx(db: Parameters<typeof compileRelationPath>[1]["db"]) {
	return { db, appId: APP_ID, projectId: OWNER_ID, anchorAlias: "c" };
}

// ---------------------------------------------------------------
// Common parent-query shape
// ---------------------------------------------------------------
//
// Every test in this file builds the same outer query: select the
// anchor's `case_id` plus the leaf's `case_id`, joining the
// compiled relation path's subquery on the synthetic
// `anchor_case_id` correlation column. The wider query also
// applies the tenant filter to the anchor — same filter the
// relation-path compiler enforces inside the subquery, applied at
// the anchor level by the caller.

interface AnchorLeafPair {
	anchor_case_id: string;
	leaf_case_id: string;
}

function executeJoined(
	db: Parameters<typeof compileRelationPath>[1]["db"],
	compiled: ReturnType<typeof compileRelationPath>,
	anchorCaseId: string,
): Promise<AnchorLeafPair[]> {
	if (compiled.kind !== "joined") {
		throw new Error("expected joined relation path");
	}
	return db
		.selectFrom("cases as c")
		.innerJoin(
			() => compiled.buildLeafSubquery(),
			(join) =>
				join.onRef(`${compiled.leafAlias}.anchor_case_id`, "=", "c.case_id"),
		)
		.where("c.case_id", "=", anchorCaseId)
		.where("c.app_id", "=", APP_ID)
		.where("c.project_id", "=", OWNER_ID)
		.select([
			"c.case_id as anchor_case_id",
			`${compiled.leafAlias}.case_id as leaf_case_id`,
		])
		.execute();
}

// ---------------------------------------------------------------
// Fixture seeding helpers
// ---------------------------------------------------------------
//
// `case_indices` has no `setup.ts` builder yet (the harness only
// owns a `cases` builder). These helpers keep the
// `case_indices`-row literals out of the test bodies so each test
// reads as "seed a graph, compile a path, assert the rows" rather
// than "compose 11 columns inline". The relationship default is
// `child` — the most common kind; tests that need `extension`
// override it explicitly.

interface CaseIndexSeed {
	case_id: string;
	ancestor_id: string;
	identifier: string;
	relationship?: "child" | "extension";
	depth?: number;
}

async function seedCaseIndex(
	db: Parameters<typeof compileRelationPath>[1]["db"],
	seed: CaseIndexSeed,
): Promise<void> {
	await db
		.insertInto("case_indices")
		.values({
			case_id: seed.case_id,
			ancestor_id: seed.ancestor_id,
			identifier: seed.identifier,
			relationship: seed.relationship ?? "child",
			depth: seed.depth ?? 1,
		})
		.execute();
}

async function seedCases(
	db: Parameters<typeof compileRelationPath>[1]["db"],
	rows: ReadonlyArray<{ case_id: string; case_type: string }>,
): Promise<void> {
	await db
		.insertInto("cases")
		.values(
			rows.map((row) =>
				makeCaseRow({
					case_id: row.case_id,
					case_type: row.case_type,
					app_id: APP_ID,
					project_id: OWNER_ID,
				}),
			),
		)
		.execute();
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe("compileRelationPath — round-trip — ancestor (single hop)", () => {
	test("returns the parent case when joined against the anchor", async ({
		db,
	}) => {
		// Graph: anchor --[parent]--> parent_case.
		await seedCases(db, [
			{ case_id: ANCHOR_CASE_ID, case_type: "patient" },
			{ case_id: PARENT_CASE_ID, case_type: "household" },
		]);
		await seedCaseIndex(db, {
			case_id: ANCHOR_CASE_ID,
			ancestor_id: PARENT_CASE_ID,
			identifier: "parent",
		});

		const compiled = compileRelationPath(
			ancestorPath(relationStep("parent")),
			makeCtx(db),
		);

		const rows = await executeJoined(db, compiled, ANCHOR_CASE_ID);
		expect(rows).toEqual([
			{ anchor_case_id: ANCHOR_CASE_ID, leaf_case_id: PARENT_CASE_ID },
		]);
	});
});

describe("compileRelationPath — round-trip — ancestor (two hop)", () => {
	test("walks parent then host and returns the host case", async ({ db }) => {
		// Graph:
		//   anchor --[parent]--> parent_case --[host]--> host_case.
		// Two-hop walk should reach `host_case` and only `host_case`.
		await seedCases(db, [
			{ case_id: ANCHOR_CASE_ID, case_type: "patient" },
			{ case_id: PARENT_CASE_ID, case_type: "household" },
			{ case_id: HOST_CASE_ID, case_type: "village" },
		]);
		await seedCaseIndex(db, {
			case_id: ANCHOR_CASE_ID,
			ancestor_id: PARENT_CASE_ID,
			identifier: "parent",
		});
		await seedCaseIndex(db, {
			case_id: PARENT_CASE_ID,
			ancestor_id: HOST_CASE_ID,
			identifier: "host",
		});

		const compiled = compileRelationPath(
			ancestorPath(relationStep("parent"), relationStep("host")),
			makeCtx(db),
		);

		const rows = await executeJoined(db, compiled, ANCHOR_CASE_ID);
		expect(rows).toEqual([
			{ anchor_case_id: ANCHOR_CASE_ID, leaf_case_id: HOST_CASE_ID },
		]);
	});
});

describe("compileRelationPath — round-trip — subcase", () => {
	test("returns subcases whose own index points back at the anchor", async ({
		db,
	}) => {
		// Graph: subcase_case --[parent]--> anchor.
		// A subcase walk reads the cases whose own index points at
		// the anchor — direction reversed compared to the ancestor
		// walk.
		await seedCases(db, [
			{ case_id: ANCHOR_CASE_ID, case_type: "household" },
			{ case_id: SUBCASE_CASE_ID, case_type: "patient" },
		]);
		await seedCaseIndex(db, {
			case_id: SUBCASE_CASE_ID,
			ancestor_id: ANCHOR_CASE_ID,
			identifier: "parent",
		});

		const compiled = compileRelationPath(subcasePath("parent"), makeCtx(db));

		const rows = await executeJoined(db, compiled, ANCHOR_CASE_ID);
		expect(rows).toEqual([
			{ anchor_case_id: ANCHOR_CASE_ID, leaf_case_id: SUBCASE_CASE_ID },
		]);
	});
});

describe("compileRelationPath — round-trip — any-relation", () => {
	test("unions ancestor and subcase directions", async ({ db }) => {
		// Graph:
		//   anchor --[link]--> parent_case   (ancestor direction)
		//   subcase_case --[link]--> anchor  (subcase direction)
		// Both directions share the same identifier (`link`); the
		// any-relation walk should return both leaves.
		await seedCases(db, [
			{ case_id: ANCHOR_CASE_ID, case_type: "household" },
			{ case_id: PARENT_CASE_ID, case_type: "village" },
			{ case_id: SUBCASE_CASE_ID, case_type: "patient" },
		]);
		await seedCaseIndex(db, {
			case_id: ANCHOR_CASE_ID,
			ancestor_id: PARENT_CASE_ID,
			identifier: "link",
		});
		await seedCaseIndex(db, {
			case_id: SUBCASE_CASE_ID,
			ancestor_id: ANCHOR_CASE_ID,
			identifier: "link",
		});

		const compiled = compileRelationPath(anyRelationPath("link"), makeCtx(db));

		const rows = await executeJoined(db, compiled, ANCHOR_CASE_ID);
		// Order is union-arbitrary; sort for stable comparison.
		const leafIds = rows.map((row) => row.leaf_case_id).sort();
		expect(leafIds).toEqual([PARENT_CASE_ID, SUBCASE_CASE_ID].sort());
	});
});

describe("compileRelationPath — round-trip — depth filter", () => {
	test("ignores depth>1 rows so the chain-of-joins reads only direct edges", async ({
		db,
	}) => {
		// Graph (direct edges only):
		//   anchor --[parent]--> parent_case --[parent]--> grandparent
		// Plus a `depth = 2` row pointing `anchor` directly at
		// `grandparent` — the shape a transitive-closure
		// materialization writes. The `depth = 1` pin in
		// `compileRelationPath` MUST skip that row, so a single-hop
		// ancestor walk reaches `parent_case`, not `grandparent`.
		await seedCases(db, [
			{ case_id: ANCHOR_CASE_ID, case_type: "patient" },
			{ case_id: PARENT_CASE_ID, case_type: "household" },
			{ case_id: GRANDPARENT_CASE_ID, case_type: "village" },
		]);
		await seedCaseIndex(db, {
			case_id: ANCHOR_CASE_ID,
			ancestor_id: PARENT_CASE_ID,
			identifier: "parent",
			depth: 1,
		});
		await seedCaseIndex(db, {
			case_id: PARENT_CASE_ID,
			ancestor_id: GRANDPARENT_CASE_ID,
			identifier: "parent",
			depth: 1,
		});
		// The depth=2 row is the transitive-closure shape: an
		// edge directly from anchor to grandparent. The compiler
		// MUST NOT return its destination as a single-hop ancestor.
		await seedCaseIndex(db, {
			case_id: ANCHOR_CASE_ID,
			ancestor_id: GRANDPARENT_CASE_ID,
			identifier: "parent",
			depth: 2,
		});

		const compiled = compileRelationPath(
			ancestorPath(relationStep("parent")),
			makeCtx(db),
		);

		const rows = await executeJoined(db, compiled, ANCHOR_CASE_ID);
		// Single-hop walk reaches `parent_case`, not `grandparent`.
		expect(rows).toEqual([
			{ anchor_case_id: ANCHOR_CASE_ID, leaf_case_id: PARENT_CASE_ID },
		]);
	});
});
