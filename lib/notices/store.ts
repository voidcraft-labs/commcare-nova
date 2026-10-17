/**
 * The migration notices' persistence boundary.
 *
 * Only a cutover's migrate script writes a notice or a key-readers row, as
 * the migration role; the runtime role reads both and appends dismissals
 * (`lib/db/privilegeConvergence.ts`). Nothing here takes a row lock.
 *
 * The app-scoped reads take the caller's transaction, and the caller has
 * already resolved `view` on the app in it
 * (`lib/db/appAccess.ts::resolveAppScopeInTransaction`): the store does no
 * authorization of its own, as `lib/deployment/store.ts` does not. Any
 * current member of the app's Project, at any role, reads its notices and
 * dismisses them for themselves alone.
 */

import "server-only";

import { sql, type Transaction } from "kysely";
import { type AppDatabase, getAppDb } from "@/lib/db/pg";
import { deploymentServerSchema } from "@/lib/deployment/types";
import { CANONICAL_UUID_PATTERN } from "@/lib/domain/uuid";
import { log } from "@/lib/logger";
import {
	type AppDeploymentNoticeEntry,
	type AppMigrationNotice,
	type KeyReaderNotice,
	type MigrationNoticeEntry,
	migrationNoticeCutoverSchema,
	migrationNoticeEntrySchema,
} from "./migrationNotice";

function iso(value: Date | string): string {
	return new Date(value).toISOString();
}

/**
 * The entries of one notice this build can read. A cutover's rows may hold a
 * reason a later build added, so an entry that does not parse is left out
 * with a warning and the rest of the notice, and every other notice, still
 * reaches the reader. The warning names the notice and the entry's place
 * only, because entries hold authored names.
 */
function readableEntries(
	noticeId: string,
	raw: unknown,
): readonly MigrationNoticeEntry[] {
	if (!Array.isArray(raw)) {
		log.warn("[notices] a migration notice's entries are not a list", {
			noticeId,
		});
		return [];
	}
	const entries: MigrationNoticeEntry[] = [];
	raw.forEach((candidate: unknown, index) => {
		const parsed = migrationNoticeEntrySchema.safeParse(candidate);
		if (parsed.success) entries.push(parsed.data);
		else
			log.warn(
				"[notices] skipped a migration notice entry this build can't read",
				{
					noticeId,
					index,
				},
			);
	});
	return entries;
}

/**
 * The app's notices that `userId` has not dismissed, newest first.
 */
export async function readAppNoticesInTransaction(
	tx: Transaction<AppDatabase>,
	args: { readonly appId: string; readonly userId: string },
): Promise<readonly AppMigrationNotice[]> {
	const rows = await tx
		.selectFrom("app_migration_notices as notice")
		.select([
			"notice.id",
			"notice.cutover",
			"notice.entries",
			"notice.created_at",
		])
		.where("notice.app_id", "=", args.appId)
		.where(({ not, exists, selectFrom }) =>
			not(
				exists(
					selectFrom("app_migration_notice_dismissals as dismissal")
						.select(sql.lit(1).as("dismissed"))
						.where("dismissal.surface", "=", "app")
						.whereRef("dismissal.notice_id", "=", "notice.id")
						.where("dismissal.user_id", "=", args.userId),
				),
			),
		)
		.orderBy("notice.created_at", "desc")
		.orderBy("notice.id", "desc")
		.execute();
	const notices: AppMigrationNotice[] = [];
	for (const row of rows) {
		const cutover = migrationNoticeCutoverSchema.safeParse(row.cutover);
		if (!cutover.success) {
			log.warn("[notices] skipped a migration notice of an unknown cutover", {
				noticeId: row.id,
			});
			continue;
		}
		const entries = readableEntries(row.id, row.entries);
		if (entries.length === 0) continue;
		notices.push({
			id: row.id,
			cutover: cutover.data,
			createdAt: iso(row.created_at),
			entries,
		});
	}
	return notices;
}

/**
 * The deployment entries of every notice of the app, dismissed or not, each
 * with its notice's `created_at`. The Publishing card reads these, because
 * the card outlives the dialog's dismissal.
 */
export async function readAppDeploymentNoticeEntriesInTransaction(
	tx: Transaction<AppDatabase>,
	args: { readonly appId: string },
): Promise<readonly AppDeploymentNoticeEntry[]> {
	const rows = await tx
		.selectFrom("app_migration_notices")
		.select(["id", "entries", "created_at"])
		.where("app_id", "=", args.appId)
		.orderBy("created_at", "asc")
		.orderBy("id", "asc")
		.execute();
	const entries: AppDeploymentNoticeEntry[] = [];
	for (const row of rows) {
		for (const entry of readableEntries(row.id, row.entries)) {
			if (entry.kind !== "deployment") continue;
			entries.push({ noticeId: row.id, createdAt: iso(row.created_at), entry });
		}
	}
	return entries;
}

/**
 * The project spaces a cutover sent `userId`'s own saved CommCare HQ key to,
 * for each cutover whose home line they have not dismissed. Reads no app
 * and no notice: it is the person's own key and their own project space, so
 * it needs no Project check and names no app they may no longer reach.
 */
export async function readKeyReaderNotices(
	userId: string,
): Promise<readonly KeyReaderNotice[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("app_migration_notice_key_readers as reader")
		.select([
			"reader.cutover",
			"reader.server",
			"reader.domain",
			"reader.first_used_at",
			"reader.last_used_at",
		])
		.where("reader.user_id", "=", userId)
		.where(({ not, exists, selectFrom }) =>
			not(
				exists(
					selectFrom("app_migration_notice_dismissals as dismissal")
						.select(sql.lit(1).as("dismissed"))
						.where("dismissal.surface", "=", "key-reader")
						.whereRef("dismissal.cutover", "=", "reader.cutover")
						.where("dismissal.user_id", "=", userId),
				),
			),
		)
		.orderBy("reader.first_used_at", "asc")
		.orderBy("reader.server", "asc")
		.orderBy("reader.domain", "asc")
		.execute();
	return rows.map((row) => ({
		cutover: row.cutover,
		server: deploymentServerSchema.parse(row.server),
		domain: row.domain,
		firstUsedAt: iso(row.first_used_at),
		lastUsedAt: iso(row.last_used_at),
	}));
}

/**
 * Dismiss one notice for `userId` alone. Inserts only where a notice with
 * that id belongs to `appId`, the app whose `view` the caller resolved, so
 * a notice id of another app dismisses nothing. Answers whether the notice
 * exists, which is also `true` when this member had already dismissed it.
 * A notice is removed only with its app, so `false` means the id names no
 * notice of this app.
 */
export async function dismissAppNotice(args: {
	readonly appId: string;
	readonly noticeId: string;
	readonly userId: string;
}): Promise<boolean> {
	/* The column is a uuid: an id of any other shape names no notice, and
	 * would otherwise fail the cast instead of answering so. */
	if (!CANONICAL_UUID_PATTERN.test(args.noticeId)) return false;
	const db = await getAppDb();
	const result = await sql<{ found: boolean }>`
		WITH notice AS (
			SELECT id FROM app_migration_notices
			WHERE id = ${args.noticeId}::uuid AND app_id = ${args.appId}
		), dismissed AS (
			INSERT INTO app_migration_notice_dismissals (user_id, surface, notice_id)
			SELECT ${args.userId}, 'app', id FROM notice
			ON CONFLICT (notice_id, user_id) WHERE surface = 'app' DO NOTHING
		)
		SELECT EXISTS (SELECT 1 FROM notice) AS found
	`.execute(db);
	return result.rows[0]?.found === true;
}

/**
 * Dismiss the home line for `userId`: one `key-reader` dismissal for each
 * distinct cutover `readKeyReaderNotices` returns.
 */
export async function dismissKeyReaderNotices(args: {
	readonly userId: string;
}): Promise<void> {
	const db = await getAppDb();
	await db
		.insertInto("app_migration_notice_dismissals")
		.columns(["user_id", "surface", "cutover"])
		.expression((eb) =>
			eb
				.selectFrom("app_migration_notice_key_readers")
				.select([
					sql<string>`${args.userId}::text`.as("user_id"),
					sql<string>`'key-reader'::text`.as("surface"),
					"cutover",
				])
				.distinct()
				.where("user_id", "=", args.userId),
		)
		.onConflict((oc) =>
			oc
				.columns(["cutover", "user_id"])
				.where("surface", "=", "key-reader")
				.doNothing(),
		)
		.execute();
}
