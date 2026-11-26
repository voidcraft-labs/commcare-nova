import { sql, type Transaction } from "kysely";
import {
	dataAccessLost,
	lockProjectDataGrant,
	type ProjectDataGrant,
} from "@/lib/auth/dataGrant";
import { NOVA_MCP_FLOOR_SCOPES } from "@/lib/auth-public";
import type { AppDatabase } from "@/lib/db/pg";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { LookupError } from "../errors";
import type { LookupScope } from "../types";
import {
	authorizeLookupWriteInTransaction,
	lockLookupProjectState,
	lockLookupTableForUpdate,
	lookupTableRevisions,
} from "../writerTransaction";

export interface InventoryAccess {
	scope: LookupScope;
	tableId: LookupTableId;
	grant: ProjectDataGrant;
}

export async function lockInventoryScope(
	tx: Transaction<AppDatabase>,
	access: InventoryAccess,
	purpose: "read" | "transfer" = "read",
) {
	const { scope, tableId, grant } = access;
	const authority = await authorizeLookupWriteInTransaction(
		tx,
		scope,
		purpose === "transfer" ? "delete" : "edit",
	);
	const grantKey = await lockProjectDataGrant(tx, scope.actorId, grant, [
		...NOVA_MCP_FLOOR_SCOPES,
		"nova.hq.import",
		...(purpose === "transfer" ? ["nova.hq.write"] : []),
	]);
	await lockLookupProjectState(tx, authority);
	const table = await lockLookupTableForUpdate(
		tx,
		authority,
		tableId,
		null,
		"hq-refresh",
	);
	if (
		!table.hq_remote_id ||
		!table.hq_server ||
		!table.hq_domain ||
		table.hq_taken_over_at !== null
	)
		return dataAccessLost();
	const member = await sql<{
		id: string;
		version: string;
	}>`SELECT id, xmin::text AS version FROM auth_member WHERE "userId"=${scope.actorId} AND "organizationId"=${scope.projectId}`.execute(
		tx,
	);
	const settings = await tx
		.selectFrom("user_settings")
		.select([
			"commcare_username",
			"connection_epoch",
			"commcare_server",
			"approved_domains",
			sql<boolean>`commcare_api_key <> ''`.as("configured"),
		])
		.where("user_id", "=", scope.actorId)
		.forShare()
		.executeTakeFirst();
	if (
		!settings?.configured ||
		settings.commcare_server !== table.hq_server ||
		!settings.approved_domains.some((x) => x.name === table.hq_domain)
	)
		return dataAccessLost();
	// The connection's version, which a save of the key renews, never the key.
	const connectionEpoch = settings.connection_epoch;
	const scopeDigest = canonicalJsonDigest([
		scope.projectId,
		scope.actorId,
		member.rows[0].id,
		member.rows[0].version,
		grantKey,
		table.id,
		table.hq_server,
		table.hq_domain,
		table.hq_remote_id,
		settings.commcare_username,
		connectionEpoch,
	]);
	return {
		authority,
		origin: {
			server: table.hq_server,
			domain: table.hq_domain,
			remoteId: table.hq_remote_id,
		},
		table,
		scopeDigest,
		connectionEpoch,
		username: settings.commcare_username,
		revision: lookupTableRevisions(table).tableRevision,
	};
}

export function sourceChanged(): never {
	throw new LookupError(
		"conflict",
		"This table or its connection changed during the refresh. You can refresh it again.",
	);
}
