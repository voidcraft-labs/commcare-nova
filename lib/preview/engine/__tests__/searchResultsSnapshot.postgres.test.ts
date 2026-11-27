// lib/preview/engine/__tests__/searchResultsSnapshot.postgres.test.ts
//
// What a completed search returns to the forms of its search-first module,
// against real Postgres through the helper the Server Action calls
// (`readSearchResultsSnapshot`).
//
// HQ's case search finds the Project's open cases of the module's type, bound
// by no restore, and sends a device at most 500 of them
// (`case_search/utils.py::CaseSearchQueryBuilder._get_initial_search_es`,
// `case_search/const.py::CASE_SEARCH_MAX_RESULTS`). The snapshot is that read
// without a page window: every match up to the cap, and how many matched.

import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { buildCaseTypeMap, type CaseStore } from "@/lib/case-store";
import { checkParentPathLookupLimit } from "@/lib/case-store/postgres/nativeSearchMatching";
import {
	PostgresCaseStore,
	type PostgresCaseStoreArgs,
} from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import type {
	CaseSearchCriterion,
	CaseSearchRequest,
} from "@/lib/case-store/searchRequest";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import { SEARCH_RESULTS_CAP } from "@/lib/commcare/session";
import type { CaseType, SearchInputDef } from "@/lib/domain";
import { caseClaimCaseType } from "@/lib/domain/caseClaim";
import {
	eq,
	gt,
	literal,
	match,
	not,
	prop,
	term,
} from "@/lib/domain/expression/builders";
import { SEARCH_READING } from "@/lib/domain/expression/temporalType";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedPreviewDoc } from "../../__tests__/fixtures/admittedDoc";
import { readCases } from "../caseDataBindingHelpers";
import { completedSearchRequest } from "../completedSearchRequest";
import { readSearchResultsSnapshot } from "../searchResultsSnapshot";

const APP_ID = "app-search-results";
const PROJECT = "project-search-results";
const WORKER = "worker-searching";
const OTHER_WORKER = "worker-other";
const EXCLUDED_WORKER = "worker-excluded";

const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [
		{ name: "village", label: proseText("Village") },
		{ name: "stops", label: proseText("Stops"), data_type: "multi_select" },
	],
};
const PATIENT: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "district", label: proseText("District") },
		{ name: "village", label: proseText("Village") },
	],
};

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "search_results_",
});

function storeAs(
	ownerId: string,
	readSearchConfiguration?: PostgresCaseStoreArgs["readSearchConfiguration"],
): CaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT,
		readSearchConfiguration,
		actorUserId: WORKER,
		ownerId,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

function patient(caseId: string, status = "open", parent?: string) {
	return {
		appId: APP_ID,
		row: {
			case_id: caseId,
			case_type: "patient",
			case_name: caseId,
			status,
			properties: { district: "north" },
			...(parent === undefined ? {} : { parent_case_id: parent }),
		},
	};
}

async function parkHouseholdVillage(caseId: string) {
	await sql`insert into parked_case_values
		(app_id, case_id, case_type, property, original_value, reason, from_type, to_type)
		values (${APP_ID}, ${caseId}, 'household', 'village', '"Old value"'::jsonb, 'schema change', 'text', 'select-one')`.execute(
		dbHandle.db,
	);
}

async function dismissHouseholdPark(caseId: string) {
	await sql`update parked_case_values set dismissed_at = now()
		where app_id = ${APP_ID} and case_id = ${caseId}`.execute(dbHandle.db);
}

beforeEach(async () => {
	await sql`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES (${APP_ID}, ${WORKER}, ${PROJECT}, 'Search results', 'search results')
	`.execute(dbHandle.db);
	const doc = assertAdmittedPreviewDoc(
		buildDoc({
			appId: APP_ID,
			caseTypes: [HOUSEHOLD, PATIENT],
			modules: [HOUSEHOLD, PATIENT].map((type) => ({
				name: type.name,
				caseType: type.name,
				caseListMenuItem: {},
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [],
			})),
		}),
	);
	const mine = storeAs(WORKER);
	for (const type of [HOUSEHOLD, PATIENT])
		await mine.applySchemaChange({
			appId: APP_ID,
			caseType: type.name,
			caseTypeSchemas: buildCaseTypeMap(doc),
		});
});

const SEARCH = {
	appId: APP_ID,
	caseType: "patient",
	reading: SEARCH_READING,
	tileGrouping: "grouped",
	searchPopulation: { heldBy: { ownerIds: [WORKER] } },
} as const;

describe("a completed search's snapshot", () => {
	it("holds every open match, past one page, and none closed", async () => {
		const mine = storeAs(WORKER);
		for (let index = 0; index < 60; index += 1)
			await mine.insert(patient(`p-${String(index).padStart(3, "0")}`));
		await mine.insert(patient("p-closed", "closed"));

		const snapshot = await readSearchResultsSnapshot(mine, SEARCH);
		expect(snapshot.rows).toHaveLength(60);
		expect(snapshot.totalMatches).toBe(60);
		expect(snapshot.rows.some((row) => row.case_id === "p-closed")).toBe(false);
	});

	// One insert statement and one read, inside the default five seconds: the
	// test above, sixty-one store writes and a read, takes under one in CI.
	// Writing the cap's 501 rows through the store, one validated transaction
	// each, took fourteen. This test is about the read's cap, not how a row is
	// written, so the rows go straight to the table.
	it("certifies server membership before display order, inline filtering, paging and form reads", async () => {
		const opened = new Date("2026-05-02T12:00:00Z");
		await (dbHandle.db as unknown as Kysely<Database>)
			.insertInto("cases")
			.values(
				Array.from({ length: SEARCH_RESULTS_CAP + 1 }, (_, index) => {
					const caseId = `p-${String(index).padStart(4, "0")}`;
					return {
						case_id: caseId,
						case_name: caseId,
						case_type: "patient",
						app_id: APP_ID,
						project_id: PROJECT,
						owner_id: WORKER,
						status: "open",
						opened_on: opened,
						modified_on: opened,
						properties: JSON.stringify({
							district: index === SEARCH_RESULTS_CAP - 1 ? "south" : "north",
							priority: String(index),
						}),
					};
				}),
			)
			.execute();

		const store = storeAs(WORKER);
		await expect(
			readSearchResultsSnapshot(store, SEARCH),
		).rejects.toMatchObject({
			reason: { kind: "cutoff-order-unavailable" },
		});
		const schema = new Map([[PATIENT.name, PATIENT]]);
		const request = {
			maximum: SEARCH_RESULTS_CAP,
			order: [
				{
					key: "case_name",
					direction: "asc",
					type: "text",
				},
			],
			resultCondition: not(eq(prop("patient", "district"), literal("south"))),
		} as const;
		const query = {
			...SEARCH,
			caseTypeSchemas: schema,
			searchPopulation: { ...SEARCH.searchPopulation, request },
		};
		expect(await store.count(query)).toBe(499);
		expect(
			(await store.query({ ...query, offset: 498, limit: 2 })).map(
				(r) => r.case_id,
			),
		).toEqual(["p-0498"]);
		expect(
			await readCases(store, {
				...query,
				searchPopulation: {
					...query.searchPopulation,
					request: { ...request, resultCondition: { kind: "match-none" } },
				},
				page: { offset: 0, limit: 2 },
			}),
		).toMatchObject({ kind: "empty", searchMatchCount: 500 });
		const snapshot = await readSearchResultsSnapshot(store, query);
		expect(snapshot.totalMatches).toBe(500);
		expect(snapshot.rows.at(-1)?.case_id).toBe("p-0499");
		expect(snapshot.rows.some((row) => row.case_id === "p-0500")).toBe(false);
		// The same raw strings have different last keys when sorted as numbers and text.
		for (const [type, omitted] of [
			["number", "p-0500"],
			["text", "p-0099"],
		] as const) {
			const ranked = await readSearchResultsSnapshot(store, {
				...query,
				searchPopulation: {
					...query.searchPopulation,
					request: {
						maximum: SEARCH_RESULTS_CAP,
						order: [{ type, direction: "asc", key: "priority" }],
					},
				},
			});
			expect(ranked.rows).toHaveLength(SEARCH_RESULTS_CAP);
			expect(ranked.rows.some((row) => row.case_id === omitted)).toBe(false);
		}

		expect(
			(
				await readSearchResultsSnapshot(store, {
					...query,
					searchPopulation: {
						...SEARCH.searchPopulation,
						request: { maximum: 1500 },
					},
				})
			).rows,
		).toHaveLength(501);
		const tied = {
			...query,
			searchPopulation: {
				...SEARCH.searchPopulation,
				request: { maximum: 500 } as const,
			},
		};
		for (const id of ["p-0499", "p-0500"])
			await store.update({
				appId: APP_ID,
				caseId: id,
				patch: { status: "closed" },
			});
		expect(await store.count(tied)).toBe(499);
		await expect(
			store.query({
				...tied,
				searchPopulation: {
					...SEARCH.searchPopulation,
					request: { maximum: 500, readsHitScore: true },
				},
			}),
		).rejects.toMatchObject({ reason: { kind: "hit-score-unavailable" } });
	});

	it("holds a case outside the worker's restore and drops an excluded owner's", async () => {
		await storeAs(WORKER).insert(patient("p-mine"));
		await storeAs(OTHER_WORKER).insert(patient("p-theirs"));
		await storeAs(EXCLUDED_WORKER).insert(patient("p-excluded"));

		const snapshot = await readSearchResultsSnapshot(storeAs(WORKER), {
			...SEARCH,
			excludedOwnerIds: [EXCLUDED_WORKER],
		});
		expect(snapshot.rows.map((row) => row.case_id).sort()).toEqual([
			"p-mine",
			"p-theirs",
		]);
		expect(snapshot.totalMatches).toBe(2);
	});

	it("carries each case's direct indices and its dates as plain text", async () => {
		const mine = storeAs(WORKER);
		await mine.insert({
			appId: APP_ID,
			row: {
				case_id: "h-1",
				case_type: "household",
				case_name: "Household",
				status: "open",
				properties: {},
			},
		});
		await mine.insert(patient("p-child", "open", "h-1"));

		const snapshot = await readSearchResultsSnapshot(mine, SEARCH);
		const [row] = snapshot.rows;
		expect(row?.indices).toEqual([
			{
				identifier: "parent",
				ancestor_id: "h-1",
				target_case_type: "household",
				relationship: "child",
			},
		]);
		// Plain JSON, as every case-data Server Action's result is.
		expect(typeof row?.opened_on).toBe("string");
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
	});

	// HQ's own proof (`proof/hq/test_case_search.py::
	// test_ordered_server_keys_choose_matches_after_excluding_named_owners`)
	// runs these cases through HQ's index: the same orders and exclusion give
	// the same primary ids in the same order here.
	it("orders the server's matches by each key in turn after leaving out the named owners", async () => {
		const store = storeAs(WORKER, async () => ({
			revision: "settings",
			maximum: 500,
			timeZone: "UTC",
			projectSpace: "clinic",
			matcherFor: () => ({ fuzzy: false, ignoreLiterals: [] }),
		}));
		const cases = [
			["none", "blue", "absent", "2024-06-12"],
			["two-early", "blue", "2", "2024-01-03"],
			["two-late", "blue", "2", "2024-09-03"],
			["ten", "blue", "10", "2023-01-03"],
			["excluded-a", "red", "1", "2024-01-01"],
			["excluded-b", "gold", "3", "2024-01-02"],
		] as const;
		// Straight to the table: the rows' owners differ, and the store writes
		// its own worker as owner.
		const opened = new Date("2024-01-01T00:00:00Z");
		await (dbHandle.db as unknown as Kysely<Database>)
			.insertInto("cases")
			.values(
				cases.map(([id, owner, priority, visit]) => ({
					case_id: id,
					case_name: id,
					case_type: "patient",
					app_id: APP_ID,
					project_id: PROJECT,
					owner_id: owner,
					status: "open",
					opened_on: opened,
					modified_on: opened,
					properties: JSON.stringify({ district: "north", priority, visit }),
				})),
			)
			.execute();
		const exclude = {
			field: "Owners to leave out",
			key: "commcare_blacklisted_owner_ids",
			target: { kind: "excluded-owners", placement: "search-setting" },
			values: ["red gold"],
		} as const;
		const ordered = async (
			order: CaseSearchRequest["order"],
			parameters: CaseSearchRequest["parameters"] = [exclude],
		) =>
			(
				await store.readSearchResultInstance({
					...SEARCH,
					caseTypeSchemas: new Map([[PATIENT.name, PATIENT]]),
					searchPopulation: {
						...SEARCH.searchPopulation,
						request: {
							maximum: 500,
							configuration: { revision: "settings" },
							parameters,
							order,
						},
					},
				})
			).primaryIds;
		const first = {
			key: "priority",
			type: "number",
			direction: "asc",
		} as const;
		const second = { key: "visit", type: "date", direction: "desc" } as const;
		expect(await ordered([first, second])).toEqual([
			"none",
			"two-late",
			"two-early",
			"ten",
		]);
		expect(await ordered([second, first])).toEqual([
			"two-late",
			"none",
			"two-early",
			"ten",
		]);
		expect(
			await ordered([
				{ key: "priority", type: "text", direction: "asc" },
				second,
			]),
		).toEqual(["ten", "two-late", "two-early", "none"]);
		expect([...(await ordered([first, second], []))].sort()).toEqual(
			cases.map(([id]) => id).sort(),
		);
	});

	it("returns the selected destination’s day, literal matcher and distinct supporting case", async () => {
		const store = storeAs(WORKER, async () => ({
			revision: "settings",
			maximum: 500,
			timeZone: "America/New_York",
			projectSpace: "clinic",
			matcherFor: () => ({ fuzzy: false, ignoreLiterals: ["!"] }),
		}));
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: "parent",
				case_type: "household",
				case_name: "Home",
				status: "closed",
				properties: { village: "North" },
			},
		});
		const times = {
			before: "2024-03-10T04:59:59Z",
			start: "2024-03-10T05:00:00Z",
			midnight: "2024-03-11T04:00:00Z",
			overlap: "2024-03-11T04:30:00Z",
			end: "2024-03-11T05:00:00Z",
		};
		for (const [id, instant] of Object.entries(times)) {
			const sample = patient(id, "open", "parent");
			await store.insert({
				...sample,
				row: { ...sample.row, opened_on: new Date(instant) },
			});
		}
		const day = term({
			kind: "literal",
			value: "2024-03-10",
			data_type: "date",
		});
		const metadata = prop("patient", "date_opened");
		const request = {
			maximum: 500,
			configuration: { revision: "settings" },
			relatedPaths: [["parent"]],
			parameters: [
				{
					field: "District",
					key: "district",
					target: { kind: "property", property: "district" },
					values: ["no!rth"],
				},
			],
		} as const;
		const args = {
			...SEARCH,
			caseTypeSchemas: new Map([
				[PATIENT.name, PATIENT],
				[HOUSEHOLD.name, HOUSEHOLD],
			]),
			searchPopulation: { ...SEARCH.searchPopulation, request },
		};
		const found = await store.readSearchResultInstance({
			...args,
			predicate: eq(metadata, day),
		});
		expect([...found.primaryIds].sort()).toEqual([
			"midnight",
			"overlap",
			"start",
		]);
		expect(found.rows.at(-1)).toMatchObject({
			case_id: "parent",
			status: "closed",
		});
		expect(
			[
				...(
					await store.readSearchResultInstance({
						...args,
						predicate: gt(metadata, day),
					})
				).primaryIds,
			].sort(),
		).toEqual(["end", "overlap"]);
		const view = await readSearchResultsSnapshot(store, args);
		expect(view.totalMatches).toBe(5);
		expect(view.rows.at(-1)).toMatchObject({
			case_id: "parent",
			status: "closed",
			properties: { commcare_is_related_case: "true" },
		});
		await expect(
			store.query({
				...args,
				searchPopulation: {
					...args.searchPopulation,
					request: { ...request, configuration: { revision: "previous" } },
				},
			}),
		).rejects.toMatchObject({ reason: { kind: "search-settings-changed" } });
	});

	it("matches a typed parent Search prompt using the destination rule for its exact request key", async () => {
		let fuzzy = false;
		const store = storeAs(WORKER, async () => ({
			revision: "settings",
			maximum: 500,
			timeZone: "UTC",
			projectSpace: "clinic",
			matcherFor: (key) =>
				key === "parent/village" ? { fuzzy, ignoreLiterals: ["!"] } : null,
		}));
		const parent: SearchInputDef = {
			uuid: testUuid("parent-village"),
			name: "parent_village",
			label: "Parent village",
			kind: "simple",
			type: "text",
			property: "village",
			matching: "project-space",
			via: { kind: "ancestor", via: [{ identifier: "parent" }] },
		};
		for (const [caseId, value] of [
			["target-house", "Dyer's crossing"],
			["other-house", "North"],
		] as const) {
			await storeAs(OTHER_WORKER).insert({
				appId: APP_ID,
				row: {
					case_id: caseId,
					case_type: "household",
					case_name: caseId,
					status: "closed",
					properties: { village: value },
				},
			});
		}
		for (const [caseId, relationship, ownValue] of [
			["linked", "target-house", "South"],
			["own-value", "other-house", "Dyer's crossing"],
			["unlinked", undefined, "Dyer's crossing"],
		] as const) {
			await store.insert(patient(caseId, "open", relationship));
			await sql`update cases set properties = properties || jsonb_build_object('village', ${ownValue}::text)
				where case_id = ${caseId} and app_id = ${APP_ID} and project_id = ${PROJECT}`.execute(
				dbHandle.db,
			);
		}
		const config = caseListConfig([{ field: "case_name", header: "Name" }]);
		config.searchInputs = [parent];
		const read = (answer: string) => {
			const request = completedSearchRequest(
				{ caseListConfig: config },
				new Map([[parent.name, answer]]),
				undefined,
				{ revision: "settings" },
			);
			return readSearchResultsSnapshot(store, {
				...SEARCH,
				searchPopulation: { ...SEARCH.searchPopulation, request },
			});
		};
		const found = await read("Dyer's cross!ing");
		expect(found.rows.map((row) => row.case_id)).toEqual(["linked"]);
		await expect(read('Dyer"s crossing')).rejects.toMatchObject({
			reason: { kind: "query-value-invalid", field: "Parent village" },
		});
		fuzzy = true;
		await expect(read("Dyer's crossing")).rejects.toMatchObject({
			reason: { kind: "parent-fuzzy-unavailable", field: "Parent village" },
		});
		fuzzy = false;
		await parkHouseholdVillage("target-house");
		await expect(read("Dyer's crossing")).rejects.toMatchObject({
			reason: { kind: "parent-value-unavailable", field: "Parent village" },
		});
		await dismissHouseholdPark("target-house");
		expect(
			(await read("Dyer's crossing")).rows.map((row) => row.case_id),
		).toEqual(["linked"]);
		await sql`insert into case_indices(case_id, ancestor_id, identifier, depth, relationship, target_case_type)
			values ('unlinked', 'unresolved-house', 'parent', 1, 'child', 'household')`.execute(
			dbHandle.db,
		);
		await expect(read("Dyer's crossing")).rejects.toMatchObject({
			reason: { kind: "parent-value-unavailable", field: "Parent village" },
		});
	});

	it.each([2, 3])("reads %i parent links in Preview", async (hops) => {
		const prefix = "parent/".repeat(hops);
		const label =
			hops === 2 ? "Grandparent village" : "Great-grandparent village";
		const store = storeAs(WORKER, async () => ({
			revision: "exact",
			maximum: 500,
			timeZone: "UTC",
			projectSpace: "clinic",
			matcherFor: (key) =>
				key === `${prefix}village`
					? { fuzzy: false, ignoreLiterals: ["!"] }
					: key === `${prefix}stops`
						? { fuzzy: false, ignoreLiterals: [] }
						: null,
		}));
		const grandparent: SearchInputDef = {
			uuid: testUuid("grandparent-village"),
			name: `${prefix.replaceAll("/", "_")}village`,
			label,
			kind: "simple",
			type: "text",
			property: "village",
			matching: "project-space",
			via: {
				kind: "ancestor",
				via: [
					{ identifier: "parent" },
					{ identifier: "parent" },
					...(hops === 3 ? [{ identifier: "parent" }] : []),
				],
			},
		};
		for (const [caseId, village] of [
			["target-house", "North"],
			["other-house", "South"],
			["matching-middle", "South"],
			["other-middle", "North"],
			["matching-lower", "South"],
			["other-lower", "South"],
		] as const)
			await storeAs(OTHER_WORKER).insert({
				appId: APP_ID,
				row: {
					case_id: caseId,
					case_type: "household",
					case_name: caseId,
					status: "closed",
					properties: {
						village,
						...(caseId === "target-house" ? { stops: ["east", "west"] } : {}),
					},
				},
			});
		const edge = (caseId: string, target: string) =>
			sql`insert into case_indices(case_id, ancestor_id, identifier, depth, relationship, target_case_type)
				values (${caseId}, ${target}, 'parent', 1, 'child', 'household')`.execute(
				dbHandle.db,
			);
		await edge("matching-middle", "target-house");
		await edge("other-middle", "other-house");
		await edge("matching-lower", "matching-middle");
		await edge("other-lower", "other-middle");
		for (const [id, related] of [
			["nested", hops === 2 ? "matching-middle" : "matching-lower"],
			["direct", "target-house"],
			["wrong-terminal", hops === 2 ? "other-middle" : "other-lower"],
			["unlinked", undefined],
		] as const)
			await store.insert(patient(id, "open", related));
		const config = caseListConfig([{ field: "case_name", header: "Name" }]);
		const stops: SearchInputDef = {
			...grandparent,
			uuid: testUuid("grandparent-stops"),
			name: `${prefix.replaceAll("/", "_")}stops`,
			label: "Ancestor stops",
			property: "stops",
		};
		config.searchInputs = [grandparent, stops];
		const read = (answer: string, input: SearchInputDef = grandparent) =>
			readSearchResultsSnapshot(store, {
				...SEARCH,
				searchPopulation: {
					...SEARCH.searchPopulation,
					request: completedSearchRequest(
						{ caseListConfig: config },
						new Map([[input.name, answer]]),
						undefined,
						{ revision: "exact" },
					),
				},
			});
		const found = await read("No!rth");
		expect(found.rows.map((row) => row.case_id)).toEqual(["nested"]);
		expect(await read("Missing")).toEqual({ rows: [], totalMatches: 0 });
		expect(
			(await read("east west", stops)).rows.map((row) => row.case_id),
		).toEqual(["nested"]);
		expect(await read("west east", stops)).toEqual({
			rows: [],
			totalMatches: 0,
		});

		const unavailable = {
			reason: {
				kind: "parent-value-unavailable",
				field: label,
			},
		};
		await parkHouseholdVillage("matching-middle");
		await expect(read("North")).rejects.toMatchObject(unavailable);
		await dismissHouseholdPark("matching-middle");
		expect((await read("North")).rows.map((row) => row.case_id)).toEqual([
			"nested",
		]);

		await parkHouseholdVillage("target-house");
		await expect(read("North")).rejects.toMatchObject(unavailable);
		await dismissHouseholdPark("target-house");
		expect((await read("North")).rows.map((row) => row.case_id)).toEqual([
			"nested",
		]);

		await edge("unlinked", "unknown-first");
		await expect(read("North")).rejects.toMatchObject(unavailable);
		await sql`delete from case_indices where case_id = 'unlinked' and ancestor_id = 'unknown-first'`.execute(
			dbHandle.db,
		);
		if (hops === 3) {
			await edge("other-lower", "unknown-second");
			await expect(read("North")).rejects.toMatchObject(unavailable);
			await sql`delete from case_indices where case_id = 'other-lower' and ancestor_id = 'unknown-second'`.execute(
				dbHandle.db,
			);
		}
		await edge("other-middle", "unknown-terminal");
		await expect(read("North")).rejects.toMatchObject(unavailable);
	});

	it("refuses a truncated reverse-link lookup and counts each intermediate record once", async () => {
		const store = storeAs(OTHER_WORKER);
		for (const [caseId, village] of [
			["terminal-one", "North"],
			["terminal-two", "North"],
			["middle-one", "South"],
			["middle-two", "South"],
			["unrelated", "South"],
			["lower-one", "South"],
			["lower-two", "South"],
		]) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: caseId,
					case_type: "household",
					case_name: caseId,
					status: "open",
					properties: {
						village,
						stops: village === "North" ? ["east", "west"] : ["west"],
					},
				},
			});
		}
		await sql`insert into case_indices(case_id, ancestor_id, identifier, depth, relationship, target_case_type)
			values ('middle-one', 'terminal-one', 'parent', 1, 'child', 'household'),
				('middle-one', 'terminal-two', 'parent', 1, 'child', 'household'),
				('middle-two', 'terminal-two', 'parent', 1, 'child', 'household'),
				('unrelated', 'terminal-one', 'other', 1, 'child', 'household')`.execute(
			dbHandle.db,
		);
		const criterion: Extract<CaseSearchCriterion, { kind: "native" }> = {
			kind: "native",
			fuzzy: false,
			parameter: {
				field: "Grandparent stops",
				key: "parent/parent/stops",
				parentPathPrompt: true,
				target: {
					kind: "property",
					property: "stops",
					ancestors: [{ identifier: "parent" }, { identifier: "parent" }],
				},
				values: ["east west"],
			},
		};
		const check = (
			terminal: number,
			intermediate: number,
			reverseTerms = 2,
			path = criterion,
		) =>
			checkParentPathLookupLimit(
				path,
				{
					db: dbHandle.db as unknown as Kysely<Database>,
					appId: APP_ID,
					projectId: PROJECT,
				},
				{ terminal, intermediate, reverseTerms },
			);
		await expect(check(2, 2)).resolves.toBeUndefined();
		await expect(check(2, 1)).rejects.toMatchObject({
			reason: { kind: "parent-lookup-limit", field: "Grandparent stops" },
		});
		await expect(check(1, 2)).rejects.toMatchObject({
			reason: { kind: "parent-lookup-limit", field: "Grandparent stops" },
		});
		const overLimit = {
			reason: { kind: "parent-lookup-limit", field: "Grandparent stops" },
		};
		await expect(check(2, 2, 1)).rejects.toMatchObject(overLimit);
		// One qualifying terminal fits the terms limit, but its two matching
		// reverse links still exceed that limit on the intermediate set.
		await sql`update cases set properties = properties || '{"stops":["west","east"]}'::jsonb
			where app_id = ${APP_ID} and project_id = ${PROJECT} and case_id = 'terminal-two'`.execute(
			dbHandle.db,
		);
		await sql`insert into case_indices(case_id, ancestor_id, identifier, depth, relationship, target_case_type)
			values ('middle-two', 'terminal-one', 'parent', 1, 'child', 'household')`.execute(
			dbHandle.db,
		);
		await expect(check(2, 2, 1)).rejects.toMatchObject(overLimit);

		await sql`delete from case_indices where case_id = 'middle-two' and ancestor_id = 'terminal-one'`.execute(
			dbHandle.db,
		);
		await sql`insert into case_indices(case_id, ancestor_id, identifier, depth, relationship, target_case_type)
			values ('lower-one', 'middle-one', 'parent', 1, 'child', 'household'),
				('lower-two', 'middle-one', 'parent', 1, 'child', 'household')`.execute(
			dbHandle.db,
		);
		const threeLinks: typeof criterion = {
			...criterion,
			parameter: {
				...criterion.parameter,
				key: "parent/parent/parent/stops",
				target: {
					kind: "property",
					property: "stops",
					ancestors: [
						{ identifier: "parent" },
						{ identifier: "parent" },
						{ identifier: "parent" },
					],
				},
			},
		};
		await expect(check(2, 1, 2)).resolves.toBeUndefined();
		await expect(check(2, 1, 2, threeLinks)).rejects.toMatchObject(overLimit);
		await expect(check(2, 2, 2, threeLinks)).resolves.toBeUndefined();
	});

	it("decides a fuzzy search condition from the Project's own words", async () => {
		// "smith" reaches two stored words ("smith" exactly, "smyth" one edit
		// past the shared "sm"), far below HQ's 100 expansions, so both
		// records match and the third is certainly left out
		// (`proof/hq/fixtures/similar-match-vectors.json` holds HQ's answers).
		const store = storeAs(WORKER);
		for (const [id, district] of [
			["exact", "North Smith"],
			["near", "North Smyth"],
			["other", "East Jones"],
		]) {
			const row = patient(id);
			await store.insert({
				...row,
				row: { ...row.row, properties: { district } },
			});
		}
		const args = {
			...SEARCH,
			caseTypeSchemas: new Map([[PATIENT.name, PATIENT]]),
			searchPopulation: {
				...SEARCH.searchPopulation,
				request: { maximum: 500 as const },
			},
		};
		const similar = match(prop("patient", "district"), "smith", "fuzzy");
		expect(
			(await store.query({ ...args, predicate: similar }))
				.map((r) => r.case_id)
				.sort(),
		).toEqual(["exact", "near"]);
		expect(
			(await store.query({ ...args, predicate: not(similar) })).map(
				(r) => r.case_id,
			),
		).toEqual(["other"]);
	});

	it("matches each candidate's own related record", async () => {
		const store = storeAs(WORKER, async () => ({
			revision: "exact",
			maximum: 500,
			timeZone: "UTC",
			projectSpace: "clinic",
			matcherFor: () => ({ fuzzy: false, ignoreLiterals: [] }),
		}));
		for (const village of ["north", "south"]) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: village,
					case_type: "household",
					case_name: village,
					status: "open",
					properties: { village },
				},
			});
			await store.insert(patient("child-" + village, "open", village));
		}
		await store.insert(patient("without-parent"));
		const request: CaseSearchRequest = {
			maximum: 500,
			configuration: { revision: "exact" },
			parameters: [
				{
					field: "Parent village",
					key: "parent/village",
					target: {
						kind: "property",
						property: "village",
						ancestors: [{ identifier: "parent" }],
					},
					values: ["north"],
				},
			],
		};
		const read = await store.readSearchResultInstance({
			...SEARCH,
			searchPopulation: { ...SEARCH.searchPopulation, request },
		});
		expect(read.primaryIds).toEqual(["child-north"]);
	});

	it("keeps only the record of a no-match registration in the form’s result instance", async () => {
		const mine = storeAs(WORKER);
		await mine.insert(patient("previous"));
		await mine.insert(patient("registered"));
		const result = await readSearchResultsSnapshot(mine, {
			...SEARCH,
			caseIds: ["registered"],
		});
		expect(result.rows.map((row) => row.case_id)).toEqual(["registered"]);
	});

	it("keeps a stored search score on the restore and the native related tag on a primary hit", async () => {
		const store = storeAs(WORKER);
		// The app stores its own properties under the two names HQ's search also writes.
		const stored: CaseType = {
			...PATIENT,
			properties: [
				...PATIENT.properties,
				{ name: "commcare_search_score", label: proseText("Score") },
				{ name: "commcare_is_related_case", label: proseText("Related") },
			],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: PATIENT.name,
			caseTypeSchemas: new Map([
				[HOUSEHOLD.name, HOUSEHOLD],
				[PATIENT.name, stored],
			]),
		});
		const ordinary = patient("ordinary");
		await store.insert({
			...ordinary,
			row: {
				...ordinary.row,
				properties: {
					district: "north",
					commcare_search_score: "author score",
				},
			},
		});
		const tagged = patient("tagged");
		await store.insert({
			...tagged,
			row: {
				...tagged.row,
				properties: { district: "north", commcare_is_related_case: "false" },
			},
		});
		const request = { maximum: 500 } as const;
		const query = {
			...SEARCH,
			searchPopulation: { ...SEARCH.searchPopulation, request },
		};
		expect((await store.query(query)).map((r) => r.case_id)).toEqual([
			"ordinary",
		]);
		const returned = await readSearchResultsSnapshot(store, query);
		expect(returned.totalMatches).toBe(2);
		expect(
			returned.rows.find((r) => r.case_id === "ordinary")?.properties,
		).not.toHaveProperty("commcare_search_score");
		expect(
			(
				await store.readDeviceCaseDatabase({
					appId: APP_ID,
					restoreScope: { ownerIds: [WORKER] },
				})
			).rows.find((r) => r.case_id === "ordinary")?.properties
				.commcare_search_score,
		).toBe("author score");
		await expect(
			readSearchResultsSnapshot(store, query, true),
		).rejects.toMatchObject({ reason: { kind: "hit-score-unavailable" } });
	});

	it("is empty for a search that finds nothing", async () => {
		const snapshot = await readSearchResultsSnapshot(storeAs(WORKER), SEARCH);
		expect(snapshot).toEqual({ rows: [], totalMatches: 0 });
	});
	it("keeps request-only primary records, dynamically related records and the terminal of a closed path distinct", async () => {
		const store = storeAs(WORKER);
		const rows = [
			["patient-a", "patient", "open", "care-a"],
			["house-a", "household", "open", null],
			["file-a", "document", "open", "extension-seed"],
			["extension-host", "episode", "open", null],
			["extension-seed", "episode", "closed", null],
			["extension-leaf", "episode", "open", null],
			["care-a", "episode", "closed", null],
			["middle", "group", "closed", null],
			["last", "region", "closed", null],
			["child", "visit", "closed", null],
			["non-parent", "visit", "open", null],
			["second-child", "task", "closed", null],
			["ignored-child", "note", "closed", null],
		] as const;
		for (const [id, type, status, source] of rows) {
			await sql`insert into cases(app_id, project_id, case_id, case_type, case_name, status, properties)
				values (${APP_ID},${PROJECT},${id},${type},${id},${status},${JSON.stringify(source ? { care_record: source } : {})}::jsonb)`.execute(
				dbHandle.db,
			);
		}
		// Edges created by old imports can cross an app or Project. Each
		// fixture uses a physical case inside its own authorized app tuple.
		await sql`insert into apps(id, owner, project_id, app_name, app_name_lower)
			values ('elsewhere-app', ${OTHER_WORKER}, 'elsewhere', 'Elsewhere', 'elsewhere'),
				('other-app', ${OTHER_WORKER}, ${PROJECT}, 'Other app', 'other app')`.execute(
			dbHandle.db,
		);
		await sql`insert into cases(app_id,project_id,case_id,case_type,case_name,status,properties)
			values ('elsewhere-app','elsewhere','private','visit','Private','open','{}'::jsonb),
				('other-app',${PROJECT},'other-app-case','visit','Other app case','open','{}'::jsonb)`.execute(
			dbHandle.db,
		);
		for (const [child, ancestor, name, type, relationship = "child"] of [
			["care-a", "middle", "parent", "group"],
			["extension-seed", "extension-host", "host", "episode", "extension"],
			["extension-leaf", "extension-seed", "host", "episode", "extension"],
			["middle", "last", "parent", "region"],
			["child", "care-a", "parent", "episode"],
			["second-child", "patient-a", "parent", "patient"],
			["ignored-child", "patient-a", "parent", "patient"],
			["non-parent", "care-a", "mentor", "episode"],
			["private", "patient-a", "parent", "patient"],
			["other-app-case", "patient-a", "parent", "patient"],
		]) {
			await sql`insert into case_indices(case_id,ancestor_id,identifier,depth,relationship,target_case_type)
				values (${child},${ancestor},${name},1,${relationship},${type})`.execute(
				dbHandle.db,
			);
		}
		const parentColumn = caseListConfig([
			{ field: "case_name", header: "Region" },
		]);
		parentColumn.columns[0] = {
			...parentColumn.columns[0],
			kind: "plain",
			field: "case_name",
			via: [{ identifier: "parent" }, { identifier: "parent" }],
		};
		const explicit = caseListConfig([
			{ field: "case_name", header: "Details" },
		]);
		explicit.detailTabs = [
			{
				uuid: testUuid("closed-detail"),
				title: "Nearby records",
				startColumnUuid: explicit.detailColumnOrder[0],
				displayCondition: eq(literal(1), literal(2)),
				rowSource: {
					kind: "records",
					rows: {
						kind: "cases",
						source: "casedb",
						where: [
							eq(
								{ kind: "case-row-type" },
								{ kind: "case-type", caseType: "patient" },
							),
						],
					},
					includeChildrenOfType: "visit",
				},
			},
		];
		const second = caseListConfig([{ field: "case_name", header: "Tasks" }]);
		second.detailTabs = [
			{
				uuid: testUuid("tasks"),
				title: "Tasks",
				startColumnUuid: second.detailColumnOrder[0],
				rowSource: { kind: "children", caseType: "task" },
			},
		];
		const disabled = caseListConfig([{ field: "case_name", header: "Notes" }]);
		disabled.detailTabs = [
			{
				uuid: testUuid("notes"),
				title: "Notes",
				startColumnUuid: disabled.detailColumnOrder[0],
				rowSource: { kind: "children", caseType: "note" },
			},
		];
		const primary = caseListConfig([{ field: "case_name", header: "Name" }]);
		primary.additionalCaseTypes = ["household"];
		primary.searchFilters = [
			{
				uuid: testUuid("requested"),
				kind: "request-record-type",
				caseType: "document",
			},
		];
		const doc = buildDoc({
			caseTypes: [
				PATIENT,
				HOUSEHOLD,
				...[
					"document",
					"episode",
					"group",
					"region",
					"visit",
					"task",
					"note",
				].map((name) => ({ name, properties: [] })),
			],
			modules: [
				{
					name: "Find records",
					caseType: "patient",
					caseListConfig: primary,
					caseSearchConfig: {
						relatedRecordIdProperty: "care_record",
						relatedRecords: "details",
					},
					forms: [],
				},
				{
					name: "Related information",
					caseType: "patient",
					caseListConfig: parentColumn,
					caseSearchConfig: {},
					forms: [],
				},
				{
					name: "Nearby",
					caseType: "household",
					caseListConfig: explicit,
					caseSearchConfig: {},
					forms: [],
				},
				{
					name: "Other tasks",
					caseType: "document",
					caseListConfig: second,
					caseSearchConfig: {},
					forms: [],
				},
				{
					name: "Notes on device",
					caseType: "patient",
					caseListConfig: disabled,
					forms: [],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const projected = completedSearchRequest(
			doc.modules[moduleUuid],
			undefined,
			undefined,
			{},
			{ doc, moduleUuid, caseType: "patient" },
		);
		const request = { ...projected, configuration: undefined };
		const args = {
			...SEARCH,
			caseListConfig: primary,
			additionalCaseTypes: primary.additionalCaseTypes,
			searchPopulation: { ...SEARCH.searchPopulation, request },
		};
		const fixture = await readSearchResultsSnapshot(store, args);
		expect(fixture.totalMatches).toBe(3);
		expect(
			fixture.rows
				.filter((row) => row.properties.commcare_is_related_case !== "true")
				.map((row) => [row.case_id, row.case_type]),
		).toEqual([
			["file-a", "document"],
			["house-a", "household"],
			["patient-a", "patient"],
		]);
		expect(
			fixture.rows
				.filter((row) => row.properties.commcare_is_related_case === "true")
				.map((row) => [row.case_id, row.status])
				.sort(),
		).toEqual([
			["care-a", "closed"],
			["child", "closed"],
			["extension-seed", "closed"],
			["last", "closed"],
			["second-child", "closed"],
		]);
		const hierarchy = await readSearchResultsSnapshot(store, {
			...args,
			searchPopulation: {
				...args.searchPopulation,
				request: { ...request, includeRelatedHierarchy: true },
			},
		});
		expect(hierarchy.totalMatches).toBe(3);
		expect(
			hierarchy.rows
				.filter((row) => row.properties.commcare_is_related_case === "true")
				.map((row) => [row.case_id, row.status])
				.sort(),
		).toEqual([
			["care-a", "closed"],
			["child", "closed"],
			["extension-host", "open"],
			["extension-leaf", "open"],
			["extension-seed", "closed"],
			["ignored-child", "closed"],
			["last", "closed"],
			["middle", "closed"],
			["second-child", "closed"],
		]);

		const page = await store.querySearchResults(args);
		expect(page.primaryCount).toBe(3);
		expect(page.totalRows).toBe(2);
		expect(page.rows.map((row) => row.case_id).sort()).toEqual([
			"house-a",
			"patient-a",
		]);
		const claimType = caseClaimCaseType();
		const schemas = buildCaseTypeMap(doc);
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: claimType.name,
			caseTypeSchemas: new Map([...schemas, [claimType.name, claimType]]),
		});
		for (const unavailable of [
			"file-a",
			"care-a",
			"child",
			"middle",
			"private",
			"other-app-case",
		]) {
			const ids = ["house-a", unavailable];
			await expect(
				store.claimCases({
					appId: APP_ID,
					caseIds: ids,
					fromSearches: [{ caseIds: ids, query: args }],
				}),
			).rejects.toMatchObject({ name: "CaseNotFoundError" });
			expect(await store.countClaims({ appId: APP_ID })).toBe(0);
		}
		await expect(
			store.claimCases({
				appId: APP_ID,
				caseIds: ["house-a"],
				fromSearches: [{ caseIds: ["house-a"], query: args }],
			}),
		).resolves.toMatchObject({ created: ["house-a"] });
		const prefix = await store.readSearchResultInstance({
			...args,
			searchPopulation: {
				...args.searchPopulation,
				request: {
					...request,
					relatedPaths: [["parent", "parent"], ["parent"]],
				},
			},
		});
		expect(prefix.rows.map((row) => row.case_id).sort()).toEqual([
			"care-a",
			"child",
			"extension-seed",
			"file-a",
			"house-a",
			"last",
			"middle",
			"patient-a",
			"second-child",
		]);
	});
});
