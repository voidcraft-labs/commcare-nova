// lib/case-store/sql/__tests__/restoreScopeClaims.postgres.test.ts
//
// A worker's claims in the restore closure, against real Postgres.
//
// HQ's claim is an open case the worker owns with an extension index to the
// chosen case (`casexml/apps/case/cleanup.py::claim_case`). Nova writes no
// such row and seeds the chosen case instead, so the oracle is a differential
// over HQ's own 45 restore graphs: for every case of every graph, the closure
// seeded with that case's id holds exactly what the same graph holds once a
// real claim row is added, less the claim row itself.

import type { Insertable, Kysely } from "kysely";
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

/** Rows of one HQ graph, every case named under `prefix`. */
function graphRows(
	fixture: CaseRelationshipFixture,
	prefix: string,
): {
	readonly cases: Insertable<CasesTable>[];
	readonly edges: Insertable<CaseIndicesTable>[];
} {
	const owned = new Set(fixture.owned ?? []);
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
				target_case_type: "test",
				identifier: `child_${i}`,
				relationship: "child" as const,
				depth: 1,
			})),
			...(fixture.extensions ?? []).map(([sub, ref], i) => ({
				case_id: id(sub),
				ancestor_id: id(ref),
				target_case_type: "test",
				identifier: `extension_${i}`,
				relationship: "extension" as const,
				depth: 1,
			})),
		],
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
async function closure(
	db: Kysely<Database>,
	claimedCaseIds?: readonly string[],
): Promise<Set<string>> {
	const { creator, restrict } = buildRestoreScope(db, {
		appId: APP_ID,
		projectId: PROJECT_ID,
		ownerIds: [WORKER],
		...(claimedCaseIds === undefined ? {} : { claimedCaseIds }),
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

test("a claimed id holds what HQ's claim case brings, for every case of every HQ graph", async ({
	db,
}) => {
	const cases: Insertable<CasesTable>[] = [];
	const edges: Insertable<CaseIndicesTable>[] = [];
	const claimedIds: string[] = [];
	const pairs: {
		readonly label: string;
		readonly names: readonly string[];
		readonly real: string;
		readonly claimed: string;
	}[] = [];
	// Every pair of worlds is its own disconnected graph, so one query per
	// world answers them all.
	for (const fixture of CASE_RELATIONSHIP_FIXTURES) {
		const names = fixtureCaseNames(fixture);
		for (const [index, chosen] of names.entries()) {
			const real = `real/${fixture.name}/${index}`;
			const claimed = `claimed/${fixture.name}/${index}`;
			for (const prefix of [real, claimed]) {
				const graph = graphRows(fixture, prefix);
				cases.push(...graph.cases);
				edges.push(...graph.edges);
			}
			// HQ's claim: open, owned by the worker, an extension of the
			// chosen case. Its id sits outside both worlds' namespaces, since
			// several HQ graphs name a case `claim` of their own.
			const claim = `hq-claim/${fixture.name}/${index}`;
			cases.push(
				makeCaseRow({
					case_id: claim,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "commcare-case-claim",
					case_name: "claim",
					owner_id: WORKER,
				}),
			);
			edges.push({
				case_id: claim,
				ancestor_id: `${real}/${chosen}`,
				target_case_type: "test",
				identifier: "host",
				relationship: "extension",
				depth: 1,
			});
			claimedIds.push(`${claimed}/${chosen}`);
			pairs.push({
				label: `${fixture.name} claiming ${chosen}`,
				names,
				real,
				claimed,
			});
		}
	}
	await insert(db, cases, edges);

	const withClaimCases = await closure(db);
	const withClaimIds = await closure(db, claimedIds);
	for (const pair of pairs) {
		const expected = pair.names.filter((name) =>
			withClaimCases.has(`${pair.real}/${name}`),
		);
		const got = pair.names.filter((name) =>
			withClaimIds.has(`${pair.claimed}/${name}`),
		);
		expect(got, pair.label).toEqual(expected);
	}
});

test("no claims, or an empty list, is today's closure exactly", async ({
	db,
}) => {
	const cases: Insertable<CasesTable>[] = [];
	const edges: Insertable<CaseIndicesTable>[] = [];
	for (const fixture of CASE_RELATIONSHIP_FIXTURES) {
		const graph = graphRows(fixture, fixture.name);
		cases.push(...graph.cases);
		edges.push(...graph.edges);
	}
	await insert(db, cases, edges);
	const without = [...(await closure(db))].sort();
	expect([...(await closure(db, []))].sort()).toEqual(without);
	for (const fixture of CASE_RELATIONSHIP_FIXTURES) {
		const expected = fixture.outcome.map((name) => `${fixture.name}/${name}`);
		expect(
			without.filter((id) => id.startsWith(`${fixture.name}/`)).sort(),
			fixture.name,
		).toEqual([...expected].sort());
	}
});

test("a claimed case of another app or Project, or of no case, seeds nothing", async ({
	db,
	pgClient,
}) => {
	// The foreign rows bypass the tenant FK to test the closure's own fence;
	// they are rolled back with the test.
	await pgClient.query("SET CONSTRAINTS cases_project_app_tenant_fk DEFERRED");
	await insert(
		db,
		[
			makeCaseRow({
				case_id: "foreign-app",
				app_id: OTHER_APP,
				project_id: PROJECT_ID,
				owner_id: STRANGER,
			}),
			makeCaseRow({
				case_id: "foreign-project",
				app_id: APP_ID,
				project_id: OTHER_PROJECT,
				owner_id: STRANGER,
			}),
			makeCaseRow({
				case_id: "ours",
				app_id: APP_ID,
				project_id: PROJECT_ID,
				owner_id: STRANGER,
			}),
			// An extension of a foreign case: no claim may reach it.
			makeCaseRow({
				case_id: "ours-extension",
				app_id: APP_ID,
				project_id: PROJECT_ID,
				owner_id: STRANGER,
			}),
		],
		[
			{
				case_id: "ours-extension",
				ancestor_id: "foreign-app",
				target_case_type: "test",
				identifier: "host",
				relationship: "extension",
				depth: 1,
			},
		],
	);
	const held = await closure(db, [
		"foreign-app",
		"foreign-project",
		"no-such-case",
		"ours",
	]);
	// Each id is fenced on its own: the one case of this app in this Project
	// still seeds, the rest seed nothing.
	expect([...held].sort()).toEqual(["ours"]);
});

test("a closed claimed case brings nothing, nor its extensions", async ({
	db,
}) => {
	const row = (caseId: string, status: string) =>
		makeCaseRow({
			case_id: caseId,
			app_id: APP_ID,
			project_id: PROJECT_ID,
			owner_id: STRANGER,
			status,
		});
	await insert(
		db,
		[row("closed-host", "closed"), row("open-extension", "open")],
		[
			{
				case_id: "open-extension",
				ancestor_id: "closed-host",
				target_case_type: "test",
				identifier: "host",
				relationship: "extension",
				depth: 1,
			},
		],
	);
	expect([...(await closure(db, ["closed-host"]))]).toEqual([]);
	// An open extension of a closed host is unavailable: a real claim of it
	// would be too, since a closed host kills the chain.
	expect([...(await closure(db, ["open-extension"]))].sort()).toEqual([]);
});
