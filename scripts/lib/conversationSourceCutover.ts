import { type Kysely, sql, type Transaction } from "kysely";
import { Migrator } from "kysely/migration";
import { caseStoreMigrations } from "@/lib/case-store/migrations";
import { createRetainedSourceStorage } from "@/lib/case-store/migrations/20261112010000_retained_conversation_sources";
import type { AppDatabase } from "@/lib/db/pg";
import { readDatabasePrivilegeRoleConfig } from "@/lib/db/privilegeConvergence";
import { retainThreadSource } from "@/lib/db/threadSources";
import { scanThreadStorage } from "@/lib/db/threadStorageScan";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	type SourceBaselineDeps,
	scanConversationSources,
} from "./conversationSourceBaseline";
import { assertThreadCutoverRuntimeStopped } from "./threadStorageCutover";

const MIGRATION = "20261112010000_retained_conversation_sources";

export async function migrateConversationSources(
	db: Kysely<AppDatabase>,
	expectedDigest: string,
	deps?: SourceBaselineDeps,
) {
	if (!/^[a-f0-9]{64}$/.test(expectedDigest))
		throw new Error("An exact source scan digest is required.");
	const roles = readDatabasePrivilegeRoleConfig();
	if (roles) await assertThreadCutoverRuntimeStopped(db, roles.runtimeRole);
	const migrator = new Migrator({
		db,
		provider: {
			getMigrations: async () => ({
				...caseStoreMigrations,
				[MIGRATION]: {
					up: async (database: Kysely<unknown>) => {
						const tx = database as unknown as Transaction<AppDatabase>;
						if (roles)
							await assertThreadCutoverRuntimeStopped(tx, roles.runtimeRole);
						await sql`SET LOCAL lock_timeout = '5s'`.execute(tx);
						await sql`LOCK TABLE apps, design_sessions, threads, media_assets IN ACCESS EXCLUSIVE MODE`.execute(
							tx,
						);
						if ((await scanThreadStorage(tx)).runningTargets > 0)
							throw new Error(
								"A run is still executing. Finish it before source retention.",
							);
						const captured = await scanConversationSources(tx, deps);
						if (captured.report.scanDigest !== expectedDigest)
							throw new Error(
								"Source scan changed. Scan again before the cutover.",
							);
						await createRetainedSourceStorage(database);
						for (const entry of captured.entries)
							await retainThreadSource(tx, entry);
						const links = await tx
							.selectFrom("thread_source_links")
							.selectAll()
							.execute();
						if (links.length !== captured.entries.length)
							throw new Error(
								"Source retention did not preserve every reference.",
							);
						for (const entry of captured.entries) {
							const link = links.find(
								(row) =>
									row.thread_id === entry.threadId &&
									row.message_id === entry.messageId &&
									row.asset_id === entry.assetId,
							);
							if (
								!link ||
								link.provenance !== entry.provenance ||
								link.filename !== entry.filename
							)
								throw new Error("Source reference verification failed.");
							if (entry.source) {
								const row = await tx
									.selectFrom("thread_source_contents")
									.selectAll()
									.where("thread_id", "=", entry.threadId)
									.where("revision", "=", link.revision)
									.executeTakeFirstOrThrow();
								const { filename: _filename, ...body } = entry.source;
								if (
									canonicalJsonDigest(row.content) !==
										canonicalJsonDigest(body) ||
									row.digest !== canonicalJsonDigest(body)
								)
									throw new Error("Retained content verification failed.");
							}
						}
						await sql`CREATE TABLE conversation_source_cutover (id boolean PRIMARY KEY CHECK(id), scan_digest text NOT NULL, retained_digest text NOT NULL)`.execute(
							tx,
						);
						const retainedDigest = await retainedSnapshotDigest(tx);
						await sql`INSERT INTO conversation_source_cutover VALUES (true, ${expectedDigest}, ${retainedDigest})`.execute(
							tx,
						);
					},
				},
			}),
		},
	});
	const applied = (await migrator.getMigrations()).some(
		(m) => m.name === MIGRATION && m.executedAt,
	);
	if (!applied) {
		const result = await migrator.migrateTo(MIGRATION);
		if (result.error) throw result.error;
	}
	const receipt = await sql<{
		scan_digest: string;
		retained_digest: string;
	}>`SELECT scan_digest, retained_digest FROM conversation_source_cutover WHERE id`.execute(
		db,
	);
	if (
		receipt.rows[0]?.scan_digest !== expectedDigest ||
		receipt.rows[0]?.retained_digest !== (await retainedSnapshotDigest(db))
	)
		throw new Error(
			"The source cutover receipt differs from the reviewed scan.",
		);
	return { applied: !applied, scanDigest: expectedDigest };
}

async function retainedSnapshotDigest(db: Kysely<AppDatabase>) {
	const contents = await db
		.selectFrom("thread_source_contents")
		.selectAll()
		.orderBy("thread_id")
		.orderBy("revision")
		.execute();
	for (const row of contents)
		if (canonicalJsonDigest(row.content) !== row.digest)
			throw new Error("Retained source content is damaged.");
	const links = await db
		.selectFrom("thread_source_links")
		.selectAll()
		.orderBy("thread_id")
		.orderBy("reference_key")
		.execute();
	return canonicalJsonDigest({ contents, links });
}
