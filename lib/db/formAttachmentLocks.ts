import { sql, type Transaction } from "kysely";
import type { Database as CaseDatabase } from "@/lib/case-store/sql/database";
import type { AppDatabase } from "./pg";

type SharedDatabase = AppDatabase & CaseDatabase;

/** Serialize every terminal operation for one concrete form entry. */
export async function lockFormAttachmentEntry(
	tx: Transaction<AppDatabase> | Transaction<CaseDatabase>,
	args: { appId: string; actorUserId: string; entryKey: string },
): Promise<void> {
	const scope = `nova-form-attachment-entry:${args.appId}:${args.actorUserId}:${args.entryKey}`;
	await sql`select pg_advisory_xact_lock(hashtextextended(${scope}, 0::bigint))`.execute(
		tx as unknown as Transaction<SharedDatabase>,
	);
}

/** Serialize Project-wide byte-quota decisions across different apps. */
export async function lockFormAttachmentProjectQuota(
	tx: Transaction<AppDatabase>,
	projectId: string,
): Promise<void> {
	const scope = `nova-form-attachment-project-quota:${projectId}`;
	await sql`select pg_advisory_xact_lock(hashtextextended(${scope}, 0::bigint))`.execute(
		tx,
	);
}
