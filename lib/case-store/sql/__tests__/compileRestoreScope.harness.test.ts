// lib/case-store/sql/__tests__/compileRestoreScope.harness.test.ts
//
// The restore closure against real Postgres, driven by CommCare HQ's own
// 45-graph acceptance table plus the Nova-specific rows that table cannot
// express (tenancy, dangling edges, transitive depths, NULL status, the
// unowned sentinel, multi-id owner sets, and a cross-case-type closure).

import type { Kysely } from "kysely";
import { buildRestoreScope } from "../compileRestoreScope";
import type { Database } from "../database";
import {
	CASE_RELATIONSHIP_FIXTURES,
	type CaseRelationshipFixture,
	fixtureCaseNames,
} from "./caseRelationshipFixtures";
import { expect, makeCaseRow, test } from "./setup";

const APP_ID = "app-restore-scope";
const PROJECT_ID = "project-restore-scope";
/** The syncing worker. HQ's fixtures give every other case a random owner. */
const WORKER = "worker-restore-scope";
const STRANGER = "stranger-restore-scope";

/**
 * Materialize one HQ fixture and return the closure's answer.
 *
 * A case's Postgres identity is its fixture name, so an assertion failure
 * reads in HQ's own vocabulary. `case_type` is constant here: the closure
 * deliberately crosses types, so varying it would test nothing the dedicated
 * cross-type row does not.
 */
async function seedFixture(
	db: Kysely<Database>,
	fixture: CaseRelationshipFixture,
): Promise<void> {
	const names = fixtureCaseNames(fixture);
	const owned = new Set(fixture.owned ?? []);
	const closed = new Set(fixture.closed ?? []);

	await db
		.insertInto("cases")
		.values(
			names.map((name) =>
				makeCaseRow({
					case_id: name,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_name: name,
					owner_id: owned.has(name) ? WORKER : STRANGER,
					status: closed.has(name) ? "closed" : "open",
					closed_on: closed.has(name) ? new Date("2026-05-03T12:00:00Z") : null,
				}),
			),
		)
		.execute();

	const edges = [
		...(fixture.subcases ?? []).map(([sub, ref], i) => ({
			case_id: sub,
			ancestor_id: ref,
			identifier: `child_${i}`,
			relationship: "child" as const,
			depth: 1,
		})),
		...(fixture.extensions ?? []).map(([sub, ref], i) => ({
			case_id: sub,
			ancestor_id: ref,
			identifier: `extension_${i}`,
			relationship: "extension" as const,
			depth: 1,
		})),
	];
	if (edges.length > 0) {
		await db.insertInto("case_indices").values(edges).execute();
	}
}

/** The closure's answer for one owner set, as sorted case ids. */
async function restoreScope(
	db: Kysely<Database>,
	ownerIds: readonly string[] = [WORKER],
): Promise<string[]> {
	const { creator, membership } = buildRestoreScope(db, {
		appId: APP_ID,
		projectId: PROJECT_ID,
		ownerIds,
	});
	const rows = await creator
		.selectFrom("cases as c")
		.select("c.case_id")
		.where("c.app_id", "=", APP_ID)
		.where("c.project_id", "=", PROJECT_ID)
		.where("c.case_id", "in", membership)
		.execute();
	return rows.map((row) => row.case_id).sort();
}

test("the closure reproduces every CommCare HQ restore fixture", async ({
	db,
}) => {
	// One transaction per file, so each graph gets its own case-id namespace
	// by prefix rather than by rollback.
	for (const fixture of CASE_RELATIONSHIP_FIXTURES) {
		const scoped: CaseRelationshipFixture = {
			...fixture,
			owned: fixture.owned?.map((n) => `${fixture.name}/${n}`),
			cases: fixture.cases?.map((n) => `${fixture.name}/${n}`),
			closed: fixture.closed?.map((n) => `${fixture.name}/${n}`),
			subcases: fixture.subcases?.map(
				([a, b]) => [`${fixture.name}/${a}`, `${fixture.name}/${b}`] as const,
			),
			extensions: fixture.extensions?.map(
				([a, b]) => [`${fixture.name}/${a}`, `${fixture.name}/${b}`] as const,
			),
			outcome: fixture.outcome.map((n) => `${fixture.name}/${n}`),
		};
		await seedFixture(db, scoped);
	}

	const got = new Set(await restoreScope(db));

	for (const fixture of CASE_RELATIONSHIP_FIXTURES) {
		const expected = fixture.outcome.map((n) => `${fixture.name}/${n}`).sort();
		const all = fixtureCaseNames({
			...fixture,
			owned: fixture.owned?.map((n) => `${fixture.name}/${n}`),
			cases: fixture.cases?.map((n) => `${fixture.name}/${n}`),
			closed: fixture.closed?.map((n) => `${fixture.name}/${n}`),
			subcases: fixture.subcases?.map(
				([a, b]) => [`${fixture.name}/${a}`, `${fixture.name}/${b}`] as const,
			),
			extensions: fixture.extensions?.map(
				([a, b]) => [`${fixture.name}/${a}`, `${fixture.name}/${b}`] as const,
			),
			outcome: fixture.outcome.map((n) => `${fixture.name}/${n}`),
		});
		const mine = all.filter((name) => got.has(name)).sort();

		// HQ's own `test_generator` asserts both halves: the outcome is
		// present, AND nothing outside it slipped in.
		expect(mine, `${fixture.name}: restore contents`).toEqual(expected);
	}
});

// ---------------------------------------------------------------------------
// Nova-specific rows. HQ's table is a graph of cases in one domain, so it
// cannot say anything about tenancy, dangling edges, transitive depths, a NULL
// status, or an owner set with more than one id — all of which are Nova's own
// storage facts and all of which the closure has to get right.
// ---------------------------------------------------------------------------

const OTHER_APP = "app-restore-scope-other";
const OTHER_PROJECT = "project-restore-scope-other";

/** One `cases` row in the closure's tenant, open and owned by the worker. */
function ours(caseId: string, overrides: Record<string, unknown> = {}) {
	return makeCaseRow({
		case_id: caseId,
		app_id: APP_ID,
		project_id: PROJECT_ID,
		case_name: caseId,
		owner_id: WORKER,
		...overrides,
	});
}

function edge(
	caseId: string,
	ancestorId: string,
	relationship: "child" | "extension",
	depth = 1,
) {
	return {
		case_id: caseId,
		ancestor_id: ancestorId,
		identifier: `${relationship}_${ancestorId}`,
		relationship,
		depth,
	};
}

test("a cross-tenant edge neither relays liveness nor makes a case an extension", async ({
	db,
}) => {
	await db
		.insertInto("cases")
		.values([
			// Owned, open, and its ONLY extension edge points into another
			// tenant. `case_indices` carries no tenant columns and no foreign
			// key, so the join to `cases` is the only thing that can refuse it.
			ours("ext"),
			// The foreign host, closed — so if the edge were honored at all, the
			// availability walk would terminate and `ext` would drop out.
			makeCaseRow({
				case_id: "foreign-host",
				app_id: OTHER_APP,
				project_id: OTHER_PROJECT,
				case_name: "foreign-host",
				owner_id: WORKER,
				status: "closed",
			}),
		])
		.execute();
	await db
		.insertInto("case_indices")
		.values([edge("ext", "foreign-host", "extension")])
		.execute();

	// `is_extension` asks about edges to cases that EXIST in this tenant, so
	// `ext` is not an extension case here and seeds the fixpoint on its own.
	expect(await restoreScope(db)).toEqual(["ext"]);
});

test("a dangling index row names no case and changes nothing", async ({
	db,
}) => {
	await db
		.insertInto("cases")
		.values([ours("ext")])
		.execute();
	await db
		.insertInto("case_indices")
		.values([edge("ext", "no-such-case", "extension")])
		.execute();

	expect(await restoreScope(db)).toEqual(["ext"]);
});

test("only depth-1 edges are walked", async ({ db }) => {
	await db
		.insertInto("cases")
		.values([
			ours("child"),
			ours("parent", { owner_id: STRANGER }),
			// Reachable from `child` only through a transitive edge.
			ours("grandparent", { owner_id: STRANGER }),
		])
		.execute();
	await db
		.insertInto("case_indices")
		.values([
			edge("child", "parent", "child"),
			edge("parent", "grandparent", "child"),
			// A materialized transitive edge. `compileRelationPath` pins
			// `depth = 1` for the same reason: the read strategy stays
			// materialization-agnostic, so a transitive row that happens to be
			// present must not double-count a hop.
			{
				case_id: "child",
				ancestor_id: "grandparent",
				identifier: "child_transitive",
				relationship: "child" as const,
				depth: 2,
			},
		])
		.execute();

	// `grandparent` still arrives — but through two depth-1 hops, and it would
	// arrive either way. What the depth-2 row must not do is make `child` look
	// like an extension case or shortcut a closed intermediate.
	expect(await restoreScope(db)).toEqual(["child", "grandparent", "parent"]);
});

test("a depth-2 extension edge does not make a case an extension case", async ({
	db,
}) => {
	await db
		.insertInto("cases")
		.values([ours("a"), ours("b")])
		.execute();
	await db
		.insertInto("case_indices")
		.values([
			{
				case_id: "a",
				ancestor_id: "b",
				identifier: "extension_transitive",
				relationship: "extension" as const,
				depth: 2,
			},
		])
		.execute();

	// Were the depth-2 row honored, `a` would be an extension case with no
	// child edge and could only become live through `b`'s availability.
	expect(await restoreScope(db)).toEqual(["a", "b"]);
});

test("an absent status is open, on both the seed and the walk", async ({
	db,
}) => {
	await db
		.insertInto("cases")
		.values([
			// `cases.status` is nullable with no default and optional on insert,
			// so `status = 'open'` would erase both of these from restore scope.
			ours("owned-null-status", { status: null }),
			ours("ext", { owner_id: STRANGER }),
			ours("host-null-status", { owner_id: STRANGER, status: null }),
		])
		.execute();
	await db
		.insertInto("case_indices")
		.values([edge("ext", "host-null-status", "extension")])
		.execute();

	// The NULL-status owned case seeds; the NULL-status host relays
	// availability to nothing here, and stays out because nobody owns it.
	expect(await restoreScope(db)).toEqual(["owned-null-status"]);
});

test("a NULL owner and the unowned sentinel are not the worker", async ({
	db,
}) => {
	await db
		.insertInto("cases")
		.values([
			ours("mine"),
			// HQ-imported rows pre-assignment.
			ours("no-owner", { owner_id: null }),
			// CommCare's unowned sentinel, which `caseOps.ts` emits for an
			// `unowned` owner expression. It is a literal owner id, not a
			// wildcard, so it belongs to no worker's restore.
			ours("unowned", { owner_id: "-" }),
		])
		.execute();

	expect(await restoreScope(db)).toEqual(["mine"]);
});

test("every id in the owner set seeds the fixpoint", async ({ db }) => {
	const DISTRICT = "location-district";
	const BLOCK = "location-block";
	await db
		.insertInto("cases")
		.values([
			ours("worker-owned"),
			ours("district-owned", { owner_id: DISTRICT }),
			ours("block-owned", { owner_id: BLOCK }),
			ours("elsewhere", { owner_id: "location-unassigned" }),
		])
		.execute();

	// `CouchUser.get_owner_ids` is the user's own id plus one per case-sharing
	// group, and a case-owning place IS such a group (its `_id` is the
	// `location_id`) — so all three seed equally.
	expect(await restoreScope(db, [WORKER, DISTRICT, BLOCK])).toEqual([
		"block-owned",
		"district-owned",
		"worker-owned",
	]);
});

test("the closure crosses case types", async ({ db }) => {
	await db
		.insertInto("cases")
		.values([
			ours("patient", { case_type: "patient" }),
			ours("household", { case_type: "household", owner_id: STRANGER }),
		])
		.execute();
	await db
		.insertInto("case_indices")
		.values([edge("patient", "household", "child")])
		.execute();

	// An owned patient pulling in its household parent is the whole point;
	// filtering `case_type` inside the closure would break it. The caller's own
	// `case_type` filter still chooses which live cases it lists.
	expect(await restoreScope(db)).toEqual(["household", "patient"]);
});

test("an empty owner set is refused, not answered", async ({ db }) => {
	await db
		.insertInto("cases")
		.values([ours("mine")])
		.execute();

	// Every worker owns at least their own id, so an empty set is a broken
	// derivation upstream. Answering it with an empty restore would look
	// exactly like a worker who genuinely holds nothing.
	await expect(restoreScope(db, [])).rejects.toThrow(
		/worker with no owner ids/,
	);
});
