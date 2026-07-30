import "server-only";

import { type Kysely, sql } from "kysely";
import { type AppDatabase, getAppDb } from "./pg";

export interface CaptureCleanupColumnFact {
	readonly name: string;
	readonly type: string;
	readonly notNull: boolean;
}

export const CAPTURE_CLEANUP_EXPECTED_COLUMNS = [
	{ name: "attachment_id", type: "text", notNull: true },
	{ name: "attachment_name", type: "text", notNull: true },
	{ name: "app_id", type: "text", notNull: true },
	{ name: "project_id", type: "text", notNull: true },
	{ name: "created_by", type: "text", notNull: true },
	{ name: "entry_key", type: "text", notNull: true },
	{ name: "field_uuid", type: "uuid", notNull: true },
	{ name: "instance_path", type: "text", notNull: true },
	{ name: "original_filename", type: "text", notNull: true },
	{ name: "extension", type: "text", notNull: true },
	{ name: "content_type", type: "text", notNull: true },
	{ name: "size_bytes", type: "bigint", notNull: true },
	{ name: "gcs_object_key", type: "text", notNull: true },
	{ name: "object_generation", type: "text", notNull: false },
	{ name: "object_checksum", type: "text", notNull: false },
	{ name: "prepared_generation", type: "text", notNull: false },
	{ name: "status", type: "text", notNull: true },
	{ name: "preparation_attempts", type: "integer", notNull: true },
	{ name: "last_preparation_error", type: "text", notNull: false },
	{
		name: "next_preparation_at",
		type: "timestamp(3) with time zone",
		notNull: false,
	},
	{
		name: "created_at",
		type: "timestamp(3) with time zone",
		notNull: true,
	},
	{
		name: "expires_at",
		type: "timestamp(3) with time zone",
		notNull: true,
	},
	{
		name: "submitted_at",
		type: "timestamp(3) with time zone",
		notNull: false,
	},
] as const satisfies readonly CaptureCleanupColumnFact[];

export function assertCaptureCleanupSchema(
	actual: readonly CaptureCleanupColumnFact[],
): void {
	if (
		actual.length !== CAPTURE_CLEANUP_EXPECTED_COLUMNS.length ||
		actual.some((column, index) => {
			const expected = CAPTURE_CLEANUP_EXPECTED_COLUMNS[index];
			return (
				expected === undefined ||
				column.name !== expected.name ||
				column.type !== expected.type ||
				column.notNull !== expected.notNull
			);
		})
	) {
		throw new Error(
			`Capture-cleanup schema drifted from the exact form_attachments contract: ${JSON.stringify(actual)}.`,
		);
	}
}

class IntentionalCaptureCleanupProbeRollback extends Error {}

/**
 * Strict cleanup-identity schema and authority proof. Every statement runs
 * through the same database login as the scheduled worker. SELECT all columns,
 * a no-match UPDATE, and a no-match DELETE prove its complete least-privilege
 * surface; the surrounding transaction is intentionally rolled back.
 */
export async function runCaptureCleanupSchemaProbe(
	database?: Kysely<AppDatabase>,
): Promise<{
	readonly columnCount: number;
	readonly rollbackVerified: true;
}> {
	const db = database ?? (await getAppDb());
	const rollback = new IntentionalCaptureCleanupProbeRollback(
		"intentional capture-cleanup schema probe rollback",
	);
	let columnCount: number | undefined;

	try {
		await db.transaction().execute(async (tx) => {
			const columns = await sql<{
				name: string;
				type: string;
				not_null: boolean;
			}>`
				SELECT
					attribute.attname AS name,
					pg_catalog.format_type(
						attribute.atttypid,
						attribute.atttypmod
					) AS type,
					attribute.attnotnull AS not_null
				FROM pg_catalog.pg_attribute AS attribute
				WHERE attribute.attrelid = 'public.form_attachments'::regclass
					AND attribute.attnum > 0
					AND NOT attribute.attisdropped
				ORDER BY attribute.attnum
			`.execute(tx);
			const facts = columns.rows.map((column) => ({
				name: column.name,
				type: column.type,
				notNull: column.not_null,
			}));
			assertCaptureCleanupSchema(facts);

			await tx.selectFrom("form_attachments").selectAll().limit(0).execute();
			await tx
				.updateTable("form_attachments")
				.set({ status: (eb) => eb.ref("status") })
				.where(sql<boolean>`false`)
				.execute();
			await tx
				.deleteFrom("form_attachments")
				.where(sql<boolean>`false`)
				.execute();

			columnCount = facts.length;
			throw rollback;
		});
	} catch (error) {
		if (error !== rollback) throw error;
	}

	if (columnCount === undefined) {
		throw new Error(
			"The capture-cleanup schema probe did not reach its rollback.",
		);
	}
	return { columnCount, rollbackVerified: true };
}
