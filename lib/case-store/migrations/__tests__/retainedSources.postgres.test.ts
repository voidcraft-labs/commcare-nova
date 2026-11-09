import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { expect, it } from "vitest";
import { insertThreadFixture } from "@/__tests__/helpers/threadFixture";
import type { AppDatabase } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { scanConversationSources } from "@/scripts/lib/conversationSourceBaseline";
import { migrateConversationSources } from "@/scripts/lib/conversationSourceCutover";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";

const MIGRATION = "20261112010000_retained_conversation_sources";
const database = setupPerTestDatabase({
	databaseNamePrefix: "retained_sources_migration_",
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
const documentId = "10000000-0000-4000-8000-000000000001";
const imageId = "10000000-0000-4000-8000-000000000002";
const missingId = "10000000-0000-4000-8000-000000000003";
const text = "Collect a referral reason. 保健";
const bytes = Buffer.from("historical figure");
const imageDigest = createHash("sha256").update(bytes).digest("hex");
const deps = { readText: async () => text, readBytes: async () => bytes };
async function seed() {
	await sql`INSERT INTO apps (id,owner,project_id,app_name,app_name_lower,status) VALUES ('app','owner','project','App','app','complete')`.execute(
		db(),
	);
	for (const [id, kind, mime, hash] of [
		[documentId, "pdf", "application/pdf", "original-document"],
		[imageId, "image", "image/png", imageDigest],
	]) {
		await sql`INSERT INTO media_assets (id,project_id,owner,content_hash,mime_type,extension,size_bytes,kind,gcs_object_key,original_filename,status,extract,media_format)
  VALUES (${id}::uuid,'project','owner',${hash},${mime},'.bin',100,${kind},'source-object','spec.pdf','ready',${JSON.stringify({ status: "ready", version: 3, model: "historical", truncated: false, charCount: text.length, extractedAt: 1 })}::jsonb,${kind === "image" ? "png" : null})`.execute(
			db(),
		);
	}
	const selected = {
		assetId: documentId,
		kind: "pdf",
		filename: "selected.pdf",
		mimeType: "application/pdf",
		contentHash: "original-document",
		extractVersion: 3,
		extractDigest: canonicalJsonDigest(text),
		revision: canonicalJsonDigest({
			contentHash: "original-document",
			extractVersion: 3,
			extractDigest: canonicalJsonDigest(text),
		}),
	};
	await insertThreadFixture(db(), {
		thread_id: "thread",
		app_id: "app",
		thread_type: "edit",
		run_id: "old-run",
		summary: "Source test",
		created_at: "2026-01-01",
		updated_at: "2026-01-01",
		selected_sources: JSON.stringify([selected]),
		messages: JSON.stringify(
			[documentId, documentId, imageId, missingId].map((id, index) => ({
				id: `message-${index}`,
				role: "user",
				parts: [],
				metadata: {
					attachments: [
						{
							assetId: id,
							kind: id === imageId ? "image" : "pdf",
							filename: `source-${index}`,
							mimeType: id === imageId ? "image/png" : "application/pdf",
						},
					],
				},
			})),
		),
	});
}
const scan = () =>
	db()
		.transaction()
		.setIsolationLevel("repeatable read")
		.execute((tx) => scanConversationSources(tx, deps));

it("retains exact available evidence once and distinguishes unverifiable legacy text and missing sources", async () => {
	await seed();
	const before = await scan();
	expect(before.report).toMatchObject({
		references: 5,
		verifiedLegacy: 2,
		migrationBaselines: 2,
		unavailable: 1,
		uniqueContents: 2,
	});
	const unattended = await new Migrator({
		db: db(),
		provider: { getMigrations: async () => caseStoreMigrations },
	}).migrateToLatest();
	expect(String(unattended.error)).toContain("source-retention cutover");
	expect(
		await migrateConversationSources(db(), before.report.scanDigest, deps),
	).toMatchObject({ applied: true });
	const contents = await db()
		.selectFrom("thread_source_contents")
		.selectAll()
		.execute();
	expect(contents).toHaveLength(2);
	expect(contents.map((r) => r.content)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				content: { kind: "document", text, version: 3, truncated: false },
			}),
			expect.objectContaining({
				content: expect.objectContaining({
					dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
				}),
			}),
		]),
	);
	expect(
		await migrateConversationSources(db(), before.report.scanDigest, deps),
	).toMatchObject({ applied: false });
	await sql`DELETE FROM media_assets`.execute(db());
	expect(
		await migrateConversationSources(db(), before.report.scanDigest, deps),
	).toMatchObject({ applied: false });
	await expect(
		sql`UPDATE thread_source_contents SET content='{}'`.execute(db()),
	).rejects.toThrow("immutable");
	await expect(
		sql`UPDATE thread_source_links SET filename='changed'`.execute(db()),
	).rejects.toThrow("immutable");
	await db().deleteFrom("threads").where("thread_id", "=", "thread").execute();
	expect(
		await db().selectFrom("thread_source_contents").selectAll().execute(),
	).toEqual([]);
	expect(
		await db().selectFrom("thread_source_links").selectAll().execute(),
	).toEqual([]);
});

it("refuses changed bytes and executing runs without installing retention storage", async () => {
	await seed();
	const before = await scan();
	await expect(
		migrateConversationSources(db(), before.report.scanDigest, {
			...deps,
			readText: async () => "Changed text",
		}),
	).rejects.toThrow("Source scan changed");
	await sql`UPDATE apps SET status='generating' WHERE id='app'`.execute(db());
	await expect(
		migrateConversationSources(db(), before.report.scanDigest, deps),
	).rejects.toThrow("still executing");
	expect(
		(
			await sql<{
				relation: string | null;
			}>`SELECT to_regclass('thread_source_contents')::text AS relation`.execute(
				db(),
			)
		).rows[0].relation,
	).toBeNull();
});

it("rolls back every copied source when the final migration receipt cannot commit", async () => {
	await seed();
	const before = await scan();
	await sql`CREATE FUNCTION fail_source_receipt() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN
 IF to_regclass('conversation_source_cutover') IS NOT NULL THEN RAISE EXCEPTION 'injected source receipt failure'; END IF;
 END $$`.execute(db());
	await sql`CREATE EVENT TRIGGER source_receipt_failure ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION fail_source_receipt()`.execute(
		db(),
	);
	try {
		await expect(
			migrateConversationSources(db(), before.report.scanDigest, deps),
		).rejects.toThrow("injected source receipt failure");
	} finally {
		await sql`DROP EVENT TRIGGER source_receipt_failure`.execute(db());
	}
	expect(
		(
			await sql<{
				relation: string | null;
			}>`SELECT to_regclass('thread_source_links')::text AS relation`.execute(
				db(),
			)
		).rows[0].relation,
	).toBeNull();
	expect((await scan()).report).toEqual(before.report);
	expect(
		await migrateConversationSources(db(), before.report.scanDigest, deps),
	).toMatchObject({ applied: true });
});

it("records missing image objects as unavailable but refuses unreadable or corrupt objects", async () => {
	await seed();
	for (const code of [403, 503]) {
		const error = Object.assign(new Error("storage failure"), { code });
		await expect(
			scanConversationSources(db(), {
				...deps,
				readBytes: async () => {
					throw error;
				},
			}),
		).rejects.toBe(error);
	}
	await expect(
		scanConversationSources(db(), {
			...deps,
			readBytes: async () => Buffer.from("different bytes"),
		}),
	).rejects.toThrow("immutable content hash");
	const missing = {
		...deps,
		readBytes: async (): Promise<Buffer> => {
			throw Object.assign(new Error("Not found"), { code: 404 });
		},
	};
	const before = await scanConversationSources(db(), missing);
	expect(before.report).toMatchObject({
		references: 5,
		unavailable: 2,
		verifiedLegacy: 1,
		migrationBaselines: 2,
	});
	await migrateConversationSources(db(), before.report.scanDigest, missing);
	expect(
		await db()
			.selectFrom("thread_source_links")
			.select(["provenance", "revision"])
			.where("asset_id", "=", imageId)
			.executeTakeFirstOrThrow(),
	).toEqual({ provenance: "unavailable", revision: null });
});
