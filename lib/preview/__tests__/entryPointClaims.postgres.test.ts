// lib/preview/__tests__/entryPointClaims.postgres.test.ts
//
// An entry point's launch on Web Apps is the claim frame HQ posts
// (`endpoints.py::EndpointsHelper._add_claim_frame`): the launch writes a
// claim row for each chosen case the worker's restore lacks, after its last
// authorization check, and the worker's device holds the case from then on.
// Android keeps only the last command and never reaches the claim, so its
// launch writes none and opens the case blank. Real Postgres: the claim row,
// its `host` index and the restore closure that reads them are SQL. The
// request's authorization is the boundary this test stands in for; the
// store, the device read and the launch's admission are production code.

import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { buildCaseTypeMap, type CaseStore } from "@/lib/case-store";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { CASE_CLAIM_CASE_TYPE, type Uuid } from "@/lib/domain";
import {
	androidDevice,
	webAppsDevice,
} from "../engine/__tests__/fixtures/previewDevices";
import type { PreviewDevice } from "../engine/previewDevice";
import { assertAdmittedPreviewDoc } from "./fixtures/admittedDoc";

const { authorize, recheck } = vi.hoisted(() => ({
	authorize: vi.fn(),
	recheck: vi.fn(),
}));
vi.mock("../engine/previewAuthorization", () => ({
	resolveAuthorizedPreviewContext: authorize,
}));
vi.mock("@/lib/db/appAccess", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/appAccess")>()),
	resolveAuthorizedAppSnapshot: recheck,
}));
vi.mock("@/lib/lookup/service", () => ({ getLookupFixtureData: vi.fn() }));

import { launchEntryPointAction } from "../entryPointLaunchAction";

const APP_ID = "app-entry-point-claims";
const PROJECT = "project-entry-point-claims";
const WORKER = "worker-launching";
const OTHER_WORKER = "worker-other";
const MINE = "60000000-0000-0000-0000-000000000001";
const THEIRS = "60000000-0000-0000-0000-000000000002";

const M = testUuid("claims-module");
const F = testUuid("claims-form");
const E = testUuid("claims-entry");

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "entry_point_claims_",
});

function storeAs(ownerId: string): CaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT,
		actorUserId: WORKER,
		ownerId,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

function entryPointDoc() {
	const doc = buildDoc({
		appId: APP_ID,
		appName: "Visits",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: M,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: F,
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "notes" })],
					},
				],
			},
		],
	});
	doc.forms[F].entryPoint = { uuid: E, id: "visit" };
	return assertAdmittedPreviewDoc(doc);
}

/** The ready context `resolveAuthorizedPreviewContext` answers for the
 *  launching worker on `device`, bound to the real store. */
function readyContext(device: PreviewDevice) {
	return {
		kind: "ready",
		identity: {
			actorUserId: WORKER,
			ownerId: WORKER,
			session: {
				context: { userid: WORKER },
				user: {},
				userPropertySlugs: {},
			},
		},
		store: storeAs(WORKER),
		scope: { projectId: PROJECT, actorId: WORKER, role: "viewer" },
		blueprint: toPersistableDoc(entryPointDoc()),
		baseSeq: 4,
		restoreScope: { ownerIds: [WORKER] },
		device,
	};
}

function launchTheirs(device: PreviewDevice) {
	authorize.mockResolvedValue(readyContext(device));
	return launchEntryPointAction({
		appId: APP_ID,
		entryPointUuid: E,
		expectedSeq: 4,
		selections: [{ moduleUuid: M as Uuid, caseIds: [THEIRS] }],
		device,
	});
}

/** What the launching worker's device holds, through the production restore. */
async function deviceRows() {
	const device = await storeAs(WORKER).readDeviceCaseDatabase({
		appId: APP_ID,
		restoreScope: { ownerIds: [WORKER] },
	});
	return device.rows.map((row) => ({ id: row.case_id, type: row.case_type }));
}

beforeEach(async () => {
	vi.resetAllMocks();
	recheck.mockResolvedValue({ baseSeq: 4, projectId: PROJECT });
	await sql`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES (${APP_ID}, ${WORKER}, ${PROJECT}, 'Visits', 'visits')
	`.execute(dbHandle.db);
	const doc = entryPointDoc();
	const mine = storeAs(WORKER);
	for (const caseType of ["patient", CASE_CLAIM_CASE_TYPE])
		await mine.applySchemaChange({
			appId: APP_ID,
			caseType,
			caseTypeSchemas: buildCaseTypeMap(doc),
		});
	const patient = (caseId: string, caseName: string) => ({
		appId: APP_ID,
		row: {
			case_id: caseId,
			case_type: "patient",
			case_name: caseName,
			status: "open",
			properties: {},
		},
	});
	await mine.insert(patient(MINE, "Mine"));
	await storeAs(OTHER_WORKER).insert(patient(THEIRS, "Theirs"));
});

describe("an entry point's launch and the worker's claims", () => {
	it("writes a claim for a case the worker lacks on Web Apps, and the device then holds it", async () => {
		expect(await deviceRows()).toEqual([{ id: MINE, type: "patient" }]);
		const result = await launchTheirs(webAppsDevice());
		expect(result).toMatchObject({
			kind: "ready",
			claimCaseIds: [THEIRS],
			blankCaseIds: [],
		});
		expect(await storeAs(WORKER).countClaims({ appId: APP_ID })).toBe(1);
		const held = await deviceRows();
		expect(held).toEqual(
			expect.arrayContaining([
				{ id: MINE, type: "patient" },
				{ id: THEIRS, type: "patient" },
				expect.objectContaining({ type: CASE_CLAIM_CASE_TYPE }),
			]),
		);
		expect(held).toHaveLength(3);
		// A second launch of the same case claims it once.
		expect(await launchTheirs(webAppsDevice())).toMatchObject({
			kind: "ready",
		});
		expect(await storeAs(WORKER).countClaims({ appId: APP_ID })).toBe(1);
	});

	it("writes no claim on Android and opens the case blank", async () => {
		const result = await launchTheirs(androidDevice());
		expect(result).toMatchObject({
			kind: "ready",
			claimCaseIds: [],
			blankCaseIds: [THEIRS],
		});
		expect(await storeAs(WORKER).countClaims({ appId: APP_ID })).toBe(0);
		expect(await deviceRows()).toEqual([{ id: MINE, type: "patient" }]);
	});

	it("writes no claim for a launch its last authorization check refuses", async () => {
		recheck.mockResolvedValue({ baseSeq: 5, projectId: PROJECT });
		expect(await launchTheirs(webAppsDevice())).toMatchObject({
			kind: "refused",
		});
		expect(await storeAs(WORKER).countClaims({ appId: APP_ID })).toBe(0);
	});
});
