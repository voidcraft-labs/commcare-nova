// lib/case-store/postgres/__tests__/queryGrouped.postgres.test.ts
//
// `PostgresCaseStore.queryGrouped` against a real database, because the
// behaviour under test IS the SQL: window functions, a dense rank, and
// a page window that counts groups.
//
// Every assertion here mirrors one runtime fact:
//
//   - `commcare-core/.../util/screen/EntityScreenHelper::initEntities`
//     filters, sorts, and only THEN calls `::groupEntities`, which
//     assigns each distinct key an ordinal equal to the map size at
//     first insertion and stably re-sorts on it. So groups follow
//     first-appearance order under the user's sort, and members keep
//     their post-sort order inside a group.
//   - `formplayer/.../beans/menus/EntityListResponse::getEntitiesForCurrentPage`
//     walks adjacent keys and counts boundaries, so the window is
//     groups and a returned group is always whole.
//   - `commcare-core/.../cases/entity/NodeEntityFactory::getEntity`
//     evaluates `string(./index/<id>)` to a plain `String`, which is
//     `""` for a case carrying no such index — every one of those
//     collapses into a single group.
//
// Per-test databases, for the same reason `store.test.ts` uses them:
// `insert` calls `db.transaction()`, which Kysely lowers to a literal
// `BEGIN` that cannot nest inside the shared-transaction fixture.

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { eq, literal, prop, term } from "@/lib/domain/predicate/builders";
import { proseText } from "@/lib/domain/prose";
import { buildSimpleBlueprint } from "../../__tests__/fixtures/simpleBlueprint";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { buildCaseTypeMap } from "../../store";
import { PostgresCaseStore } from "../store";

const APP_ID = "app-grouped";
const PROJECT_ID = "project-grouped";

const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [{ name: "village", label: proseText("Village") }],
};
const VISIT: CaseType = {
	name: "visit",
	properties: [{ name: "seen_on", label: proseText("Seen on") }],
};

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "grouped_test_",
});

beforeEach(async () => {
	await dbHandle.pool.query(`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES ('${APP_ID}', 'owner-a', '${PROJECT_ID}', 'Grouped', 'grouped')
	`);
});

function makeStore(): PostgresCaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT_ID,
		actorUserId: "owner-a",
		ownerId: "owner-a",
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

const schemas = () =>
	buildCaseTypeMap(buildSimpleBlueprint([HOUSEHOLD, VISIT], APP_ID));

/**
 * Two households with two visits each, plus one visit with no
 * household at all — the shape every assertion below reads.
 *
 * Names are chosen so an alphabetical sort by name INTERLEAVES the
 * households (Ada, Ben, Cal, Dot): a clustering re-sort that merely
 * followed the sort order would leave them interleaved, so any test
 * that sorts by name and then sees whole groups is really testing the
 * clustering.
 */
async function seed(store: PostgresCaseStore): Promise<{
	north: string;
	south: string;
}> {
	await store.applySchemaChange({
		appId: APP_ID,
		caseType: "household",
		caseTypeSchemas: schemas(),
	});
	await store.applySchemaChange({
		appId: APP_ID,
		caseType: "visit",
		caseTypeSchemas: schemas(),
	});

	const { caseId: north } = await store.insert({
		appId: APP_ID,
		row: {
			case_type: "household",
			case_name: "North",
			status: "open",
			properties: { village: "North" },
		},
	});
	const { caseId: south } = await store.insert({
		appId: APP_ID,
		row: {
			case_type: "household",
			case_name: "South",
			status: "open",
			properties: { village: "South" },
		},
	});

	// Interleaved on purpose: North, South, North, South by name.
	for (const [name, parent] of [
		["Ada", north],
		["Ben", south],
		["Cal", north],
		["Dot", south],
	] as const) {
		await store.insert({
			appId: APP_ID,
			row: {
				case_type: "visit",
				case_name: name,
				status: "open",
				parent_case_id: parent,
				properties: { seen_on: name },
			},
		});
	}
	// The parentless one, which the device puts in the empty-key group.
	await store.insert({
		appId: APP_ID,
		row: {
			case_type: "visit",
			case_name: "Eve",
			status: "open",
			properties: { seen_on: "Eve" },
		},
	});
	return { north, south };
}

const byName = [
	{ direction: "asc" as const, expression: term(prop("visit", "case_name")) },
];

describe("PostgresCaseStore.queryGrouped", () => {
	it("clusters by first appearance under the user's sort", async () => {
		const store = makeStore();
		const { north, south } = await seed(store);

		const page = await store.queryGrouped({
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: schemas(),
			indexIdentifier: "parent",
			sort: byName,
			groupOffset: 0,
			groupLimit: 10,
		});

		// Ada is first by name, so North is the first group; Ben is next,
		// so South is second; Eve's empty key appears last. Members keep
		// their post-sort order inside each group, which is what makes
		// Cal follow Ada rather than sorting to the front of its own group.
		expect(
			page.groups.map((group) => ({
				key: group.key,
				names: group.rows.map((row) => row.case_name),
			})),
		).toEqual([
			{ key: north, names: ["Ada", "Cal"] },
			{ key: south, names: ["Ben", "Dot"] },
			{ key: "", names: ["Eve"] },
		]);
		expect(page.totalGroups).toBe(3);
		expect(page.totalRows).toBe(5);
	});

	it("collapses every case with no such index into one group", async () => {
		const store = makeStore();
		await seed(store);

		// Grouping by an identifier nothing carries is the empty-key
		// hazard in its purest form: one group, holding everything.
		const page = await store.queryGrouped({
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: schemas(),
			indexIdentifier: "host",
			sort: byName,
			groupOffset: 0,
			groupLimit: 10,
		});

		expect(page.groups).toHaveLength(1);
		expect(page.groups[0].key).toBe("");
		expect(page.groups[0].rows.map((row) => row.case_name)).toEqual([
			"Ada",
			"Ben",
			"Cal",
			"Dot",
			"Eve",
		]);
		expect(page.totalGroups).toBe(1);
	});

	it("pages by group, and a returned group is whole", async () => {
		const store = makeStore();
		const { north, south } = await seed(store);

		const first = await store.queryGrouped({
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: schemas(),
			indexIdentifier: "parent",
			sort: byName,
			groupOffset: 0,
			groupLimit: 1,
		});
		// One group, BOTH its rows — a page of one group is two cases.
		expect(first.groups).toHaveLength(1);
		expect(first.groups[0].key).toBe(north);
		expect(first.groups[0].rows).toHaveLength(2);
		// The denominators describe the whole matching set, not the page.
		expect(first.totalGroups).toBe(3);
		expect(first.totalRows).toBe(5);

		const second = await store.queryGrouped({
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: schemas(),
			indexIdentifier: "parent",
			sort: byName,
			groupOffset: 1,
			groupLimit: 1,
		});
		expect(second.groups.map((group) => group.key)).toEqual([south]);
		expect(second.totalGroups).toBe(3);
	});

	it("still reports the totals for a page past the end", async () => {
		const store = makeStore();
		await seed(store);

		const page = await store.queryGrouped({
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: schemas(),
			indexIdentifier: "parent",
			sort: byName,
			groupOffset: 99,
			groupLimit: 10,
		});

		// An empty page that claimed zero groups would strand a pager with
		// no way back.
		expect(page.groups).toEqual([]);
		expect(page.totalGroups).toBe(3);
		expect(page.totalRows).toBe(5);
	});

	it("applies the authored filter before grouping", async () => {
		const store = makeStore();
		const { north } = await seed(store);

		const page = await store.queryGrouped({
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: schemas(),
			indexIdentifier: "parent",
			predicate: eq(prop("visit", "seen_on"), literal("Ada")),
			sort: byName,
			groupOffset: 0,
			groupLimit: 10,
		});

		// A group's membership is a fact about the FILTERED set: North
		// holds one visit here, not two.
		expect(page.groups).toEqual([expect.objectContaining({ key: north })]);
		expect(page.groups[0].rows.map((row) => row.case_name)).toEqual(["Ada"]);
		expect(page.totalGroups).toBe(1);
		expect(page.totalRows).toBe(1);
	});

	it("orders the same way an ungrouped read does when nothing is sorted", async () => {
		const store = makeStore();
		await seed(store);

		const grouped = await store.queryGrouped({
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: schemas(),
			indexIdentifier: "parent",
			groupOffset: 0,
			groupLimit: 10,
		});
		const flat = await store.query({ appId: APP_ID, caseType: "visit" });

		// The grouped read repeats the durable default ordering in window
		// syntax rather than sharing the `orderBy` chain, so this pins that
		// the two say the same thing: the first row of the first group is
		// the first row of the flat list.
		expect(grouped.groups[0].rows[0].case_id).toBe(flat[0].case_id);
		expect(grouped.totalRows).toBe(flat.length);
	});

	it("counts the cases that carry no such index", async () => {
		const store = makeStore();
		await seed(store);

		// Exactly one visit has no household: the number the authoring
		// surface shows beside "these all group together".
		expect(
			await store.count({
				appId: APP_ID,
				caseType: "visit",
				missingIndexIdentifier: "parent",
			}),
		).toBe(1);

		// An identifier nothing carries measures the whole population,
		// which is the honest answer rather than zero.
		expect(
			await store.count({
				appId: APP_ID,
				caseType: "visit",
				missingIndexIdentifier: "host",
			}),
		).toBe(5);
	});

	it("returns rows shaped exactly like an ungrouped read", async () => {
		const store = makeStore();
		await seed(store);

		const grouped = await store.queryGrouped({
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: schemas(),
			indexIdentifier: "parent",
			sort: byName,
			groupOffset: 0,
			groupLimit: 10,
		});
		const row = grouped.groups[0].rows[0];

		// The window bookkeeping is stripped, the tenant key is stripped,
		// and `calculated` is present and empty — the same contract
		// `query` returns.
		expect(row.calculated).toEqual({});
		for (const key of [
			"__nova_group_key",
			"__nova_row_ordinal",
			"__nova_group_first",
			"__nova_group_ordinal",
			"__nova_total_groups",
			"__nova_total_rows",
			"project_id",
		]) {
			expect(Object.hasOwn(row, key)).toBe(false);
		}
	});
});
