/**
 * The 20260809000000_design_sessions backfill — the split of the media
 * reference projection over EXISTING data: a database migrated to the prior
 * head, carrying an app-wide `media_asset_refs` set (Blueprint + thread
 * carriers combined, the old shape) and transcripts with attachments, must
 * come out of the migration with `thread_media_refs` holding the exact
 * per-thread conversation sets and `media_asset_refs` rebuilt to the
 * Blueprint-only projection. Replay must converge, not duplicate.
 */
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { canonicalTestBlueprint } from "@/lib/db/__tests__/appStateTestDb";
import { decomposeBlueprint } from "@/lib/db/blueprintRows";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { caseStoreMigrations } from "../index";

const MIGRATION_NAME = "20260809000000_design_sessions";
const handle = setupPerTestDatabase({ databaseNamePrefix: "ds_backfill_" });

const LOGO_ASSET = "90000000-0000-4000-8000-000000000001";
const THREAD_ASSET = "90000000-0000-4000-8000-000000000002";
const APP = "app-backfill";
const PROJECT = "project-backfill";

function migrator(upTo: (name: string) => boolean): Migrator {
	const db = new Kysely<unknown>({
		dialect: new PostgresDialect({
			pool: handle.pool as unknown as PostgresPool,
		}),
	});
	return new Migrator({
		db,
		provider: {
			getMigrations: async () =>
				Object.fromEntries(
					Object.entries(caseStoreMigrations).filter(([name]) => upTo(name)),
				),
		},
	});
}

async function seedOldShape(): Promise<void> {
	const doc = toPersistableDoc(canonicalTestBlueprint(APP, "Backfill App"));
	const rows = decomposeBlueprint({ ...doc, logo: LOGO_ASSET });
	await handle.pool.query(
		`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower, connect_type,
			case_types, logo, module_count, form_count, mutation_seq, status,
			awaiting_input, error_type, deleted_at, recoverable_until, run_id)
		 VALUES ($1, 'owner-test', $2, 'Backfill App', 'backfill app', NULL,
			NULL, $3, 1, 1, 0, 'complete', false, NULL, NULL, NULL, NULL)`,
		[APP, PROJECT, LOGO_ASSET],
	);
	for (const row of rows) {
		await handle.pool.query(
			`INSERT INTO blueprint_entities (app_id, uuid, kind, parent_uuid, ordinal, data)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[
				APP,
				row.uuid,
				row.kind,
				row.parent_uuid,
				row.ordinal,
				JSON.stringify(row.data),
			],
		);
	}
	for (const asset of [LOGO_ASSET, THREAD_ASSET]) {
		await handle.pool.query(
			`INSERT INTO media_assets (id, project_id, owner, content_hash, mime_type,
				extension, size_bytes, kind, gcs_object_key, original_filename, status)
			 VALUES ($1, $2, 'owner-test', $3, 'application/pdf', '.pdf', 64, 'pdf',
				$4, 'file.pdf', 'ready')`,
			[asset, PROJECT, asset.replaceAll("-", "").padEnd(64, "a"), `k/${asset}`],
		);
	}
	const messages = [
		{
			id: "m1",
			role: "user",
			parts: [{ type: "text", text: "read this" }],
			metadata: {
				attachments: [
					{
						assetId: THREAD_ASSET,
						kind: "pdf",
						filename: "file.pdf",
						mimeType: "application/pdf",
					},
				],
			},
		},
	];
	await handle.pool.query(
		`INSERT INTO threads (thread_id, app_id, created_at, updated_at, thread_type,
			summary, run_id, active_stream_id, messages)
		 VALUES ('thread-backfill', $1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z',
			'build', 'read this', 'run-b', NULL, $2)`,
		[APP, JSON.stringify(messages)],
	);
	/* The OLD app-wide projection: Blueprint + thread carriers combined. */
	for (const asset of [LOGO_ASSET, THREAD_ASSET]) {
		await handle.pool.query(
			`INSERT INTO media_asset_refs (project_id, app_id, asset_id)
			 VALUES ($1, $2, $3)`,
			[PROJECT, APP, asset],
		);
	}
}

describe("design_sessions migration backfill", () => {
	it("splits the projection: per-thread conversation refs land exactly, Blueprint edges rebuild blueprint-only, and replay converges", async () => {
		const before = await migrator(
			(name) => name < MIGRATION_NAME,
		).migrateToLatest();
		expect(before.error).toBeUndefined();
		await seedOldShape();

		const after = await migrator(() => true).migrateToLatest();
		expect(after.error).toBeUndefined();

		const threadRefs = await handle.pool.query(
			"SELECT thread_id, asset_id::text, project_id FROM thread_media_refs ORDER BY asset_id",
		);
		expect(threadRefs.rows).toEqual([
			{
				thread_id: "thread-backfill",
				asset_id: THREAD_ASSET,
				project_id: PROJECT,
			},
		]);
		const blueprintRefs = await handle.pool.query(
			"SELECT asset_id::text FROM media_asset_refs WHERE app_id = $1 ORDER BY asset_id",
			[APP],
		);
		expect(blueprintRefs.rows).toEqual([{ asset_id: LOGO_ASSET }]);

		/* Replaying THIS migration's `up` over the final shape converges: the
		 * DDL guards no-op and the backfill recomputes the same projection
		 * rather than duplicating it (the whole-chain replay contract lives in
		 * the migration adoption suite; the strict canonical-identity cutover
		 * rightly refuses a whole-chain replay over seeded data). */
		const { up } = await import("../20260809000000_design_sessions");
		const replayDb = new Kysely<unknown>({
			dialect: new PostgresDialect({
				pool: handle.pool as unknown as PostgresPool,
			}),
		});
		await up(replayDb);
		const threadRefsAfterReplay = await handle.pool.query(
			"SELECT count(*)::int AS count FROM thread_media_refs",
		);
		expect(threadRefsAfterReplay.rows[0].count).toBe(1);
		const blueprintRefsAfterReplay = await handle.pool.query(
			"SELECT count(*)::int AS count FROM media_asset_refs WHERE app_id = $1",
			[APP],
		);
		expect(blueprintRefsAfterReplay.rows[0].count).toBe(1);
	});
});
