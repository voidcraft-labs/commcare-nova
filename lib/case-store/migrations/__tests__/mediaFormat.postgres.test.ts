/**
 * The media-format migration over real Postgres. A ready media row without a
 * format can exist only if it is written before the migration, so each case
 * migrates to the migration before it, writes its rows there, then applies
 * it: the existing rows must stay, and from then on the presence check and
 * the value domain hold every write.
 */

import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";

const MEDIA_FORMAT = "20261101020000_hq_round_trip_platforms_media_format";

const database = setupPerTestDatabase({
	databaseNamePrefix: "media_format_migration_",
	prepareTemplate: async (db) => {
		const result = await new Migrator({
			db,
			provider: {
				getMigrations: async () =>
					Object.fromEntries(
						Object.entries(caseStoreMigrations).filter(
							([name]) => name < MEDIA_FORMAT,
						),
					),
			},
		}).migrateToLatest();
		if (result.error !== undefined) throw result.error;
	},
});

/** Apply the stack's migrations through the media-format migration. */
async function migrateThroughMediaFormat(): Promise<void> {
	const result = await new Migrator({
		db: database.db,
		provider: { getMigrations: async () => caseStoreMigrations },
	}).migrateTo(MEDIA_FORMAT);
	if (result.error !== undefined) throw result.error;
}

let counter = 0;

/** Insert one asset row; `format` undefined writes no `media_format` column. */
async function insertAsset(args: {
	kind: string;
	mime: string;
	status: "pending" | "ready";
	format?: string;
}): Promise<string> {
	counter += 1;
	const id = `20000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
	const hash = String(counter).padStart(64, "0");
	if (args.format === undefined) {
		await sql`INSERT INTO media_assets (id, project_id, owner, content_hash, mime_type,
			extension, size_bytes, kind, gcs_object_key, original_filename, status)
			VALUES (${id}, 'project', 'owner', ${hash}, ${args.mime}, '.bin', 10, ${args.kind},
			${`projects/project/${hash}`}, 'file', ${args.status})`.execute(
			database.db,
		);
	} else {
		await sql`INSERT INTO media_assets (id, project_id, owner, content_hash, mime_type,
			extension, size_bytes, kind, gcs_object_key, original_filename, status, media_format)
			VALUES (${id}, 'project', 'owner', ${hash}, ${args.mime}, '.bin', 10, ${args.kind},
			${`projects/project/${hash}`}, 'file', ${args.status}, ${args.format})`.execute(
			database.db,
		);
	}
	return id;
}

describe(MEDIA_FORMAT, () => {
	it("keeps the ready media rows written before it, each without a format", async () => {
		const image = await insertAsset({
			kind: "image",
			mime: "image/png",
			status: "ready",
		});
		const video = await insertAsset({
			kind: "video",
			mime: "video/mp4",
			status: "ready",
		});
		await migrateThroughMediaFormat();
		const rows = await sql<{ id: string; media_format: string | null }>`
			SELECT id, media_format FROM media_assets WHERE id IN (${image}, ${video})
		`.execute(database.db);
		expect(rows.rows.map((row) => row.media_format)).toEqual([null, null]);
	});

	it("refuses a ready media row written without a format, by insert or by the confirm's update", async () => {
		const pending = await insertAsset({
			kind: "audio",
			mime: "audio/wav",
			status: "pending",
		});
		await migrateThroughMediaFormat();
		for (const kind of [
			["image", "image/png"],
			["audio", "audio/wav"],
			["video", "video/mp4"],
		] as const) {
			await expect(
				insertAsset({ kind: kind[0], mime: kind[1], status: "ready" }),
			).rejects.toThrow(/media_assets_ready_media_format/);
		}
		await expect(
			sql`UPDATE media_assets SET status = 'ready' WHERE id = ${pending}`.execute(
				database.db,
			),
		).rejects.toThrow(/media_assets_ready_media_format/);
		await sql`UPDATE media_assets SET status = 'ready', media_format = 'wav-pcm'
			WHERE id = ${pending}`.execute(database.db);
	});

	it("admits a document and a pending row without a format, and each kind's own variants", async () => {
		await migrateThroughMediaFormat();
		await insertAsset({
			kind: "pdf",
			mime: "application/pdf",
			status: "ready",
		});
		await insertAsset({ kind: "image", mime: "image/png", status: "pending" });
		await insertAsset({
			kind: "image",
			mime: "image/vnd.microsoft.icon",
			status: "ready",
			format: "ico",
		});
		await insertAsset({
			kind: "audio",
			mime: "audio/wav",
			status: "ready",
			format: "unplayable",
		});
		await insertAsset({
			kind: "video",
			mime: "video/mp4",
			status: "ready",
			format: "mp4-hevc",
		});
	});

	it("refuses a variant of another kind, and an unknown key", async () => {
		await migrateThroughMediaFormat();
		await expect(
			insertAsset({
				kind: "image",
				mime: "image/png",
				status: "ready",
				format: "mp3",
			}),
		).rejects.toThrow(/media_assets_media_format_known/);
		await expect(
			insertAsset({
				kind: "video",
				mime: "video/mp4",
				status: "ready",
				format: "mp4-av1",
			}),
		).rejects.toThrow(/media_assets_media_format_known/);
	});
});
