import { type Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { expect, it } from "vitest";
import type { AppDatabase } from "@/lib/db/pg";
import {
	hasLegacyThreadStorage,
	scanThreadStorage,
} from "@/lib/db/threadStorageScan";
import { threadMessagesSql } from "@/lib/db/threadTranscript";
import { migrateThreadStorage } from "@/scripts/lib/threadStorageCutover";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";

const MIGRATION = "20261112000000_incremental_transcripts";
const database = setupPerTestDatabase({
	databaseNamePrefix: "thread_storage_cutover_",
	establishLocalMigrationAuthority: true,
	prepareTemplate: async (db) => {
		const result = await new Migrator({
			db,
			provider: {
				getMigrations: async () =>
					Object.fromEntries(
						Object.entries(caseStoreMigrations).filter(
							([name]) => name < MIGRATION,
						),
					),
			},
		}).migrateToLatest();
		if (result.error) throw result.error;
	},
});
const db = () => database.db as Kysely<AppDatabase>;
const history = [
	{
		id: "request",
		role: "user",
		parts: [{ type: "text", text: "Requirements\n保健" }],
		metadata: {
			attachments: [
				{
					assetId: "10000000-0000-4000-8000-000000000001",
					kind: "pdf",
					filename: "requirements.pdf",
					mimeType: "application/pdf",
				},
			],
		},
	},
	{
		id: "answer",
		role: "assistant",
		parts: [
			{
				type: "tool-retired",
				toolCallId: "call",
				state: "output-available",
				input: { option: null },
				output: { preserved: [0, false, ""] },
			},
			{ type: "text", text: "Answer" },
		],
	},
];

async function seed() {
	await sql`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower, status) VALUES ('app', 'owner', 'project', 'App', 'app', 'complete')`.execute(
		database.db,
	);
	// An empty thread id is legal in the old schema and must not vanish from
	// cursor scans; repeated message ids likewise retain array order.
	await sql`INSERT INTO threads (thread_id, app_id, created_at, updated_at, thread_type, summary, run_id, messages, clawed_back_ids)
		VALUES ('', 'app', '2026-01-01', '2026-01-02', 'edit', 'Synthetic', 'historical', ${JSON.stringify(history)}::jsonb, '[{"id":"failed","cap":0}]'::jsonb),
		('other', 'app', '2026-01-01', '2026-01-02', 'edit', 'Synthetic', 'historical', ${JSON.stringify([history[1], history[1]])}::jsonb, '[]'::jsonb)`.execute(
		database.db,
	);
}

const scan = () =>
	db()
		.transaction()
		.setIsolationLevel("repeatable read")
		.execute(scanThreadStorage);

it("requires an explicit scan-fenced cutover and preserves every historical value and marker", async () => {
	await seed();
	const before = await scan();
	expect(before).toMatchObject({
		threads: 2,
		messages: 4,
		duplicateMessageIds: 1,
		invalidThreads: 0,
	});
	const unattended = await new Migrator({
		db: database.db,
		provider: { getMigrations: async () => caseStoreMigrations },
	}).migrateToLatest();
	expect(unattended.error).toBeInstanceOf(Error);
	expect(String(unattended.error)).toContain("direct maintenance cutover");
	expect(await hasLegacyThreadStorage(database.db)).toBe(true);
	const applied = await migrateThreadStorage(db(), before.transcriptDigest);
	expect(applied).toMatchObject({
		applied: true,
		format: "message-parts",
		transcriptDigest: before.transcriptDigest,
		invalidStoredRows: 0,
	});
	expect(await hasLegacyThreadStorage(database.db)).toBe(false);
	const row = await db()
		.selectFrom("threads")
		.select([
			"updated_at",
			"clawed_back_ids",
			"active_stream_id",
			threadMessagesSql().as("messages"),
		])
		.where("thread_id", "=", "")
		.executeTakeFirstOrThrow();
	expect(row).toEqual({
		messages: history,
		updated_at: "2026-01-02",
		clawed_back_ids: [{ id: "failed", cap: 0 }],
		active_stream_id: null,
	});
	expect(
		(await migrateThreadStorage(db(), before.transcriptDigest)).applied,
	).toBe(false);
});

it("refuses a changed scan and active work before altering storage", async () => {
	await seed();
	const before = await scan();
	await sql`UPDATE threads SET messages = messages || '[{"id":"new","role":"user","parts":[]}]'::jsonb WHERE thread_id = ''`.execute(
		database.db,
	);
	await expect(
		migrateThreadStorage(db(), before.transcriptDigest),
	).rejects.toThrow("scan changed");
	const fresh = await scan();
	await sql`UPDATE apps SET status = 'generating' WHERE id = 'app'`.execute(
		database.db,
	);
	await expect(
		migrateThreadStorage(db(), fresh.transcriptDigest),
	).rejects.toThrow("run is still executing");
	expect(await hasLegacyThreadStorage(database.db)).toBe(true);
	expect(
		(
			await sql<{
				relation: string | null;
			}>`SELECT to_regclass('thread_messages')::text AS relation`.execute(
				database.db,
			)
		).rows[0].relation,
	).toBeNull();
});

it("reports and refuses historical values that JSON decoding would change", async () => {
	await seed();
	await sql`UPDATE threads SET messages = '[{"id":"overflow","role":"assistant","parts":[{"type":"tool-old","output":1e400}]}]'::jsonb WHERE thread_id = 'other'`.execute(
		database.db,
	);
	const before = await scan();
	expect(before.lossyThreads).toBe(1);
	await expect(
		migrateThreadStorage(db(), before.transcriptDigest),
	).rejects.toThrow("Invalid or lossy");
	expect(await hasLegacyThreadStorage(database.db)).toBe(true);
	expect(
		(
			await sql<{
				relation: string | null;
			}>`SELECT to_regclass('thread_messages')::text AS relation`.execute(
				database.db,
			)
		).rows[0].relation,
	).toBeNull();
	expect((await scan()).transcriptDigest).toBe(before.transcriptDigest);
});

it("detects damaged normalized parts instead of certifying a successful retry", async () => {
	await seed();
	const before = await scan();
	await migrateThreadStorage(db(), before.transcriptDigest);
	await db()
		.updateTable("thread_message_parts")
		.set({ data: JSON.stringify({ type: "text", text: "changed" }) })
		.where("thread_id", "=", "")
		.where("message_ordinal", "=", 0)
		.execute();
	expect((await scan()).invalidStoredRows).toBeGreaterThan(0);
	await expect(
		migrateThreadStorage(db(), before.transcriptDigest),
	).rejects.toThrow("durable transcript differs");
});

it("keeps paused holders, reservations and input rounds available for cold resume", async () => {
	await seed();
	await sql`UPDATE apps SET status = 'generating', awaiting_input = true,
		run_id = 'paused-run', run_holder_nonce = '10000000-0000-4000-8000-000000000002',
		res_period = '2026-11', res_reserved = 100, res_settled = false, res_user_id = 'owner', res_run_id = 'paused-run'
		WHERE id = 'app'`.execute(database.db);
	await sql`UPDATE threads SET active_stream_id = 'paused-stream',
		active_holder_nonce = '10000000-0000-4000-8000-000000000002',
		input_round = '{"id":"paused-round","kind":"message","state":"pending","assistantMessageId":"answer","toolCallIds":[],"acceptedStreamId":null}'::jsonb
		WHERE thread_id = ''`.execute(database.db);
	const authority =
		await sql`SELECT to_jsonb(apps) AS data FROM apps WHERE id = 'app'`.execute(
			database.db,
		);
	const markers =
		await sql`SELECT active_stream_id, active_holder_nonce, input_round FROM threads ORDER BY thread_id`.execute(
			database.db,
		);
	const before = await scan();
	expect(before).toMatchObject({ pausedTargets: 1, runningTargets: 0 });
	await migrateThreadStorage(db(), before.transcriptDigest);
	expect(
		(
			await sql`SELECT to_jsonb(apps) AS data FROM apps WHERE id = 'app'`.execute(
				database.db,
			)
		).rows,
	).toEqual(authority.rows);
	expect(
		(
			await sql`SELECT active_stream_id, active_holder_nonce, input_round FROM threads ORDER BY thread_id`.execute(
				database.db,
			)
		).rows,
	).toEqual(markers.rows);
});

it("rolls back all new rows and DDL when the final column cutover fails", async () => {
	await seed();
	const before = await scan();
	await sql`CREATE FUNCTION refuse_thread_column_cutover() RETURNS event_trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'controlled column cutover failure'; END $$`.execute(
		database.db,
	);
	await sql`CREATE EVENT TRIGGER refuse_thread_column_cutover ON ddl_command_start WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION refuse_thread_column_cutover()`.execute(
		database.db,
	);
	try {
		await expect(
			migrateThreadStorage(db(), before.transcriptDigest),
		).rejects.toThrow("controlled column cutover failure");
		expect(await hasLegacyThreadStorage(database.db)).toBe(true);
		expect(
			(
				await sql<{
					relation: string | null;
				}>`SELECT to_regclass('thread_messages')::text AS relation`.execute(
					database.db,
				)
			).rows[0].relation,
		).toBeNull();
		expect((await scan()).transcriptDigest).toBe(before.transcriptDigest);
	} finally {
		await sql`DROP EVENT TRIGGER refuse_thread_column_cutover`.execute(
			database.db,
		);
	}
	expect(
		(await migrateThreadStorage(db(), before.transcriptDigest)).applied,
	).toBe(true);
});
