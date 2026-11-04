// lib/case-store/postgres/__tests__/claims.postgres.test.ts
//
// A search's claim is a case row (`CaseStore.claimCases`), HQ's claim case:
// open, of type `commcare-case-claim`, named after the host, owned by the
// worker, with one `host` extension index to the chosen case
// (`corehq/ex-submodules/casexml/apps/case/cleanup.py::claim_case`). An id the
// worker already claims gets no second row (`cleanup.py::get_first_claims`),
// and an id that names no case refuses the whole claim (`ota/views.py::claim`
// answers 410 before it claims anything).
//
// Every app is born through real genesis on an isolated database, and every
// store is the production `withProjectContext` with its authorization fence.

import { beforeEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import {
	CASE_CLAIM_CASE_TYPE,
	CASE_CLAIM_HOST_INDEX,
	type CaseType,
	caseClaimCaseType,
} from "@/lib/domain";
import { caseTypeToJsonSchema } from "@/lib/domain/expression/jsonSchema";
import { proseText } from "@/lib/domain/prose";
import { buildSimpleBlueprint } from "../../__tests__/fixtures/simpleBlueprint";
import { CaseNotFoundError } from "../../errors";
import { withProjectContext, withSchemaContext } from "../../projectContext";
import { buildCaseTypeMap } from "../../store";

const h = setupAppStateTestDb("case_claims_", {
	authSchema: "migrated",
	poolMax: 3,
});
const ACTOR = "claims-member";
const PROJECT = "claims-project";
const OTHER_PROJECT = "claims-other-project";
const WORKER = testUuid("claims-worker");
const OTHER_WORKER = testUuid("claims-other-worker");

const PATIENT: CaseType = {
	name: "patient",
	properties: [{ name: "village", label: proseText("Village") }],
};
const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [{ name: "village", label: proseText("Village") }],
};

beforeEach(async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	await h.seedProjectMember(ACTOR, OTHER_PROJECT, "owner");
});

/** An app born through genesis, holding patients and households. */
async function app(projectId = PROJECT): Promise<string> {
	const { appId } = await createExplicitBlankApp(
		ACTOR,
		projectId,
		crypto.randomUUID(),
	);
	const schemas = buildCaseTypeMap(
		buildSimpleBlueprint([PATIENT, HOUSEHOLD], appId),
	);
	const store = await withSchemaContext();
	for (const caseType of [PATIENT, HOUSEHOLD])
		await store.applySchemaChange({
			appId,
			caseType: caseType.name,
			caseTypeSchemas: schemas,
		});
	return appId;
}

async function workerStore(worker = WORKER, projectId = PROJECT) {
	return withProjectContext(projectId, ACTOR, worker);
}

async function host(
	appId: string,
	caseName: string,
	options: { caseType?: string; projectId?: string; status?: string } = {},
): Promise<string> {
	const store = await workerStore(OTHER_WORKER, options.projectId);
	const { caseId } = await store.insert({
		appId,
		row: {
			case_type: options.caseType ?? PATIENT.name,
			case_name: caseName,
			status: "open",
			properties: {},
		},
	});
	if (options.status === "closed") await store.close({ appId, caseId });
	return caseId;
}

type ClaimRow = {
	readonly case_id: string;
	readonly case_type: string;
	readonly case_name: string;
	readonly owner_id: string;
	readonly status: string | null;
	readonly closed: boolean;
	readonly properties: Record<string, unknown>;
	readonly parent_case_id: string | null;
	readonly host_id: string;
	readonly host_type: string;
	readonly relationship: string;
};

/** Every claim row of the app with its one index, read straight from the
 *  tables. */
async function claimRows(appId: string): Promise<ClaimRow[]> {
	const result = await h.pool().query<ClaimRow>(
		`SELECT c.case_id, c.case_type, c.case_name, c.owner_id, c.status,
		        c.closed_on IS NOT NULL AS closed, c.properties, c.parent_case_id,
		        ci.ancestor_id AS host_id, ci.target_case_type AS host_type,
		        ci.relationship
		 FROM cases c
		 JOIN case_indices ci ON ci.case_id = c.case_id
		 WHERE c.app_id = $1 AND c.case_type = $2
		 ORDER BY ci.ancestor_id, c.owner_id`,
		[appId, CASE_CLAIM_CASE_TYPE],
	);
	return result.rows;
}

async function claimIndices(appId: string) {
	const result = await h.pool().query<{
		identifier: string;
		depth: number;
	}>(
		`SELECT ci.identifier, ci.depth
		 FROM case_indices ci JOIN cases c ON c.case_id = ci.case_id
		 WHERE c.app_id = $1 AND c.case_type = $2`,
		[appId, CASE_CLAIM_CASE_TYPE],
	);
	return result.rows;
}

describe("claimCases", () => {
	it("writes HQ's claim case for each chosen case, named after it, owned by the worker, with one host extension index", async () => {
		const appId = await app();
		const amara = await host(appId, "Amara");
		const home = await host(appId, "Sow home", { caseType: HOUSEHOLD.name });
		const store = await workerStore();

		const result = await store.claimCases({ appId, caseIds: [home, amara] });

		expect(result).toEqual({
			created: [amara, home].sort(),
			alreadyClaimed: [],
		});
		const rows = await claimRows(appId);
		expect(
			rows
				.map(({ case_id: _id, ...row }) => row)
				.sort((a, b) => a.host_id.localeCompare(b.host_id)),
		).toEqual(
			[
				{ host_id: amara, host_type: PATIENT.name, case_name: "Amara" },
				{ host_id: home, host_type: HOUSEHOLD.name, case_name: "Sow home" },
			]
				.map((expected) => ({
					case_type: CASE_CLAIM_CASE_TYPE,
					case_name: expected.case_name,
					owner_id: WORKER,
					status: "open",
					closed: false,
					properties: {},
					parent_case_id: null,
					host_id: expected.host_id,
					host_type: expected.host_type,
					relationship: "extension",
				}))
				.sort((a, b) => a.host_id.localeCompare(b.host_id)),
		);
		expect(await claimIndices(appId)).toEqual([
			{ identifier: CASE_CLAIM_HOST_INDEX, depth: 1 },
			{ identifier: CASE_CLAIM_HOST_INDEX, depth: 1 },
		]);
		expect(await store.countClaims({ appId })).toBe(2);
	});

	it("claims a closed case too, since HQ checks only that it exists", async () => {
		const appId = await app();
		const closed = await host(appId, "Closed", { status: "closed" });
		const store = await workerStore();
		expect(await store.claimCases({ appId, caseIds: [closed] })).toEqual({
			created: [closed],
			alreadyClaimed: [],
		});
	});

	it("writes no second row for a case the worker already claims, and one for a case another worker claims", async () => {
		const appId = await app();
		const amara = await host(appId, "Amara");
		const bintou = await host(appId, "Bintou");
		const store = await workerStore();
		await store.claimCases({ appId, caseIds: [amara] });
		await (await workerStore(OTHER_WORKER)).claimCases({
			appId,
			caseIds: [bintou],
		});

		const again = await store.claimCases({ appId, caseIds: [bintou, amara] });

		expect(again).toEqual({ created: [bintou], alreadyClaimed: [amara] });
		const rows = await claimRows(appId);
		expect(rows.map((row) => [row.host_id, row.owner_id]).sort()).toEqual(
			[
				[amara, WORKER],
				[bintou, OTHER_WORKER],
				[bintou, WORKER],
			].sort(),
		);
	});

	it("claims again once the worker's claim is released", async () => {
		const appId = await app();
		const amara = await host(appId, "Amara");
		const store = await workerStore();
		await store.claimCases({ appId, caseIds: [amara] });
		await store.releaseClaims({ appId });
		expect(await store.claimCases({ appId, caseIds: [amara] })).toEqual({
			created: [amara],
			alreadyClaimed: [],
		});
		expect(await store.countClaims({ appId })).toBe(1);
	});

	it("refuses the whole claim when one id names no case of this app in this Project, writing nothing", async () => {
		const appId = await app();
		const otherApp = await app();
		const otherProjectApp = await app(OTHER_PROJECT);
		const amara = await host(appId, "Amara");
		const elsewhere = await host(otherApp, "Elsewhere");
		const foreign = await host(otherProjectApp, "Foreign", {
			projectId: OTHER_PROJECT,
		});
		const store = await workerStore();

		for (const stranger of [elsewhere, foreign, "no-such-case"]) {
			const refusal = store.claimCases({
				appId,
				caseIds: [amara, stranger],
			});
			await expect(refusal).rejects.toBeInstanceOf(CaseNotFoundError);
			await expect(refusal).rejects.toMatchObject({ caseId: stranger });
		}
		expect(await claimRows(appId)).toEqual([]);
		expect(await claimRows(otherApp)).toEqual([]);
		expect(await claimRows(otherProjectApp)).toEqual([]);
	});

	it("inserts one row when one worker claims one case twice at once", async () => {
		const appId = await app();
		const amara = await host(appId, "Amara");
		const [first, second] = await Promise.all([
			(await workerStore()).claimCases({ appId, caseIds: [amara] }),
			(await workerStore()).claimCases({ appId, caseIds: [amara] }),
		]);
		expect([first, second]).toEqual(
			expect.arrayContaining([
				{ created: [amara], alreadyClaimed: [] },
				{ created: [], alreadyClaimed: [amara] },
			]),
		);
		expect(await claimRows(appId)).toHaveLength(1);
	});
});

describe("releaseClaims and countClaims", () => {
	it("close only the bound worker's open claims in this app", async () => {
		const appId = await app();
		const otherApp = await app();
		const amara = await host(appId, "Amara");
		const bintou = await host(appId, "Bintou");
		const elsewhere = await host(otherApp, "Elsewhere");
		const store = await workerStore();
		const other = await workerStore(OTHER_WORKER);
		await store.claimCases({ appId, caseIds: [amara, bintou] });
		await other.claimCases({ appId, caseIds: [amara] });
		await store.claimCases({ appId: otherApp, caseIds: [elsewhere] });
		expect(await store.countClaims({ appId })).toBe(2);
		expect(await other.countClaims({ appId })).toBe(1);

		expect(await store.releaseClaims({ appId })).toEqual({ released: 2 });

		expect(await store.countClaims({ appId })).toBe(0);
		expect(await other.countClaims({ appId })).toBe(1);
		expect(await store.countClaims({ appId: otherApp })).toBe(1);
		const rows = await claimRows(appId);
		expect(
			rows.map((row) => [row.host_id, row.owner_id, row.status, row.closed]),
		).toEqual(
			expect.arrayContaining([
				[amara, WORKER, "closed", true],
				[bintou, WORKER, "closed", true],
				[amara, OTHER_WORKER, "open", false],
			]),
		);
		// A second release finds nothing open.
		expect(await store.releaseClaims({ appId })).toEqual({ released: 0 });
	});

	it("leaves the host where a released claim pointed, out of the worker's restore", async () => {
		const appId = await app();
		const amara = await host(appId, "Amara");
		const store = await workerStore();
		const restoreScope = { ownerIds: [WORKER] };
		await store.claimCases({ appId, caseIds: [amara] });
		const claimed = await store.readDeviceCaseDatabase({ appId, restoreScope });
		expect(claimed.rows.map((row) => row.case_id)).toContain(amara);

		await store.releaseClaims({ appId });

		const released = await store.readDeviceCaseDatabase({
			appId,
			restoreScope,
		});
		expect(released.rows.map((row) => row.case_id)).toEqual([]);
	});
});

describe("resetSampleData", () => {
	it("deletes the claims of the cases it deletes and keeps every other claim", async () => {
		const appId = await app();
		const amara = await host(appId, "Amara");
		const home = await host(appId, "Sow home", { caseType: HOUSEHOLD.name });
		await (await workerStore()).claimCases({ appId, caseIds: [amara, home] });
		await (await workerStore(OTHER_WORKER)).claimCases({
			appId,
			caseIds: [amara],
		});

		await (await workerStore()).resetSampleData({
			appId,
			caseType: PATIENT,
			count: 2,
		});

		const rows = await claimRows(appId);
		expect(rows.map((row) => [row.host_id, row.owner_id])).toEqual([
			[home, WORKER],
		]);
		const dangling = await h.pool().query(
			`SELECT ci.case_id FROM case_indices ci
			 LEFT JOIN cases c ON c.case_id = ci.case_id
			 LEFT JOIN cases a ON a.case_id = ci.ancestor_id
			 WHERE c.case_id IS NULL OR a.case_id IS NULL`,
		);
		expect(dangling.rows).toEqual([]);
	});
});

describe("the claim type's schema", () => {
	it("is born with every app, read by its schema and table after the catalog is repacked and scanned in heap order", async () => {
		const client = await h.pool().connect();
		try {
			// Repack `pg_constraint` and read in heap order, as the cutover's
			// checks meet the catalog; the read names its schema and table, so
			// no same-named relation elsewhere can answer it.
			await client.query("VACUUM FULL pg_catalog.pg_constraint");
			await client.query("SET enable_indexscan = off");
			await client.query("SET enable_indexonlyscan = off");
			await client.query("SET enable_bitmapscan = off");
			const { appId } = await createExplicitBlankApp(
				ACTOR,
				PROJECT,
				crypto.randomUUID(),
			);

			const row = await client.query<{
				schema: unknown;
				synced_seq: string;
				is_active: boolean;
			}>(
				`SELECT s.schema, s.synced_seq::text AS synced_seq, s.is_active
				 FROM public.case_type_schemas s
				 WHERE s.app_id = $1 AND s.case_type = $2`,
				[appId, CASE_CLAIM_CASE_TYPE],
			);
			expect(row.rows).toEqual([
				{
					schema: caseTypeToJsonSchema(caseClaimCaseType()),
					synced_seq: "1",
					is_active: true,
				},
			]);
		} finally {
			await client.query("RESET ALL");
			client.release();
		}
	});
});
