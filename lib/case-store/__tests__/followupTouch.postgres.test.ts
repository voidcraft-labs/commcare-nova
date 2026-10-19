// lib/case-store/__tests__/followupTouch.postgres.test.ts
//
// A follow-up that writes nothing still touches its case. Nova's exports
// write `update_case` `always` on every case form, so HQ's build gives a
// one-case follow-up a primary block that names the selected case, and HQ's
// case processing moves that case's `modified_on` for each submission. A
// several-case form has no primary block, so nothing moves there. The case
// store is Preview's copy of that processing, through the production store
// and real transactions.

import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseType } from "@/lib/domain";
import { SEARCH_READING } from "@/lib/domain/expression/temporalType";
import { proseText } from "@/lib/domain/prose";
import { PostgresCaseStore } from "../postgres/store";
import { HeuristicCaseGenerator } from "../sample/heuristic";
import { setupPerTestDatabase } from "../sql/__tests__/perTestDatabase";
import type { Database } from "../sql/database";
import { buildCaseTypeMap } from "../store";
import type { ApplySubmissionArgs } from "../submission";
import { buildSimpleBlueprint } from "./fixtures/simpleBlueprint";

const APP_ID = "followup-touch-app";
const PROJECT_ID = "followup-touch-project";
const ACTOR = "worker-1";
const FORM_UUID = testUuid("66666666-6666-4666-8666-666666666666");
const ALICE = "00000000-0000-7000-8000-00000000aaaa";
const BOB = "00000000-0000-7000-8000-00000000bbbb";
const BEFORE = new Date("2001-01-01T00:00:00Z");

const PATIENT: CaseType = {
	name: "patient",
	properties: [{ name: "notes", label: proseText("Notes"), data_type: "text" }],
};
const VISIT: CaseType = {
	name: "visit",
	properties: [{ name: "notes", label: proseText("Notes"), data_type: "text" }],
};
const SCHEMAS = buildCaseTypeMap(
	buildSimpleBlueprint([PATIENT, VISIT], APP_ID),
);

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "followup_touch_",
	prepareTemplate: async (db) => {
		await sql`
			INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
			VALUES (${APP_ID}, ${ACTOR}, ${PROJECT_ID}, 'Touch app', 'touch app')
		`.execute(db);
		const store = makeStore(db as Kysely<Database>);
		for (const caseType of [PATIENT, VISIT]) {
			await store.applySchemaChange({
				appId: APP_ID,
				caseType: caseType.name,
				caseTypeSchemas: SCHEMAS,
			});
		}
	},
});

function makeStore(
	db: Kysely<Database> = dbHandle.db as Kysely<Database>,
): PostgresCaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT_ID,
		actorUserId: ACTOR,
		ownerId: ACTOR,
		db,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

async function seedPatient(
	store: PostgresCaseStore,
	caseId: string,
	caseName: string,
): Promise<void> {
	await store.insert({
		appId: APP_ID,
		row: {
			case_id: caseId,
			case_type: "patient",
			case_name: caseName,
			status: "open",
			modified_on: BEFORE,
			properties: JSON.stringify({ notes: "original" }),
		},
	});
}

let receipt = 0;

function submit(
	store: PostgresCaseStore,
	ordinary: ApplySubmissionArgs["ordinary"],
) {
	receipt += 1;
	return store.applySubmission({
		appId: APP_ID,
		ordinary,
		submissionReceipt: {
			entryKey: `followup-touch-${receipt}`,
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			blueprintDigest: "0".repeat(64),
			requestDigest: `followup-touch-request-${receipt}`,
		},
	});
}

async function modifiedOn(
	store: PostgresCaseStore,
	caseId: string,
): Promise<Date | null | undefined> {
	const rows = await store.query({
		reading: SEARCH_READING,
		appId: APP_ID,
		caseType: "patient",
		caseIds: [caseId],
	});
	return rows[0]?.modified_on;
}

describe("a follow-up that writes nothing", () => {
	it("moves its one selected case's modified_on and changes nothing else of it", async () => {
		const store = makeStore();
		await seedPatient(store, ALICE, "Alice");
		const [before] = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
			caseIds: [ALICE],
		});

		await submit(store, {
			kind: "followup",
			caseIds: [ALICE],
			selection: { kind: "single", maximum: 1 },
			caseType: "patient",
			patch: { properties: {} },
			children: [],
		});

		const [after] = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
			caseIds: [ALICE],
		});
		expect(after?.modified_on?.getTime()).toBeGreaterThan(BEFORE.getTime());
		expect({ ...after, modified_on: null }).toEqual({
			...before,
			modified_on: null,
		});
	});

	it("moves its case's modified_on when its only writes are child cases", async () => {
		const store = makeStore();
		await seedPatient(store, ALICE, "Alice");

		await submit(store, {
			kind: "followup",
			caseIds: [ALICE],
			selection: { kind: "single", maximum: 1 },
			caseType: "patient",
			patch: { properties: {} },
			children: [
				{ caseType: "visit", caseName: "Visit", properties: { notes: "x" } },
			],
		});

		expect((await modifiedOn(store, ALICE))?.getTime()).toBeGreaterThan(
			BEFORE.getTime(),
		);
	});

	it("leaves every case of a several-case submission as it was", async () => {
		const store = makeStore();
		await seedPatient(store, ALICE, "Alice");
		await seedPatient(store, BOB, "Bob");

		await submit(store, {
			kind: "followup",
			caseIds: [ALICE, BOB],
			selection: { kind: "multiple", maximum: 2 },
			caseType: "patient",
			patch: { properties: {} },
			children: [],
		});

		expect(await modifiedOn(store, ALICE)).toEqual(BEFORE);
		expect(await modifiedOn(store, BOB)).toEqual(BEFORE);
	});
});
