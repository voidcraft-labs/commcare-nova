import { sql, type Transaction } from "kysely";
import { openRemoteWrite } from "@/lib/db/openRemoteWrite";
import type { AppDatabase } from "@/lib/db/pg";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { LookupError } from "./errors";

/**
 * The project space an open workbook carrying `tableId` goes to, or null
 * where none is open (`hq_remote_writes`, which `lib/deployment/store.ts`
 * writes under the same table's lock), by the one rule of an open write
 * (`openRemoteWrite`).
 */
export async function openWorkbookDomain(
	tx: Transaction<AppDatabase>,
	tableId: LookupTableId,
): Promise<string | null> {
	const row = await tx
		.selectFrom("hq_remote_writes")
		.select("domain")
		.where("resource_kind", "=", "lookup-table")
		.where("resource_id", "=", tableId)
		.where(openRemoteWrite)
		.orderBy("held_until", "desc")
		.limit(1)
		.executeTakeFirst();
	return row?.domain ?? null;
}

export async function assertWorkbookEditAvailable(
	tx: Transaction<AppDatabase>,
	tableId: LookupTableId,
) {
	const domain = await openWorkbookDomain(tx, tableId);
	if (domain) throw workbookConflict(domain);
}

/** Group membership and binding writers hold the same lookup Project state
 * as workbook admission. Only a group actually carried by an open write waits. */
export async function assertWorkbookGroupAvailable(
	tx: Transaction<AppDatabase>,
	projectId: string,
	groupId: string,
) {
	const write = await tx
		.selectFrom("hq_remote_writes")
		.select("domain")
		.where("project_id", "=", projectId)
		.where("resource_kind", "=", "lookup-table")
		.where(
			"resource_id",
			"in",
			sql<string>`(SELECT table_id::text FROM lookup_row_assignments WHERE project_id=${projectId} AND kind='group' AND principal_id=${groupId})`,
		)
		.where(openRemoteWrite)
		.limit(1)
		.executeTakeFirst();
	if (write) throw workbookConflict(write.domain);
}

function workbookConflict(domain: string) {
	return new LookupError(
		"conflict",
		`Nova is publishing this table to “${domain}”. You can try your change again when that upload finishes.`,
	);
}
