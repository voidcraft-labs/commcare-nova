// lib/case-store/postgres/__tests__/entryCaseIds.postgres.test.ts
//
// The cases a form's entry names are created with the ids its session held.
//
// A registration's `case_id_new_<type>_0` and a one-case form's non-repeat
// child datum are `uuid()` datums Core values once per entry; the form reads
// them while it runs and the case block creates the cases with them. Preview
// mints those ids from the entry key (`lib/domain/entryCaseIdentity.ts`), and
// the envelope inserts the server-marked seeds (`SubmissionCaseSeed.entryCaseKey`)
// with the same ids. Every other created case takes a fresh id.

import { type Kysely, sql } from "kysely";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseType } from "@/lib/domain";
import { entryDatumCaseId } from "@/lib/domain/entryCaseIdentity";
import { SEARCH_READING } from "@/lib/domain/expression/temporalType";
import { proseText } from "@/lib/domain/prose";
import { buildSimpleBlueprint } from "../../__tests__/fixtures/simpleBlueprint";
import { SubmissionRejectedError } from "../../errors";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { buildCaseTypeMap } from "../../store";
import type {
	ApplySubmissionArgs,
	SubmissionReceiptClaim,
} from "../../submission";
import { PostgresCaseStore } from "../store";

const APP_ID = "entry-ids-app";
const PROJECT = "entry-ids-project";
const ACTOR = "entry-ids-worker";
const FORM_UUID = testUuid("entry-ids-form");

const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [
		{ name: "village", label: proseText("Village"), data_type: "text" },
	],
};
const MEMBER: CaseType = {
	name: "member",
	properties: [{ name: "role", label: proseText("Role"), data_type: "text" }],
};
const TYPES = [HOUSEHOLD, MEMBER];
const SCHEMAS = buildCaseTypeMap(buildSimpleBlueprint(TYPES, APP_ID));

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "entry_case_ids_",
	prepareTemplate: async (db) => {
		await sql`
			INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
			VALUES (${APP_ID}, ${ACTOR}, ${PROJECT}, 'Entry ids', 'entry ids')
		`.execute(db);
		const store = storeOn(db as Kysely<Database>);
		for (const caseType of TYPES)
			await store.applySchemaChange({
				appId: APP_ID,
				caseType: caseType.name,
				caseTypeSchemas: SCHEMAS,
			});
	},
});

function storeOn(db: Kysely<Database> = dbHandle.db as Kysely<Database>) {
	return new PostgresCaseStore({
		projectId: PROJECT,
		actorUserId: ACTOR,
		ownerId: ACTOR,
		db,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

function receipt(entryKey: string): SubmissionReceiptClaim {
	return {
		entryKey,
		formUuid: FORM_UUID,
		expectedAppMutationSeq: 0,
		blueprintDigest: "0".repeat(64),
		requestDigest: `request-${entryKey}`,
	};
}

/** A registration whose session names its household and its one member;
 *  `repeatMembers` more members come from a repeat, which no datum names. */
function registration(
	entryKey: string,
	repeatMembers = 0,
): ApplySubmissionArgs {
	return {
		appId: APP_ID,
		submissionReceipt: receipt(entryKey),
		ordinary: {
			kind: "registration",
			primary: {
				caseType: "household",
				caseName: "Smiths",
				properties: { village: "North" },
				entryCaseKey: "new-case",
			},
			children: [
				{
					caseType: "member",
					caseName: "Head",
					properties: { role: "head" },
					entryCaseKey: "new-child-case:member",
				},
				...Array.from({ length: repeatMembers }, (_, index) => ({
					caseType: "member",
					caseName: `Visitor ${index + 1}`,
					properties: { role: "visitor" },
				})),
			],
		},
	};
}

async function stored(caseType: string) {
	return storeOn().query({
		reading: SEARCH_READING,
		appId: APP_ID,
		caseType,
		includeHeld: true,
	});
}

describe("cases an entry names", () => {
	it("creates a registration's case and its named child with the entry's ids", async () => {
		const store = storeOn();
		const result = await store.applySubmission(registration("entry-1", 2));
		const household = entryDatumCaseId(APP_ID, "entry-1", "new-case");
		const head = entryDatumCaseId(APP_ID, "entry-1", "new-child-case:member");
		expect(result.primaryCaseIds).toEqual([household]);
		const children = result.createdChildren.map((child) => child.caseId);
		expect(children[0]).toBe(head);
		// A repeat's members are minted per iteration on a device; no datum
		// names them, so each takes a fresh id.
		expect(children.slice(1)).toHaveLength(2);
		for (const visitor of children.slice(1)) {
			expect(visitor).not.toBe(head);
			expect(visitor).not.toBe(household);
		}
		expect(new Set(children).size).toBe(3);
		expect((await stored("household")).map((row) => row.case_id)).toEqual([
			household,
		]);
		const members = await stored("member");
		expect(members.find((row) => row.case_id === head)).toMatchObject({
			case_name: "Head",
			parent_case_id: household,
		});
	});

	it("creates a one-case follow-up's named child with the entry's id", async () => {
		const store = storeOn();
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: "household-1",
				case_type: "household",
				case_name: "Smiths",
				status: "open",
				properties: JSON.stringify({}),
			},
		});
		const result = await store.applySubmission({
			appId: APP_ID,
			submissionReceipt: receipt("entry-followup"),
			ordinary: {
				kind: "followup",
				caseIds: ["household-1"],
				selection: { kind: "single", maximum: 1 },
				caseType: "household",
				patch: { properties: {} },
				children: [
					{
						caseType: "member",
						caseName: "Newborn",
						properties: {},
						entryCaseKey: "new-child-case:member",
					},
				],
			},
		});
		expect(result.createdChildren.map((child) => child.caseId)).toEqual([
			entryDatumCaseId(APP_ID, "entry-followup", "new-child-case:member"),
		]);
	});

	it("replays an exact retry with the same ids and creates nothing more", async () => {
		const store = storeOn();
		const first = await store.applySubmission(registration("entry-retry"));
		const retry = await store.applySubmission(registration("entry-retry"));
		expect(retry).toEqual(first);
		expect(await stored("household")).toHaveLength(1);
		expect(await stored("member")).toHaveLength(1);
	});

	it("refuses a new case whose entry id is taken and writes nothing", async () => {
		const store = storeOn();
		const taken = entryDatumCaseId(APP_ID, "entry-taken", "new-case");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: taken,
				case_type: "household",
				case_name: "Already saved",
				status: "open",
				properties: JSON.stringify({}),
			},
		});
		let refusal: unknown;
		try {
			await store.applySubmission(registration("entry-taken"));
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(SubmissionRejectedError);
		expect((refusal as SubmissionRejectedError).rejection).toEqual({
			kind: "new-case",
			reason: "case-id-taken",
			caseId: taken,
		});
		expect((await stored("household")).map((row) => row.case_name)).toEqual([
			"Already saved",
		]);
		expect(await stored("member")).toEqual([]);
		// The refused entry claimed no receipt, so a corrected retry can save.
		const intents = await sql<{ count: string }>`
			SELECT count(*)::text AS count FROM form_submission_intents
			WHERE app_id = ${APP_ID} AND entry_key = 'entry-taken'
		`.execute(dbHandle.db);
		expect(intents.rows).toEqual([{ count: "0" }]);
	});
	it("refuses an entry id another tenant's save takes while this one runs", async () => {
		const taken = entryDatumCaseId(APP_ID, "entry-raced", "new-case");
		const rival = new Client({ connectionString: dbHandle.uri });
		await rival.connect();
		let rivalOpen = false;
		let outcome: Promise<unknown> | undefined;
		try {
			await rival.query("BEGIN");
			rivalOpen = true;
			await rival.query(
				"INSERT INTO apps (id, owner, project_id, app_name, app_name_lower) VALUES ('entry-ids-rival', 'rival', 'entry-ids-rival-project', 'Rival', 'rival')",
			);
			await rival.query(
				"INSERT INTO cases (case_id, app_id, project_id, owner_id, case_type, case_name, status, properties) VALUES ($1, 'entry-ids-rival', 'entry-ids-rival-project', 'rival', 'household', 'Rival household', 'open', '{}'::jsonb)",
				[taken],
			);
			// The rival's row is not yet visible, so only the insert itself can
			// see the id is taken: it waits on the rival's transaction.
			outcome = storeOn()
				.applySubmission(registration("entry-raced"))
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			// Read from the lock manager, which every query sees live. The
			// rival is inside its transaction, where `pg_stat_activity` keeps
			// the snapshot its first read took, so a wait that starts after
			// that read would never show there.
			await vi.waitFor(
				async () => {
					const blocked = await rival.query<{ count: string }>(
						"SELECT count(*)::text AS count FROM pg_locks WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))",
					);
					expect(blocked.rows[0]?.count).not.toBe("0");
				},
				{ timeout: 3_000, interval: 25 },
			);
			await rival.query("COMMIT");
			rivalOpen = false;
			const refusal = await outcome;
			expect(refusal).toBeInstanceOf(SubmissionRejectedError);
			expect((refusal as SubmissionRejectedError).rejection).toEqual({
				kind: "new-case",
				reason: "case-id-taken",
				caseId: taken,
			});
			expect(await stored("household")).toEqual([]);
			expect(await stored("member")).toEqual([]);
		} finally {
			try {
				// Releasing the rival lets a still-waiting submission finish,
				// so it is joined before the test ends.
				if (rivalOpen) await rival.query("ROLLBACK");
				await outcome;
			} finally {
				await rival.end();
			}
		}
	});
});
