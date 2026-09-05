import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { readCasePropertyRenameStoragePreflightInTransaction } from "../../casePropertyRenamePreflight";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";

const database = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "case_property_rename_preflight_",
});
const APP_ID = "rename-preflight-app";

function db(): Kysely<Database> {
	return database.db as unknown as Kysely<Database>;
}

async function insertCase(args: {
	readonly caseId: string;
	readonly appId?: string;
	readonly caseType?: string;
	readonly projectId: string;
	readonly ownerId: string;
	readonly properties: unknown;
}): Promise<void> {
	await sql`
		INSERT INTO cases (
			case_id, app_id, case_type, project_id, owner_id, status,
			opened_on, modified_on, closed_on, case_name, external_id,
			parent_case_id, properties
		)
		VALUES (
			${args.caseId},
			${args.appId ?? APP_ID},
			${args.caseType ?? "patient"},
			${args.projectId},
			${args.ownerId},
			'open',
			'2026-07-30T00:00:00Z',
			'2026-07-30T00:00:00Z',
			NULL,
			${args.caseId},
			NULL,
			NULL,
			${JSON.stringify(args.properties)}::jsonb
		)
	`.execute(database.db);
}

async function insertParked(args: {
	readonly id: string;
	readonly caseId: string;
	readonly property: string;
	readonly dismissed?: boolean;
}): Promise<void> {
	await sql`
		INSERT INTO parked_case_values (
			id, app_id, case_id, case_type, property, original_value,
			reason, from_type, to_type, dismissed_at
		)
		VALUES (
			${args.id}::uuid,
			${APP_ID},
			${args.caseId},
			'patient',
			${args.property},
			'"saved"'::jsonb,
			'preflight fixture',
			'text',
			'text',
			${args.dismissed ? "2026-07-30T01:00:00Z" : null}::timestamptz
		)
	`.execute(database.db);
}

beforeEach(async () => {
	await sql`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES
			(${APP_ID}, 'owner-a', 'project-a', 'Rename', 'rename'),
			('another-app', 'owner-a', 'project-a', 'Other', 'other')
	`.execute(database.db);
});

describe("case-property rename storage preflight", () => {
	it("counts a simultaneous chain across all owners, held rows, and dismissed parks", async () => {
		await insertCase({
			caseId: "case-a",
			projectId: "project-a",
			ownerId: "owner-a",
			properties: { a: "alpha", b: "bravo" },
		});
		await insertCase({
			caseId: "case-b",
			projectId: "project-a",
			ownerId: "owner-b",
			properties: { a: null },
		});
		await insertCase({
			caseId: "foreign-app-case",
			appId: "another-app",
			projectId: "project-a",
			ownerId: "owner-a",
			properties: { a: "ignored", b: "ignored" },
		});
		await insertParked({
			id: "10000000-0000-0000-0000-000000000001",
			caseId: "case-a",
			property: "a",
		});
		await insertParked({
			id: "10000000-0000-0000-0000-000000000002",
			caseId: "case-a",
			property: "b",
			dismissed: true,
		});

		const result = await db()
			.transaction()
			.execute((tx) =>
				readCasePropertyRenameStoragePreflightInTransaction(tx, {
					appId: APP_ID,
					entries: [
						{ caseType: "patient", from: "a", to: "b" },
						{ caseType: "patient", from: "b", to: "c" },
					],
				}),
			);

		expect(result).toEqual({
			renamedRows: 2,
			renamedParkedValues: 2,
			byRename: [
				{
					caseType: "patient",
					from: "a",
					to: "b",
					rowsWithSource: 2,
					parkedValuesWithSource: 1,
				},
				{
					caseType: "patient",
					from: "b",
					to: "c",
					rowsWithSource: 1,
					parkedValuesWithSource: 1,
				},
			],
			conflicts: [],
		});
	});

	it("counts own null/blank destination keys and every parked destination but exempts moving sources", async () => {
		await insertCase({
			caseId: "case-null",
			projectId: "project-a",
			ownerId: "owner-a",
			properties: { a: "source", fresh: null },
		});
		await insertCase({
			caseId: "case-blank",
			projectId: "project-a",
			ownerId: "owner-b",
			properties: { fresh: "" },
		});
		await insertParked({
			id: "20000000-0000-0000-0000-000000000001",
			caseId: "case-null",
			property: "fresh",
		});
		await insertParked({
			id: "20000000-0000-0000-0000-000000000002",
			caseId: "case-null",
			property: "fresh",
			dismissed: true,
		});

		const conflict = await db()
			.transaction()
			.execute((tx) =>
				readCasePropertyRenameStoragePreflightInTransaction(tx, {
					appId: APP_ID,
					entries: [{ caseType: "patient", from: "a", to: "fresh" }],
				}),
			);
		expect(conflict.conflicts).toEqual([
			{
				caseType: "patient",
				property: "fresh",
				carrier: "case-row",
				count: 2,
			},
			{
				caseType: "patient",
				property: "fresh",
				carrier: "parked-value",
				count: 2,
			},
		]);

		const swap = await db()
			.transaction()
			.execute((tx) =>
				readCasePropertyRenameStoragePreflightInTransaction(tx, {
					appId: APP_ID,
					entries: [
						{ caseType: "patient", from: "a", to: "fresh" },
						{ caseType: "patient", from: "fresh", to: "a" },
					],
				}),
			);
		expect(swap.conflicts).toEqual([]);
		expect(swap.renamedRows).toBe(2);
		expect(swap.renamedParkedValues).toBe(2);
	});
});
