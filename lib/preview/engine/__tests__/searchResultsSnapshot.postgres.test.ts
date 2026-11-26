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
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { buildCaseTypeMap, type CaseStore } from "@/lib/case-store";
import {
	PostgresCaseStore,
	type PostgresCaseStoreArgs,
} from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import type { CaseSearchRequest } from "@/lib/case-store/searchRequest";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import { SEARCH_RESULTS_CAP } from "@/lib/commcare/session";
import type { CaseType } from "@/lib/domain";
import {
	and,
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
import { readSearchResultsSnapshot } from "../searchResultsSnapshot";

const APP_ID = "app-search-results";
const PROJECT = "project-search-results";
const WORKER = "worker-searching";
const OTHER_WORKER = "worker-other";
const EXCLUDED_WORKER = "worker-excluded";

const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [{ name: "village", label: proseText("Village") }],
};
const PATIENT: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [{ name: "district", label: proseText("District") }],
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
		for (const [id, owner, priority, visit] of cases)
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: id,
					case_type: "patient",
					case_name: id,
					status: "open",
					owner_id: owner,
					properties: { district: "north", priority, visit },
				},
			});
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

	it("certifies exact tokens and independent exclusions inside a fuzzy search condition", async () => {
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
		await expect(
			store.count({ ...args, predicate: similar }),
		).rejects.toMatchObject({
			reason: { kind: "fuzzy-expansion-unavailable", field: "district" },
		});
		await expect(
			store.count({ ...args, predicate: not(similar) }),
		).rejects.toMatchObject({
			reason: { kind: "fuzzy-expansion-unavailable" },
		});
		const named = (id: string) => eq(prop("patient", "case_id"), literal(id));
		expect(
			(
				await store.query({ ...args, predicate: and(similar, named("exact")) })
			).map((r) => r.case_id),
		).toEqual(["exact"]);
		expect(
			(
				await store.query({
					...args,
					predicate: and(not(similar), named("other")),
				})
			).map((r) => r.case_id),
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
});
