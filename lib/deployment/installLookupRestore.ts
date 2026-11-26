import "server-only";
import { sql, type Transaction } from "kysely";
import { dataAccessLost } from "@/lib/auth/dataGrant";
import { listHqLookupTables } from "@/lib/commcare/hq/lookupTables";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { getHqCredentials } from "@/lib/db/settings";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { DestinationOwnerAccess } from "./destinationRowOwners";

export interface InstallLookupBinding {
	targetAppId: string;
	tableIds: readonly LookupTableId[];
	digest: string;
}

/** Prove the native restore source exists at this exact deployment. No
 * administrative row or worker restore enters the installable archive. */
export async function readInstallLookupBinding(
	access: DestinationOwnerAccess,
	targetAppId: string,
	tableIds: readonly LookupTableId[],
	admit: (tx: Transaction<AppDatabase>) => Promise<string>,
): Promise<InstallLookupBinding> {
	const { scope, target } = access;
	const local = () =>
		withAppTx(
			async (tx) => {
				const authority = await admit(tx);
				const held = await sql<{
					id: string;
				}>`SELECT d.id FROM app_deployments d JOIN app_deployment_resources a ON a.deployment_id=d.id
			WHERE d.app_id=${scope.appId} AND d.project_id=${scope.projectId} AND d.server=${target.server} AND d.domain=${target.domain} AND d.state<>'ended'
			AND a.kind='app' AND a.remote_id=${targetAppId} AND a.superseded_at IS NULL FOR SHARE OF d,a`.execute(
					tx,
				);
				if (held.rows.length !== 1) return dataAccessLost();
				const defs = await readLookupDefinitionsInTransaction(
					tx,
					scope.projectId,
					tableIds,
				);
				if (defs.definitions.length !== tableIds.length)
					return dataAccessLost();
				const mappings = await sql<{
					id: LookupTableId;
					remote_id: string;
					push_token: string | null;
				}>`SELECT nova_resource_id id,remote_id,push_token FROM app_deployment_resources
			WHERE deployment_id=${held.rows[0].id} AND kind='lookup-table' AND superseded_at IS NULL AND nova_resource_id=ANY(${tableIds}::text[]) FOR SHARE`.execute(
					tx,
				);
				const resources = defs.definitions.map((table) => {
					const map = mappings.rows.filter((m) => m.id === table.id);
					const own =
						table.hq?.managedBy === "commcare-hq" &&
						table.hq.server === target.server &&
						table.hq.domain === target.domain
							? table.hq.remoteId
							: null;
					if (
						map.length > 1 ||
						(map.length === 1 && own && map[0].remote_id !== own)
					)
						return dataAccessLost();
					const remoteId = map[0]?.remote_id ?? own;
					if (!remoteId) return dataAccessLost();
					const fields = table.columns.map((c) => [
						c.wireName,
						(c.properties ?? []).map((p) => p.wireName),
					]);
					return {
						id: table.id,
						tag: table.tag,
						remoteId,
						global:
							table.workerAccess !== "assigned" &&
							table.hq?.source?.distribution !== "assigned",
						fields,
						attributes: (table.attributes ?? []).map((a) => a.wireName),
						token: map[0]?.push_token ?? null,
					};
				});
				return {
					resources,
					digest: canonicalJsonDigest([
						authority,
						defs.projectRevision,
						held.rows[0].id,
						resources,
					]),
				};
			},
			{ isolationLevel: "repeatable read" },
		);
	const before = await local();
	const key = await getHqCredentials(scope.actorUserId, target.domain);
	if (!key.ok || key.creds.server !== target.server) return dataAccessLost();
	const inventory = await listHqLookupTables(key.creds, target.domain);
	if ("success" in inventory) return dataAccessLost();
	for (const resource of before.resources) {
		const matches = inventory.filter((t) => t.tag === resource.tag);
		const table = matches[0];
		if (
			matches.length !== 1 ||
			table.id !== resource.remoteId ||
			table.isGlobal !== resource.global ||
			canonicalJsonDigest(
				table.fields.map((f) => [f, table.fieldProperties[f] ?? []]),
			) !== canonicalJsonDigest(resource.fields) ||
			canonicalJsonDigest(table.itemAttributes) !==
				canonicalJsonDigest(resource.attributes)
		)
			return dataAccessLost();
	}
	if ((await local()).digest !== before.digest) return dataAccessLost();
	return { targetAppId, tableIds, digest: before.digest };
}
