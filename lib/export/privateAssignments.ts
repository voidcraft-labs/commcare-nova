import "server-only";
import type { Transaction } from "kysely";
import {
	dataAccessLost,
	lockProjectDataGrant,
	type ProjectDataGrant,
} from "@/lib/auth/dataGrant";
import { NOVA_MCP_FLOOR_SCOPES } from "@/lib/auth-public";
import { resolveAppScopeInTransaction } from "@/lib/db/appAccess";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import {
	type DestinationOwnerAccess,
	readDestinationRowOwners,
} from "@/lib/deployment/destinationRowOwners";
import type { LookupRowId, LookupTableId } from "@/lib/domain/lookupIds";
import { readLookupFixtureDataInTransaction } from "@/lib/lookup/fixtureSnapshot";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

import {
	readInstallLookupBinding,
	type InstallLookupBinding,
} from "@/lib/deployment/installLookupRestore";

export interface AssignmentWitness {
	restore?: InstallLookupBinding;
	target: { server: string; domain: string };
	tables: readonly { tableId: LookupTableId; digest: string }[];
}
export async function authorizeAssignmentExport(
	tx: Transaction<AppDatabase>,
	scope: { appId: string; projectId: string; actorUserId: string },
	grant: ProjectDataGrant,
	target: { server: string; domain: string },
	purpose: "export" | "publish" = "export",
) {
	const app = await resolveAppScopeInTransaction(
		tx,
		scope.appId,
		scope.actorUserId,
		"edit",
	);
	if (app.projectId !== scope.projectId) return dataAccessLost();
	const key = await lockProjectDataGrant(tx, scope.actorUserId, grant, [
		...NOVA_MCP_FLOOR_SCOPES,
		purpose === "publish" ? "nova.hq.write" : "nova.projects.data.export",
	]);
	const settings = await tx
		.selectFrom("user_settings")
		.select([
			"commcare_username",
			"commcare_api_key",
			"commcare_server",
			"approved_domains",
		])
		.where("user_id", "=", scope.actorUserId)
		.forShare()
		.executeTakeFirst();
	if (
		!settings?.commcare_api_key ||
		settings.commcare_server !== target.server ||
		!settings.approved_domains.some((d) => d.name === target.domain)
	)
		return dataAccessLost();
	return canonicalJsonDigest([
		key,
		settings.commcare_username,
		settings.commcare_api_key,
		target,
	]);
}
export async function readAssignmentCarriers(
	access: DestinationOwnerAccess,
	snapshot: LookupFixtureDataSnapshot,
) {
	const tables = snapshot.definitions.filter(
		(t) => t.workerAccess === "assigned" && t.hq?.managedBy !== "commcare-hq",
	);
	const witnesses: { tableId: LookupTableId; digest: string }[] = [];
	const owners = new Map<
		LookupTableId,
		Map<LookupRowId, { users: string[]; groups: string[]; locations: string[] }>
	>();
	for (const table of tables) {
		const read = await readDestinationRowOwners(access, table.id);
		witnesses.push({ tableId: table.id, digest: read.digest });
		owners.set(table.id, read.byRow);
	}
	const privateSnapshot = await withAppTx(
		async (tx) => {
			await authorizeAssignmentExport(
				tx,
				access.scope,
				access.grant,
				access.target,
				access.purpose,
			);
			const data = await readLookupFixtureDataInTransaction(
				tx,
				access.scope.projectId,
				tables.map((t) => t.id),
				"project-editor",
			);
			if (
				data.projectRevision !== snapshot.projectRevision ||
				data.definitions.some(
					(t) =>
						t.workerAccess !== "assigned" || t.hq?.managedBy === "commcare-hq",
				)
			)
				return dataAccessLost();
			return data;
		},
		{ isolationLevel: "repeatable read" },
	);
	const rowsByTable = new Map(snapshot.rowsByTable);
	for (const [id, rows] of privateSnapshot.rowsByTable) {
		const assignments = owners.get(id);
		if (!assignments) return dataAccessLost();
		for (const row of rows)
			if (!assignments.has(row.id))
				assignments.set(row.id, { users: [], groups: [], locations: [] });
		rowsByTable.set(id, rows);
	}
	return {
		snapshot: { ...snapshot, rowsByTable },
		owners,
		witness: { target: access.target, tables: witnesses },
	};
}

export function installLookupWitness(
	access: DestinationOwnerAccess,
	targetAppId: string,
	tableIds: readonly LookupTableId[],
) {
	return readInstallLookupBinding(access, targetAppId, tableIds, (tx) =>
		authorizeAssignmentExport(tx, access.scope, access.grant, access.target),
	);
}

/** The bearer carries no retained authority. HQ and Nova can both change an
 * assignment after a file was prepared. Check both on every redemption. */
export async function verifyAssignmentWitness(
	access: DestinationOwnerAccess,
	witness: AssignmentWitness,
) {
	if (witness.restore) {
		const current = await installLookupWitness(
			access,
			witness.restore.targetAppId,
			witness.restore.tableIds,
		);
		if (current.digest !== witness.restore.digest) return dataAccessLost();
	}
	for (const item of witness.tables) {
		const current = await readDestinationRowOwners(access, item.tableId);
		if (current.digest !== item.digest) return dataAccessLost();
	}
}
