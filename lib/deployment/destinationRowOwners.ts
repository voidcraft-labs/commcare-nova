import "server-only";
import { sql, type Transaction } from "kysely";
import {
	dataAccessLost,
	lockProjectDataGrant,
	type ProjectDataGrant,
} from "@/lib/auth/dataGrant";
import { NOVA_MCP_FLOOR_SCOPES } from "@/lib/auth-public";
import { lookupWorkbookPrincipals } from "@/lib/commcare/hq/lookupOwners";
import type {
	LookupOwnerKind,
	WorkbookRowOwners,
} from "@/lib/commcare/hq/lookupWorkbook";
import { readTargetWorkerGroup } from "@/lib/commcare/hq/workerGroups";
import { resolveAppScopeInTransaction } from "@/lib/db/appAccess";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { getHqCredentials } from "@/lib/db/settings";
import type { LookupRowId, LookupTableId } from "@/lib/domain/lookupIds";
import { LookupError } from "@/lib/lookup/errors";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { groupAudienceMatches, targetGroupFacts } from "./workerGroupBinding";

export interface DestinationOwnerAccess {
	scope: { appId: string; projectId: string; actorUserId: string };
	grant: ProjectDataGrant;
	target: { server: string; domain: string };
	purpose?: "publish" | "export";
}
interface IntendedOwner {
	row_id: LookupRowId;
	kind: "worker" | "place" | "group";
	principal_id: string;
	app_id: string | null;
	remote_id: string | null;
	name: string | null;
	token: string | null;
}
function missing(): never {
	throw new LookupError(
		"managed_in_hq",
		"One or more row assignments need a confirmed worker, group or place in this project space. You can check their bindings in Project data, then prepare this table again.",
	);
}

async function readOwnerState(
	tx: Transaction<AppDatabase>,
	access: DestinationOwnerAccess,
	tableId: LookupTableId,
) {
	const { scope, target, grant } = access;
	const app = await resolveAppScopeInTransaction(
		tx,
		scope.appId,
		scope.actorUserId,
		"edit",
	);
	if (app.projectId !== scope.projectId) return dataAccessLost();
	const grantKey = await lockProjectDataGrant(tx, scope.actorUserId, grant, [
		...NOVA_MCP_FLOOR_SCOPES,
		access.purpose === "publish"
			? "nova.hq.write"
			: "nova.projects.data.export",
	]);
	const key = await tx
		.selectFrom("user_settings")
		.select([
			"commcare_server",
			"commcare_username",
			"commcare_api_key",
			"approved_domains",
		])
		.where("user_id", "=", scope.actorUserId)
		.forShare()
		.executeTakeFirst();
	if (
		!key?.commcare_api_key ||
		key.commcare_server !== target.server ||
		!key.approved_domains.some((d) => d.name === target.domain)
	)
		return dataAccessLost();
	const table = await tx
		.selectFrom("lookup_tables")
		.select([
			"definition_revision",
			"rows_revision",
			"worker_access",
			"hq_server",
			"hq_taken_over_at",
		])
		.where("project_id", "=", scope.projectId)
		.where("id", "=", tableId)
		.forShare()
		.executeTakeFirst();
	if (
		table?.worker_access !== "assigned" ||
		(table.hq_server && !table.hq_taken_over_at)
	)
		return missing();
	const state =
		await sql<IntendedOwner>`SELECT a.row_id,a.kind,a.principal_id,a.app_id,
		CASE WHEN a.kind='group' THEN g.remote_id WHEN a.kind='place' AND lp.id IS NOT NULL THEN coalesce(r.remote_id,p.hq_location_id) WHEN a.kind='worker' AND w.uuid IS NOT NULL THEN r.remote_id END remote_id,
		CASE WHEN a.kind='group' THEN g.confirmed_name WHEN a.kind='place' AND lp.id IS NOT NULL THEN coalesce(r.pushed_identity,p.site_code) WHEN a.kind='worker' AND w.uuid IS NOT NULL THEN r.pushed_identity END name,
		coalesce(r.push_token::text,g.xmin::text,p.xmin::text) token FROM lookup_row_assignments a
		LEFT JOIN apps b ON (b.project_id,b.id)=(a.project_id,a.app_id) AND b.deleted_at IS NULL
		LEFT JOIN blueprint_entities w ON a.kind='worker' AND w.kind='persona' AND (w.app_id,w.uuid)=(b.id,a.principal_id)
		LEFT JOIN app_locations lp ON a.kind='place' AND (lp.app_id,lp.id)=(b.id,a.principal_id) AND lp.archived_at IS NULL
		LEFT JOIN app_deployments d ON (d.project_id,d.app_id)=(b.project_id,b.id) AND d.server=${target.server} AND d.domain=${target.domain} AND d.state<>'ended'
		LEFT JOIN app_deployment_resources r ON r.deployment_id=d.id AND r.superseded_at IS NULL AND r.nova_resource_id=a.principal_id::text AND r.kind=(CASE a.kind WHEN 'place' THEN 'location' ELSE 'worker' END)
		LEFT JOIN worker_group_targets g ON a.kind='group' AND g.project_id=a.project_id AND g.group_id=a.principal_id AND g.server=${target.server} AND g.domain=${target.domain}
		LEFT JOIN app_organization_state org ON b.id=org.app_id AND org.hq_server=${target.server} AND org.hq_domain=${target.domain}
		LEFT JOIN app_locations p ON a.kind='place' AND p.app_id=org.app_id AND p.id=a.principal_id AND p.archived_at IS NULL
		WHERE a.project_id=${scope.projectId} AND a.table_id=${tableId}
		ORDER BY a.row_id,a.kind,a.app_id,a.principal_id`.execute(tx);
	const groupFacts = [];
	for (const groupId of new Set(
		state.rows
			.filter((row) => row.kind === "group")
			.map((row) => row.principal_id),
	)) {
		groupFacts.push([
			groupId,
			await targetGroupFacts(
				tx,
				scope.projectId,
				groupId,
				target.server,
				target.domain,
			),
		] as const);
	}
	const digest = canonicalJsonDigest([
		scope,
		target,
		grantKey,
		app.role,
		app.baseSeq,
		key.commcare_api_key,
		key.commcare_username,
		tableId,
		table,
		state.rows,
		groupFacts,
	]);
	return { owners: state.rows, groupFacts, digest };
}

/** The fixapi workbook accepts names. Verify that each exact spelling resolves
 * to the intended target ID, never to a namesake or another domain. Call again
 * immediately before a send or redemption and compare its witness. */
export async function readDestinationRowOwners(
	access: DestinationOwnerAccess,
	tableId: LookupTableId,
) {
	const start = await withAppTx((tx) => readOwnerState(tx, access, tableId), {
		isolationLevel: "repeatable read",
	});
	const byRow = new Map<
		LookupRowId,
		{ users: string[]; groups: string[]; locations: string[] }
	>();
	const wanted = new Map<string, string>();
	const { target } = access;
	for (const row of start.owners) {
		if (!row.remote_id || !row.name) return missing();
		const owners = byRow.get(row.row_id) ?? {
			users: [],
			groups: [],
			locations: [],
		};
		let kind: LookupOwnerKind;
		let name: string;
		if (row.kind === "worker") {
			const suffix = "@" + target.domain + ".commcarehq.org";
			if (!row.name.endsWith(suffix)) return missing();
			kind = "user";
			name = row.name.slice(0, -suffix.length);
			owners.users.push(name);
		} else if (row.kind === "group") {
			kind = "group";
			name = row.name;
			owners.groups.push(name);
		} else {
			kind = "location";
			name = row.name;
			owners.locations.push(name);
		}
		const key = JSON.stringify([kind, name]);
		const existing = wanted.get(key);
		if (existing && existing !== row.remote_id) return missing();
		wanted.set(key, row.remote_id);
		byRow.set(row.row_id, owners);
	}
	const creds = await getHqCredentials(access.scope.actorUserId, target.domain);
	if (!creds.ok || creds.creds.server !== target.server)
		return dataAccessLost();
	const remoteGroups = [];
	for (const [groupId, local] of start.groupFacts) {
		const binding = start.owners.find(
			(row) => row.kind === "group" && row.principal_id === groupId,
		);
		if (!binding?.remote_id) return missing();
		const actual = await readTargetWorkerGroup(
			creds.creds,
			target.domain,
			binding.remote_id,
		);
		if (
			!actual ||
			actual.name !== binding.name ||
			!groupAudienceMatches(local, actual)
		)
			return missing();
		remoteGroups.push(actual);
	}
	const workbook: WorkbookRowOwners[] = Array.from(
		byRow,
		([rowId, owners]) => ({
			rowId,
			owners: {
				user: owners.users,
				group: owners.groups,
				location: owners.locations,
			},
		}),
	);
	const found = await lookupWorkbookPrincipals(
		creds.creds,
		target.domain,
		workbook,
	);
	const current = new Map<string, Set<string>>();
	for (const principal of found) {
		const key = JSON.stringify([principal.kind, principal.name]);
		const values = current.get(key) ?? new Set();
		values.add(principal.id);
		current.set(key, values);
	}
	for (const [key, id] of wanted) {
		const ids = current.get(key);
		if (ids?.size !== 1 || !ids.has(id)) return missing();
	}
	const end = await withAppTx((tx) => readOwnerState(tx, access, tableId), {
		isolationLevel: "repeatable read",
	});
	if (end.digest !== start.digest) return missing();
	return { byRow, digest: canonicalJsonDigest([start.digest, remoteGroups]) };
}
