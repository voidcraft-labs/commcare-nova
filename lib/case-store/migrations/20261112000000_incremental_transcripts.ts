import { type Kysely, sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import {
	hasLegacyThreadStorage,
	scanThreadStorage,
} from "@/lib/db/threadStorageScan";
import {
	threadMessagesSql,
	writeThreadTranscript,
} from "@/lib/db/threadTranscript";

/** The ordinary deploy may initialize an empty database, but cannot remove a
 * column the serving revision reads. Populated databases require the explicit
 * scan-fenced maintenance command, which runs this migration through Kysely's
 * own transaction and ledger after runtime access has been stopped. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await convertThreadStorage(db);
}

export async function convertThreadStorage(
	db: Kysely<unknown>,
	expectedDigest?: string,
): Promise<void> {
	await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
	await sql`LOCK TABLE apps, design_sessions, threads IN ACCESS EXCLUSIVE MODE`.execute(
		db,
	);
	if (!(await hasLegacyThreadStorage(db))) return;
	const typed = db as unknown as Transaction<AppDatabase>;
	const before = await scanThreadStorage(typed);
	if (before.threads > 0 && expectedDigest === undefined) {
		throw new Error(
			"Incremental transcript storage requires the reviewed direct maintenance cutover. Run scan-thread-storage, drain runtime access, then migrate-thread-storage with its exact digest before deploying.",
		);
	}
	if (
		expectedDigest !== undefined &&
		expectedDigest !== before.transcriptDigest
	) {
		throw new Error("Transcript scan changed. Scan again before the cutover.");
	}
	if (before.invalidThreads > 0 || before.lossyThreads > 0)
		throw new Error(
			"Invalid or lossy historical transcript values require disposition before the cutover.",
		);
	// Paused and interrupted conversations keep their exact holders, credits
	// and replay markers. Only an executing run must finish before shutdown;
	// the runtime-offline fence prevents any holder from resuming during DDL.
	if (before.runningTargets > 0) {
		throw new Error("A run is still executing. Finish it before the cutover.");
	}
	await sql`CREATE TABLE thread_messages (
		thread_id text NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
		ordinal integer NOT NULL CHECK (ordinal >= 0),
		message_id text NOT NULL,
		data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND NOT data ? 'parts'),
		digest text NOT NULL CHECK (length(digest) = 64),
		part_count integer NOT NULL CHECK (part_count >= 0),
		PRIMARY KEY (thread_id, ordinal),
		CHECK (data->>'id' = message_id)
	)`.execute(db);
	await sql`CREATE INDEX thread_messages_identity ON thread_messages(thread_id, message_id)`.execute(
		db,
	);
	await sql`CREATE TABLE thread_message_parts (
		thread_id text NOT NULL,
		message_ordinal integer NOT NULL,
		ordinal integer NOT NULL CHECK (ordinal >= 0),
		data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
		digest text NOT NULL CHECK (length(digest) = 64),
		PRIMARY KEY (thread_id, message_ordinal, ordinal),
		FOREIGN KEY (thread_id, message_ordinal) REFERENCES thread_messages(thread_id, ordinal) ON DELETE CASCADE
	)`.execute(db);
	let after: string | undefined;
	while (true) {
		const rows = await sql<{
			thread_id: string;
			messages: unknown[];
		}>`SELECT thread_id, messages FROM threads WHERE (${after === undefined} OR thread_id > ${after ?? ""}) ORDER BY thread_id LIMIT 25`.execute(
			db,
		);
		if (!rows.rows.length) break;
		for (const row of rows.rows) {
			await writeThreadTranscript(typed, row.thread_id, row.messages);
			const retained = await typed
				.selectFrom("threads")
				.select(
					sql<boolean>`${threadMessagesSql()} = threads.messages`.as(
						"unchanged",
					),
				)
				.where("thread_id", "=", row.thread_id)
				.executeTakeFirstOrThrow();
			if (!retained.unchanged)
				throw new Error(
					"Transcript reconstruction changed a historical message. Cutover rolled back.",
				);
			after = row.thread_id;
		}
	}
	await sql`ALTER TABLE threads DROP COLUMN messages`.execute(db);
	const verified = await scanThreadStorage(typed);
	if (
		verified.transcriptDigest !== before.transcriptDigest ||
		verified.invalidStoredRows > 0
	)
		throw new Error("Transcript cutover verification failed.");
}

export async function down(): Promise<void> {
	throw new Error(
		"Incremental transcript storage is forward-only; restoring the old writer requires a reviewed maintenance conversion.",
	);
}
