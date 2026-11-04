// lib/case-store/sql/__tests__/restoreScopeClaims.postgres.test.ts
//
// A worker's claims in the restore closure, against real Postgres.
//
// HQ's claim is an open case of type `commcare-case-claim` the worker owns,
// with one `host` extension index to the chosen case
// (`casexml/apps/case/cleanup.py::claim_case`), and the store writes exactly
// that row (`CaseStore.claimCases`). The closure knows nothing about claims,
// so these tests hold what HQ's fixpoint makes of the row over HQ's own 45
// restore graphs (`case_relationship_tests.json`).
//
// The expectation is what Nova's restore held before claims were rows: the
// chosen case seeded the fixpoint carrying its own openness. Seeding an open
// case is what owning it does, and a closed seed relays nothing, so that
// closure is the graph's closure with the chosen case owned by the worker.
// With a real row, the claim itself joins the restore exactly when its host
// does: a live host makes its open extensions live, and a live extension
// makes its host live (`livequery.py`'s `enliven`). Where the host is not
// held, a closed one nothing pulls in, the claim is not held either, which
// the old seed could not show since it had no row.

import type { Insertable, Kysely } from "kysely";
import { CASE_CLAIM_CASE_TYPE, CASE_CLAIM_HOST_INDEX } from "@/lib/domain";
import { buildRestoreScope } from "../compileRestoreScope";
import type { CaseIndicesTable, CasesTable, Database } from "../database";
import {
	CASE_RELATIONSHIP_FIXTURES,
	type CaseRelationshipFixture,
	fixtureCaseNames,
} from "./caseRelationshipFixtures";
import { expect, makeCaseRow, test } from "./setup";

const APP_ID = "app-restore-scope";
const PROJECT_ID = "project-restore-scope";
const OTHER_APP = "app-restore-scope-other";
const OTHER_PROJECT = "project-restore-scope-other";
const WORKER = "worker-restore-claims";
const STRANGER = "stranger-restore-claims";

/** Rows of one HQ graph, every case named under `prefix`. `alsoOwned` names
 *  cases the worker owns beyond the fixture's own. */
function graphRows(
	fixture: CaseRelationshipFixture,
	prefix: string,
	alsoOwned?: string,
): {
	readonly cases: Insertable<CasesTable>[];
	readonly edges: Insertable<CaseIndicesTable>[];
} {
	const owned = new Set(fixture.owned ?? []);
	if (alsoOwned !== undefined) owned.add(alsoOwned);
	const closed = new Set(fixture.closed ?? []);
	const id = (name: string) => `${prefix}/${name}`;
	return {
		cases: fixtureCaseNames(fixture).map((name) =>
			makeCaseRow({
				case_id: id(name),
				app_id: APP_ID,
				project_id: PROJECT_ID,
				case_name: name,
				owner_id: owned.has(name) ? WORKER : STRANGER,
				status: closed.has(name) ? "closed" : "open",
				closed_on: closed.has(name) ? new Date("2026-05-03T12:00:00Z") : null,
			}),
		),
		edges: [
			...(fixture.subcases ?? []).map(([sub, ref], i) => ({
				case_id: id(sub),
				ancestor_id: id(ref),
				target_case_type: "patient",
				identifier: `child_${i}`,
				relationship: "child" as const,
				depth: 1,
			})),
			...(fixture.extensions ?? []).map(([sub, ref], i) => ({
				case_id: id(sub),
				ancestor_id: id(ref),
				target_case_type: "patient",
				identifier: `extension_${i}`,
				relationship: "extension" as const,
				depth: 1,
			})),
		],
	};
}

/** HQ's claim row of `hostId`, as `claimCases` writes it, and its index. */
function claimRows(
	claimId: string,
	hostId: string,
	options: {
		readonly status?: "open" | "closed";
		readonly appId?: string;
		readonly projectId?: string;
	} = {},
): {
	readonly claim: Insertable<CasesTable>;
	readonly edge: Insertable<CaseIndicesTable>;
} {
	const closed = options.status === "closed";
	return {
		claim: makeCaseRow({
			case_id: claimId,
			app_id: options.appId ?? APP_ID,
			project_id: options.projectId ?? PROJECT_ID,
			case_type: CASE_CLAIM_CASE_TYPE,
			case_name: "claimed",
			owner_id: WORKER,
			status: closed ? "closed" : "open",
			closed_on: closed ? new Date("2026-05-04T12:00:00Z") : null,
		}),
		edge: {
			case_id: claimId,
			ancestor_id: hostId,
			target_case_type: "patient",
			identifier: CASE_CLAIM_HOST_INDEX,
			relationship: "extension",
			depth: 1,
		},
	};
}

async function insert(
	db: Kysely<Database>,
	cases: readonly Insertable<CasesTable>[],
	edges: readonly Insertable<CaseIndicesTable>[],
): Promise<void> {
	if (cases.length > 0)
		await db
			.insertInto("cases")
			.values([...cases])
			.execute();
	if (edges.length > 0)
		await db
			.insertInto("case_indices")
			.values([...edges])
			.execute();
}

/** The closure's answer as a set of case ids. */
async function closure(db: Kysely<Database>): Promise<Set<string>> {
	const { creator, restrict } = buildRestoreScope(db, {
		appId: APP_ID,
		projectId: PROJECT_ID,
		ownerIds: [WORKER],
	});
	const rows = await restrict(
		creator
			.selectFrom("cases as c")
			.select("c.case_id")
			.where("c.app_id", "=", APP_ID)
			.where("c.project_id", "=", PROJECT_ID),
		"c",
	).execute();
	return new Set(rows.map((row) => row.case_id));
}

/** One world per (graph, chosen case) pair, every world its own disconnected
 *  graph, so one query answers them all. */
interface ClaimWorld {
	readonly fixture: CaseRelationshipFixture;
	readonly label: string;
	readonly names: readonly string[];
	readonly chosen: string;
	readonly claimed: string;
	readonly expected: string;
	readonly claimId: string;
}

function claimWorlds(): readonly ClaimWorld[] {
	return CASE_RELATIONSHIP_FIXTURES.flatMap((fixture) => {
		const names = fixtureCaseNames(fixture);
		return names.map((chosen, index) => ({
			fixture,
			label: `${fixture.name} claiming ${chosen}`,
			names,
			chosen,
			claimed: `claimed/${fixture.name}/${index}`,
			expected: `expected/${fixture.name}/${index}`,
			// Outside both worlds' names, since several HQ graphs name a case
			// `claim` of their own.
			claimId: `claim-row/${fixture.name}/${index}`,
		}));
	});
}

test("the closure is HQ's own on every graph", async ({ db }) => {
	const cases: Insertable<CasesTable>[] = [];
	const edges: Insertable<CaseIndicesTable>[] = [];
	for (const fixture of CASE_RELATIONSHIP_FIXTURES) {
		const graph = graphRows(fixture, fixture.name);
		cases.push(...graph.cases);
		edges.push(...graph.edges);
	}
	await insert(db, cases, edges);
	const held = [...(await closure(db))].sort();
	for (const fixture of CASE_RELATIONSHIP_FIXTURES) {
		const expected = fixture.outcome.map((name) => `${fixture.name}/${name}`);
		expect(
			held.filter((id) => id.startsWith(`${fixture.name}/`)).sort(),
			fixture.name,
		).toEqual([...expected].sort());
	}
});

test("a claim row holds what seeding its host held, and itself exactly when its host is held, for every case of every HQ graph", async ({
	db,
}) => {
	const cases: Insertable<CasesTable>[] = [];
	const edges: Insertable<CaseIndicesTable>[] = [];
	const worlds = claimWorlds();
	for (const world of worlds) {
		const claimed = graphRows(world.fixture, world.claimed);
		const expected = graphRows(world.fixture, world.expected, world.chosen);
		const { claim, edge } = claimRows(
			world.claimId,
			`${world.claimed}/${world.chosen}`,
		);
		cases.push(...claimed.cases, ...expected.cases, claim);
		edges.push(...claimed.edges, ...expected.edges, edge);
	}
	await insert(db, cases, edges);

	const held = await closure(db);
	for (const world of worlds) {
		const expected = world.names.filter((name) =>
			held.has(`${world.expected}/${name}`),
		);
		const got = world.names.filter((name) =>
			held.has(`${world.claimed}/${name}`),
		);
		expect(got, world.label).toEqual(expected);
		expect(held.has(world.claimId), `${world.label}: the claim row`).toBe(
			held.has(`${world.claimed}/${world.chosen}`),
		);
	}
	// The graphs where the claim row is not held are the ones whose chosen
	// case nothing holds. Most graphs hold some such case, so the second
	// expectation above is never vacuous.
	expect(worlds.some((world) => !held.has(world.claimId))).toBe(true);
	expect(worlds.some((world) => held.has(world.claimId))).toBe(true);
});

test("a closed claim row contributes nothing, for every case of every HQ graph", async ({
	db,
}) => {
	const cases: Insertable<CasesTable>[] = [];
	const edges: Insertable<CaseIndicesTable>[] = [];
	const worlds = claimWorlds();
	for (const world of worlds) {
		const claimed = graphRows(world.fixture, world.claimed);
		const expected = graphRows(world.fixture, world.expected);
		const { claim, edge } = claimRows(
			world.claimId,
			`${world.claimed}/${world.chosen}`,
			{ status: "closed" },
		);
		cases.push(...claimed.cases, ...expected.cases, claim);
		edges.push(...claimed.edges, ...expected.edges, edge);
	}
	await insert(db, cases, edges);

	const held = await closure(db);
	for (const world of worlds) {
		const expected = world.names.filter((name) =>
			held.has(`${world.expected}/${name}`),
		);
		const got = world.names.filter((name) =>
			held.has(`${world.claimed}/${name}`),
		);
		expect(got, world.label).toEqual(expected);
	}
	// A closed claim seeds nothing, and a held host's downward hop reaches
	// only open extensions, so no closed claim row is ever held.
	expect(worlds.filter((world) => held.has(world.claimId))).toEqual([]);
});

test("a claim row of another app or Project seeds nothing here, and a claim of another Project's case brings it nothing", async ({
	db,
	pgClient,
}) => {
	// The foreign rows bypass the tenant FK to test the closure's own fence;
	// they are rolled back with the test.
	await pgClient.query("SET CONSTRAINTS cases_project_app_tenant_fk DEFERRED");
	const foreignAppClaim = claimRows("claim-in-other-app", "ours", {
		appId: OTHER_APP,
	});
	const foreignProjectClaim = claimRows("claim-in-other-project", "ours", {
		projectId: OTHER_PROJECT,
	});
	const claimOfForeign = claimRows("claim-of-foreign", "foreign-project-case");
	await insert(
		db,
		[
			makeCaseRow({
				case_id: "ours",
				app_id: APP_ID,
				project_id: PROJECT_ID,
				owner_id: STRANGER,
			}),
			makeCaseRow({
				case_id: "foreign-project-case",
				app_id: APP_ID,
				project_id: OTHER_PROJECT,
				owner_id: STRANGER,
			}),
			foreignAppClaim.claim,
			foreignProjectClaim.claim,
			claimOfForeign.claim,
		],
		[foreignAppClaim.edge, foreignProjectClaim.edge, claimOfForeign.edge],
	);
	const held = await closure(db);
	// The worker's claims in another app or Project are rows of that tenant,
	// which this closure never reads, so they hold nothing of ours.
	expect(held.has("ours")).toBe(false);
	expect(held.has("claim-in-other-app")).toBe(false);
	expect(held.has("claim-in-other-project")).toBe(false);
	// Every hop joins `cases` on the tenant, so a host outside it is never
	// reached.
	expect(held.has("foreign-project-case")).toBe(false);
});
