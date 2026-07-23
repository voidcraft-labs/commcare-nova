// Live-Postgres contract for the durable browser-confirm replay migration.
// The shared harness applies the exact production chain before each test.

import type { PoolClient } from "pg";
import { describe } from "vitest";
import { expect, test } from "../../sql/__tests__/setup";

async function expectSqlState(
	client: PoolClient,
	expectedCode: string,
	statement: string,
	parameters: unknown[] = [],
): Promise<void> {
	await client.query("SAVEPOINT media_alias_expected_error");
	let error: unknown;
	try {
		await client.query(statement, parameters);
	} catch (caught) {
		error = caught;
	}
	await client.query("ROLLBACK TO SAVEPOINT media_alias_expected_error");
	await client.query("RELEASE SAVEPOINT media_alias_expected_error");
	expect((error as { code?: string } | undefined)?.code).toBe(expectedCode);
}

describe("media upload alias migration", () => {
	test("creates bounded replay rows, supporting indexes, checks, and canonical cascade cleanup", async ({
		pgClient,
	}) => {
		await pgClient.query(
			`INSERT INTO media_assets (
				id, project_id, owner, content_hash, mime_type, extension,
				size_bytes, kind, gcs_object_key, original_filename, status
			) VALUES (
				'canonical-asset', 'project-a', 'owner-a', $1, 'image/png',
				'.png', 10, 'image', 'projects/project-a/hash.png',
				'logo.png', 'ready'
			)`,
			["a".repeat(64)],
		);
		const inserted = await pgClient.query<{
			retention_seconds: string;
		}>(
			`INSERT INTO media_upload_aliases (
				attempt_asset_id, project_id, content_hash, canonical_asset_id
			) VALUES ('attempt-asset', 'project-a', $1, 'canonical-asset')
			RETURNING extract(epoch FROM (expires_at - created_at))::text
				AS retention_seconds`,
			["a".repeat(64)],
		);
		expect(inserted.rows[0]?.retention_seconds).toBe("86400.000000");

		const indexes = await pgClient.query<{ indexname: string }>(
			`SELECT indexname
			 FROM pg_indexes
			 WHERE schemaname = 'public'
			   AND tablename = 'media_upload_aliases'
			 ORDER BY indexname`,
		);
		expect(indexes.rows.map((row) => row.indexname)).toEqual([
			"media_upload_aliases_canonical",
			"media_upload_aliases_expiry",
			"media_upload_aliases_pkey",
		]);

		await expectSqlState(
			pgClient,
			"23514",
			`INSERT INTO media_upload_aliases (
				attempt_asset_id, project_id, content_hash, canonical_asset_id
			) VALUES ('canonical-asset', 'project-a', $1, 'canonical-asset')`,
			["a".repeat(64)],
		);
		await expectSqlState(
			pgClient,
			"23503",
			`INSERT INTO media_upload_aliases (
				attempt_asset_id, project_id, content_hash, canonical_asset_id
			) VALUES ('missing-target', 'project-a', $1, 'missing-asset')`,
			["a".repeat(64)],
		);

		await pgClient.query(
			"DELETE FROM media_assets WHERE id = 'canonical-asset'",
		);
		const remaining = await pgClient.query<{ count: string }>(
			"SELECT count(*)::text AS count FROM media_upload_aliases",
		);
		expect(remaining.rows[0]?.count).toBe("0");
	});
});
