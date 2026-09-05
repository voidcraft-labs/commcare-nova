// `syncUsercaseRow` against real Postgres.
//
// The pure halves are pinned in `lib/domain/__tests__/usercase.test.ts`. What
// only a database can show is the part that matters most: that a re-sync
// MERGES rather than replaces, so a value a form wrote through
// `usercase_update` is still there after the next persona edit. Two layers
// have to agree for that — the diff picks the changed keys, and
// `CaseStore.update` JSONB-merges the patch — and a unit test of either alone
// would pass while the pair was broken.

import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import {
	type PersistableDoc,
	USERCASE_CASE_TYPE,
	usercaseCaseType,
} from "@/lib/domain";
import { syncUsercaseRow } from "../syncUsercaseRow";

const APP_ID = "app-usercase-sync";
const PROJECT_ID = "project-1";
const PERSONA_ID = "3f2b1c8e-5d4a-4b7c-9e1f-0a2b3c4d5e6f";

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "usercase_sync_test_",
});

beforeEach(async () => {
	// `cases` carries a `(project_id, app_id)` tenancy foreign key, so a row
	// cannot exist without its app. Seeding it is what makes this a real
	// tenancy test rather than one against a table with the fence removed.
	await sql`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES (
			${APP_ID},
			${"member-1"},
			${PROJECT_ID},
			${"Usercase sync fixture"},
			${"usercase sync fixture"}
		)
	`.execute(dbHandle.db);
});

const WORKER = {
	id: PERSONA_ID,
	username: "amara",
	personName: "Amara Diallo",
	email: "",
	locationIds: [],
};

function doc(
	properties: ReadonlyArray<{ uuid: string; slug: string; label: string }>,
): PersistableDoc {
	return {
		appId: APP_ID,
		appName: "Usercase Sync",
		connectType: null,
		caseTypes: [],
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		userProperties: Object.fromEntries(
			properties.map((property) => [property.uuid, property]),
		),
	} as unknown as PersistableDoc;
}

/** A store bound to the worker, which is what stamps `owner_id` on insert. */
function workerStore(ownerId: string = PERSONA_ID) {
	return new PostgresCaseStore({
		projectId: PROJECT_ID,
		actorUserId: "member-1",
		ownerId,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

async function seedSchema(d: PersistableDoc): Promise<void> {
	await workerStore().applySchemaChange({
		appId: APP_ID,
		caseType: USERCASE_CASE_TYPE,
		caseTypeSchemas: new Map([[USERCASE_CASE_TYPE, usercaseCaseType(d)]]),
	});
}

async function storedRow(): Promise<{
	case_id: string;
	owner_id: string | null;
	case_name: string;
	status: string | null;
	external_id: string | null;
	properties: Record<string, unknown>;
}> {
	const rows = await dbHandle.pool.query(
		"SELECT case_id, owner_id, case_name, status, external_id, properties FROM cases WHERE app_id = $1 AND case_type = $2",
		[APP_ID, USERCASE_CASE_TYPE],
	);
	expect(rows.rows).toHaveLength(1);
	return rows.rows[0];
}

describe("syncUsercaseRow", () => {
	const CADRE = { uuid: "u-1", slug: "cadre", label: "Cadre" };

	it("creates the worker's case, owned by and identified as the worker", async () => {
		const d = doc([CADRE]);
		await seedSchema(d);

		const outcome = await syncUsercaseRow(workerStore(), {
			appId: APP_ID,
			worker: WORKER,
			authored: { "u-1": "nurse" },
			doc: d,
			projectSpace: "my-domain",
		});

		expect(outcome.created).toBe(true);
		const row = await storedRow();
		// The id IS the worker's id — that is what makes a second sync collide
		// rather than create a second usercase.
		expect(row.case_id).toBe(PERSONA_ID);
		expect(row.owner_id).toBe(PERSONA_ID);
		expect(row.case_name).toBe("Amara Diallo");
		expect(row.status).toBe("open");
		expect(row.properties.cadre).toBe("nurse");
		expect(row.properties.hq_user_id).toBe(PERSONA_ID);
		// `case_name` is a column, never a duplicate JSONB key.
		expect(Object.hasOwn(row.properties, "case_name")).toBe(false);
	});

	it("is idempotent — a second sync writes nothing and makes no second row", async () => {
		const d = doc([CADRE]);
		await seedSchema(d);
		const args = {
			appId: APP_ID,
			worker: WORKER,
			authored: { "u-1": "nurse" },
			doc: d,
			projectSpace: "my-domain",
		};

		await syncUsercaseRow(workerStore(), args);
		const second = await syncUsercaseRow(workerStore(), args);

		expect(second.created).toBe(false);
		expect(second.changed).toBe(0);
		await storedRow(); // asserts exactly one row survives
	});

	it("reports what the ROW holds, not what this sync changed", async () => {
		// Preview hands `stored` straight to `ResolvedPreviewIdentity.usercase`,
		// because `#user/<prop>` resolves against `casedb` on the wire and the
		// row is therefore the truth. Returning the diff instead would leave a
		// worker's whole record blank on every sync that changed nothing, which
		// is the overwhelmingly common one.
		const d = doc([CADRE]);
		await seedSchema(d);
		const args = {
			appId: APP_ID,
			worker: WORKER,
			authored: { "u-1": "nurse" },
			doc: d,
			projectSpace: "my-domain",
		};

		await syncUsercaseRow(workerStore(), args);
		const second = await syncUsercaseRow(workerStore(), args);

		expect(second.changed).toBe(0);
		expect(second.stored.cadre).toBe("nurse");
		expect(second.stored.hq_user_id).toBe(PERSONA_ID);
		expect(second.stored.username).toBe("amara");
	});

	it("reports the value a sync just wrote, not the one it replaced", async () => {
		const d = doc([CADRE]);
		await seedSchema(d);
		await syncUsercaseRow(workerStore(), {
			appId: APP_ID,
			worker: WORKER,
			authored: { "u-1": "nurse" },
			doc: d,
			projectSpace: "my-domain",
		});

		const updated = await syncUsercaseRow(workerStore(), {
			appId: APP_ID,
			worker: WORKER,
			authored: { "u-1": "driver" },
			doc: d,
			projectSpace: "my-domain",
		});

		expect(updated.stored.cadre).toBe("driver");
		// And still everything the update did not name.
		expect(updated.stored.hq_user_id).toBe(PERSONA_ID);
	});

	it("refuses a property the case type does not declare, at the storage layer", async () => {
		// A finding, not a limitation to work around. `usercaseChangedFields`
		// never REMOVES a key, so a value outside the desired record survives
		// the diff — but it cannot survive the schema, because
		// `CaseStore.update` re-validates the MERGED document and the usercase
		// case type is derived from the worker-property catalog with
		// `additionalProperties: false`.
		//
		// So an undeclared usercase write destination is not merely
		// discouraged, it is unstorable. PR 4's `caseWrite` admission has to
		// REFUSE one with something an author can act on, rather than letting
		// it reach a form and fail at submission with a schema error naming a
		// JSON Schema keyword.
		const d = doc([CADRE]);
		await seedSchema(d);
		await syncUsercaseRow(workerStore(), {
			appId: APP_ID,
			worker: WORKER,
			authored: { "u-1": "nurse" },
			doc: d,
			projectSpace: "my-domain",
		});

		await expect(
			workerStore().update({
				appId: APP_ID,
				caseId: PERSONA_ID,
				patch: { properties: { visits_done: "12" } },
			}),
		).rejects.toThrow(/visits_done/);
	});

	it("keeps a declared property a form changed, when the persona has no value for it", async () => {
		// The never-clobber contract as Nova can actually reach it. `cadre` is
		// declared but the persona carries no value, so the desired record has
		// it blank — and a blank is a real value HQ writes on purpose, so the
		// sync DOES overwrite. This pins that behaviour rather than wishing it
		// away: it is `_get_user_case_fields` building from
		// `UserData.to_dict()`, which seeds every declared field blank before
		// layering anything on top, and a device sees exactly this.
		const d = doc([CADRE]);
		await seedSchema(d);
		await syncUsercaseRow(workerStore(), {
			appId: APP_ID,
			worker: WORKER,
			authored: { "u-1": "nurse" },
			doc: d,
			projectSpace: "my-domain",
		});
		expect((await storedRow()).properties.cadre).toBe("nurse");

		// The persona's value is cleared. The next sync writes the blank.
		const outcome = await syncUsercaseRow(workerStore(), {
			appId: APP_ID,
			worker: WORKER,
			authored: {},
			doc: d,
			projectSpace: "my-domain",
		});

		expect(outcome.changed).toBe(1);
		const row = await storedRow();
		expect(row.properties.cadre).toBe("");
		// Everything the sync did not name is untouched — the merge, not a
		// replacement.
		expect(row.properties.hq_user_id).toBe(PERSONA_ID);
		expect(row.properties.username).toBe("amara");
	});

	it("ensureOnly leaves a form-written value alone, and still reports it", async () => {
		// Preview's reason for calling this is EXISTENCE, not step: it resolves
		// an identity on every render, and a full sync there would erase what a
		// form had just written onto the record — `cadre` is declared and the
		// persona has no value for it, so the diff above would blank it seconds
		// after the worker answered. Keeping a worker in step is the commit
		// path's job, which runs when the document actually says something new.
		const d = doc([CADRE]);
		await seedSchema(d);
		await syncUsercaseRow(workerStore(), {
			appId: APP_ID,
			worker: WORKER,
			authored: { "u-1": "nurse" },
			doc: d,
			projectSpace: "my-domain",
		});

		const outcome = await syncUsercaseRow(workerStore(), {
			appId: APP_ID,
			worker: WORKER,
			authored: {},
			doc: d,
			projectSpace: "my-domain",
			ensureOnly: true,
		});

		expect(outcome.created).toBe(false);
		expect(outcome.changed).toBe(0);
		// What it REPORTS is the row, because the row is what a device reads.
		expect(outcome.stored.cadre).toBe("nurse");
		expect((await storedRow()).properties.cadre).toBe("nurse");
	});

	it("ensureOnly still creates the row when the worker has none", async () => {
		const d = doc([CADRE]);
		await seedSchema(d);
		const outcome = await syncUsercaseRow(workerStore(), {
			appId: APP_ID,
			worker: WORKER,
			authored: { "u-1": "nurse" },
			doc: d,
			projectSpace: "my-domain",
			ensureOnly: true,
		});

		expect(outcome.created).toBe(true);
		expect((await storedRow()).properties.cadre).toBe("nurse");
	});

	it("leaves external_id empty, because HQ never writes one", async () => {
		// HQ FINDS a usercase by external id (`get_case_by_external_id`, reached
		// from `CouchUser.get_usercase`) but never WRITES one:
		// `_get_user_case_fields` sets it nowhere and `create_usercase` passes it
		// nowhere. The read/write asymmetry is easy to mistake for an omission,
		// so this test is here to argue with the later helpful fix — writing it
		// would make `#user/external_id = ''` answer one way in Preview and the
		// other in the field.
		const d = doc([CADRE]);
		await seedSchema(d);
		await syncUsercaseRow(workerStore(), {
			appId: APP_ID,
			worker: WORKER,
			authored: { "u-1": "nurse" },
			doc: d,
			projectSpace: "my-domain",
		});

		const row = await storedRow();
		expect(row.external_id).toBeNull();
		expect(Object.hasOwn(row.properties, "external_id")).toBe(false);
	});

	it("puts the row inside its own worker's restore", async () => {
		// The wire emits `<assert test="count(instance('casedb')/casedb/case[
		// @case_type='commcare-user'][hq_user_id=…]) = 1">`, and a device
		// evaluates that against what its restore delivered. A usercase outside
		// its own worker's restore would fail that assertion and block entry
		// into the form entirely, so this is the row's whole reason for being
		// owned by the worker rather than by the author.
		const d = doc([CADRE]);
		await seedSchema(d);
		await syncUsercaseRow(workerStore(), {
			appId: APP_ID,
			worker: WORKER,
			authored: { "u-1": "nurse" },
			doc: d,
			projectSpace: "my-domain",
		});

		const held = await workerStore().query({
			appId: APP_ID,
			caseType: USERCASE_CASE_TYPE,
			caseTypeSchemas: new Map([[USERCASE_CASE_TYPE, usercaseCaseType(d)]]),
			restoreScope: { ownerIds: [PERSONA_ID] },
		});
		expect(held.map((row) => row.case_id)).toEqual([PERSONA_ID]);

		// And outside anyone else's. Another worker restoring must not receive
		// it — `count(…) = 1` is an equality, so a second usercase in scope
		// fails the assertion exactly as zero does.
		const someoneElse = await workerStore().query({
			appId: APP_ID,
			caseType: USERCASE_CASE_TYPE,
			caseTypeSchemas: new Map([[USERCASE_CASE_TYPE, usercaseCaseType(d)]]),
			restoreScope: { ownerIds: ["a-different-worker"] },
		});
		expect(someoneElse).toEqual([]);
	});

	it("renames the case when the worker's display name changes", async () => {
		const d = doc([]);
		await seedSchema(d);
		await syncUsercaseRow(workerStore(), {
			appId: APP_ID,
			worker: WORKER,
			authored: {},
			doc: d,
			projectSpace: "my-domain",
		});

		await syncUsercaseRow(workerStore(), {
			appId: APP_ID,
			worker: { ...WORKER, personName: "Amara Sow" },
			authored: {},
			doc: d,
			projectSpace: "my-domain",
		});

		expect((await storedRow()).case_name).toBe("Amara Sow");
	});

	it("names the case for the login when the worker has no display name", async () => {
		// `cases.case_name` is NOT NULL, so this is a failed INSERT rather than
		// an ugly row if the fallback is missing.
		const d = doc([]);
		await seedSchema(d);
		await syncUsercaseRow(workerStore(), {
			appId: APP_ID,
			worker: { ...WORKER, personName: "  " },
			authored: {},
			doc: d,
			projectSpace: "my-domain",
		});
		expect((await storedRow()).case_name).toBe("amara");
	});
});
