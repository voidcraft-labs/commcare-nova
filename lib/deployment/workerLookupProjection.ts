import "server-only";
import { sql, type Transaction } from "kysely";
import {
	dataAccessLost,
	lockProjectDataGrant,
	type ProjectDataGrant,
} from "@/lib/auth/dataGrant";
import { NOVA_MCP_FLOOR_SCOPES } from "@/lib/auth-public";
import { readLookupWorkerRestore,readWorkerGroupsRestore } from "@/lib/commcare/hq/lookupRestore";
import { verifyHqLookupDefinition } from "@/lib/commcare/hq/lookupSource";
import { listHqLookupTables } from "@/lib/commcare/hq/lookupTables";
import { findHqMobileWorkers } from "@/lib/commcare/hq/workers";
import { resolveAppScopeInTransaction } from "@/lib/db/appAccess";
import { loadAppInTransaction } from "@/lib/db/canonicalCommitKernel";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { getHqCredentials } from "@/lib/db/settings";
import { personaSchema, uuidSchema } from "@/lib/domain";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { authorizeAgentScopeInTransaction } from "@/lib/lookup/agentService";
import { LookupError } from "@/lib/lookup/errors";
import { readLookupFixtureDataInTransaction } from "@/lib/lookup/fixtureSnapshot";
import {
	chargeDeviceFixture,
	DEVICE_FIXTURE_BYTES,
} from "@/lib/lookup/fixtureValues";
import {
	requiresLookupProjection,
	workerLookupUnavailable,
} from "@/lib/lookup/source";
import type {
	LookupAgentWriteScope,
	LookupFixtureDataSnapshot,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import {
	type WorkerRestoreScope,
	workerRestoreScope,
} from "@/lib/preview/engine/restoreScope";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { bindWorkerFixtureRows } from "./workerLookupRows";

export interface WorkerProjectionAccess {
	scope: { appId: string; projectId: string; actorUserId: string };
	grant:
		| ProjectDataGrant
		| { kind: "architect"; authority: LookupAgentWriteScope };
	personaUuid?: string;
	target?: { server: string; domain: string; workerId?: string };
	purpose?: "preview" | "export";
}
function unavailable(name: string): never {
	throw new LookupError("managed_in_hq", workerLookupUnavailable(name));
}

async function lockWorkerAccess(
	tx: Transaction<AppDatabase>,
	access: WorkerProjectionAccess,
) {
	const { grant } = access;
	const { appId, projectId, actorUserId } = access.scope;
	const scope = { appId, projectId, actorUserId };
	const selected = uuidSchema.optional().safeParse(access.personaUuid);
	if (!selected.success) return dataAccessLost();
	const personaUuid = selected.data;
	const result = await resolveAppScopeInTransaction(
		tx,
		scope.appId,
		scope.actorUserId,
		access.purpose === "export" ? "edit" : "view",
	);
	if (result.projectId !== scope.projectId) return dataAccessLost();
	let grantKey: readonly string[];
	if (grant.kind === "architect") {
		const a = grant.authority;
		if (
			access.purpose === "export" ||
			!a.chatRunHolder ||
			a.projectId !== scope.projectId ||
			a.actorId !== scope.actorUserId
		)
			return dataAccessLost();
		await authorizeAgentScopeInTransaction(tx, a, "edit");
		const bound = a.ordinaryAuthoring
			? await tx
					.selectFrom("authoring_sessions")
					.select("app_id")
					.where("id", "=", a.ordinaryAuthoring.sessionId)
					.executeTakeFirst()
			: a.designSessionId
				? await tx
						.selectFrom("design_sessions")
						.select("app_id")
						.where("id", "=", a.designSessionId)
						.executeTakeFirst()
				: { app_id: a.appId };
		if (bound?.app_id !== scope.appId) return dataAccessLost();
		grantKey = ["architect", a.chatRunHolder.runId, a.chatRunHolder.nonce];
	} else
		grantKey = await lockProjectDataGrant(
			tx,
			scope.actorUserId,
			grant,
			access.purpose === "export"
				? [...NOVA_MCP_FLOOR_SCOPES, "nova.projects.data.export"]
				: NOVA_MCP_FLOOR_SCOPES,
		);
	const row =
		personaUuid === undefined
			? undefined
			: await tx
					.selectFrom("blueprint_entities")
					.select("data")
					.where("app_id", "=", scope.appId)
					.where("uuid", "=", personaUuid)
					.where("kind", "=", "persona")
					.executeTakeFirst();
	if (personaUuid !== undefined && !row) return dataAccessLost();
	const persona = row && personaSchema.parse(row.data);
	const revisions = await sql<{
		places: string;
		project: string;
		membership: string;
	}>`SELECT
		(SELECT revision::text FROM app_organization_state WHERE app_id=${scope.appId} FOR SHARE) AS places,
		(SELECT revision::text FROM lookup_project_state WHERE project_id=${scope.projectId} FOR SHARE) AS project,
		(SELECT id || '/' || xmin::text FROM auth_member WHERE "userId"=${scope.actorUserId} AND "organizationId"=${scope.projectId}) AS membership`.execute(
		tx,
	);
	return {
		worker: {
			appId: scope.appId,
			personaUuid,
			primaryPlace: persona?.locations?.primaryUuid,
		},
		principal: canonicalJsonDigest([
			scope,
			personaUuid ?? null,
			persona?.locations ?? null,
			result.baseSeq,
			revisions.rows[0],
		]),
		digest: canonicalJsonDigest([
			scope,
			personaUuid ?? null,
			grantKey,
			result.baseSeq,
			result.role,
			revisions.rows[0],
		]),
	};
}

/** A live deployment's exact worker mapping is the only bridge from a local
 * persona to a handset identity. Equal usernames on other spaces grant nothing. */
export async function assertWorkerTargetBinding(
	tx: Transaction<AppDatabase>,
	access: WorkerProjectionAccess,
) {
	const locked = await lockWorkerAccess(tx, access);
	const { scope, target, personaUuid } = access;
	if (!target) return dataAccessLost();
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
		!settings?.commcare_username ||
		!settings.commcare_api_key ||
		settings.commcare_server !== target.server ||
		!settings.approved_domains.some((d) => d.name === target.domain)
	)
		return dataAccessLost();
	if (access.purpose === "export" && !personaUuid) return dataAccessLost();
	const rows = await sql<{
		deployment: string;
		endings: number;
		workerId: string | null;
		username: string | null;
		push: string | null;
	}>`
		SELECT d.id::text deployment,d.endings,r.remote_id "workerId",r.pushed_identity username,r.push_token::text push
		FROM app_deployments d LEFT JOIN app_deployment_resources r ON r.deployment_id=d.id AND r.kind='worker'
		AND r.nova_resource_id=${personaUuid ?? null} AND r.superseded_at IS NULL
		WHERE d.app_id=${scope.appId} AND d.project_id=${scope.projectId} AND d.server=${target.server}
		AND d.domain=${target.domain} AND d.state<>'ended' FOR SHARE OF d`.execute(
		tx,
	);
	const row = rows.rows[0];
	if (
		rows.rows.length !== 1 ||
		!row ||
		(personaUuid && (!row.username || !row.workerId)) ||
		(target.workerId && target.workerId !== row.workerId)
	)
		return dataAccessLost();
	const worker =
		personaUuid && row.username && row.workerId
			? { username: row.username, userId: row.workerId }
			: { username: settings.commcare_username };
	return {
		worker,
		principal: canonicalJsonDigest([
			locked.principal,
			target.server,
			target.domain,
			row,
			settings.commcare_username,
			settings.commcare_api_key,
		]),
		digest: canonicalJsonDigest([
			locked.digest,
			target.server,
			target.domain,
			row,
			settings.commcare_username,
			settings.commcare_api_key,
		]),
	};
}

// A local table on a named destination is readable only after its own
// deployment ledger maps the Project table to an actual target table.
async function lookupBinding(
	tx: Transaction<AppDatabase>,
	access: WorkerProjectionAccess,
	definition: LookupTableDefinition,
) {
	const source = requiresLookupProjection(definition.hq)
		? definition.hq
		: undefined;
	const target = access.target ?? source;
	if (!target) return unavailable(definition.name);
	const binding = await assertWorkerTargetBinding(tx, { ...access, target });
	if (
		source &&
		source.server === target.server &&
		source.domain === target.domain
	)
		return { ...binding, tableId: source.remoteId, revision: null };
	const { rows } = await sql<{
		id: string;
		revision: string;
	}>`SELECT r.remote_id id, r.push_token::text revision
   FROM app_deployments d JOIN app_deployment_resources r ON d.id=r.deployment_id
   WHERE d.project_id=${access.scope.projectId} AND d.app_id=${access.scope.appId} AND d.server=${target.server} AND d.domain=${target.domain}
     AND d.state<>'ended' AND r.superseded_at IS NULL AND r.kind='lookup-table' AND r.nova_resource_id=${definition.id}
   FOR SHARE OF d,r`.execute(tx);
	if (rows.length !== 1 || !rows[0].id) return unavailable(definition.name);
	return { ...binding, tableId: rows[0].id, revision: rows[0].revision };
}

async function readRemoteWorkerTable(
	access: WorkerProjectionAccess,
	definition: LookupTableDefinition,
) {
	const target = access.target ?? definition.hq;
	if (!target) return unavailable(definition.name);
	const selected = { ...access, target };
	const initial = await withAppTx((tx) =>
		lookupBinding(tx, selected, definition),
	);
	const response = await getHqCredentials(
		access.scope.actorUserId,
		target.domain,
	);
	if (!response.ok || response.creds.server !== target.server)
		return unavailable(definition.name);
	const { creds } = response;
	const list = await listHqLookupTables(creds, target.domain);
	if ("success" in list) return unavailable(definition.name);
	const matches = list.filter((t) => t.tag === definition.tag);
	const [table] = matches;
	if (matches.length !== 1 || !table || table.id !== initial.tableId)
		return unavailable(definition.name);
	if (initial.worker.userId) {
		const result = await findHqMobileWorkers(creds, target.domain, [
			initial.worker.username,
		]);
		if (
			"success" in result ||
			result.length !== 1 ||
			result[0].userId !== initial.worker.userId ||
			result[0].username !== initial.worker.username
		)
			return unavailable(definition.name);
	}
	const proof = await readLookupWorkerRestore(
		creds,
		target.domain,
		table,
		initial.worker,
		{
			binding: canonicalJsonDigest([
				initial.digest,
				definition.id,
				initial.tableId,
				definition.definitionRevision,
			]),
		},
	);
	if (
		"success" in proof ||
		proof.read !== "full" ||
		proof.principal !== (access.personaUuid ? "commcare" : "web") ||
		(initial.worker.userId && proof.workerId !== initial.worker.userId)
	)
		return unavailable(definition.name);
	if (await verifyHqLookupDefinition(creds, target.domain, table))
		return unavailable(definition.name);
	return {
		rows: bindWorkerFixtureRows(definition, proof),
		selected,
		digest: canonicalJsonDigest(initial),
		principal: canonicalJsonDigest([
			initial.principal,
			definition.id,
			initial.tableId,
			proof.principal,
			proof.workerId,
			table,
		]),
	};
}

/** Transaction-bound confirmation for a server consumer that fetched the
 * worker's restore before opening its write or evidence-read transaction.
 * The closure pins the actual grant and target mappings and is never serialized. */
export type WorkerProjectionGrantCheck = (tx: Transaction<AppDatabase>) => Promise<void>;
const projectionGrants = new WeakMap<LookupFixtureDataSnapshot, WorkerProjectionGrantCheck>();
export function workerProjectionGrant(snapshot:LookupFixtureDataSnapshot): WorkerProjectionGrantCheck {
	const check=projectionGrants.get(snapshot);
	if(!check) return dataAccessLost();
	return check;
}

/** Every value here is a real worker fixture. The owner inventory, a name
 * supplied by an editor and the first page of a restore cannot stand in for it. */
export async function readWorkerLookupProjection(
	access: WorkerProjectionAccess,
	tableIds: readonly LookupTableId[],
	includeGroups = false,
): Promise<
	LookupFixtureDataSnapshot & {
		workerBinding: string;
		groupScope?: WorkerRestoreScope;
	}
> {
	const initial = await withAppTx(
		async (tx) => {
			const authority = await lockWorkerAccess(tx, access);
			const explicit = access.target
				? await assertWorkerTargetBinding(tx, access)
				: undefined;
			const remaining = { bytes: DEVICE_FIXTURE_BYTES };
			const snapshot = await readLookupFixtureDataInTransaction(
				tx,
				access.scope.projectId,
				tableIds,
				{ ...authority.worker, remoteAssignments: !!access.target },
				remaining,
			);
			const app = includeGroups && !explicit
				? await loadAppInTransaction(tx, access.scope.appId)
				: undefined;
			const groupScope = app
				? await workerRestoreScope(tx, {
						appId: access.scope.appId,
						projectId: access.scope.projectId,
						blueprint: app.blueprint,
						identity: {
							actorUserId: access.scope.actorUserId,
							personaUuid: access.personaUuid,
							ownerId: access.personaUuid ?? access.scope.actorUserId,
						},
					})
				: undefined;
			if (includeGroups && !explicit && !groupScope) return dataAccessLost();
			return { authority, explicit, snapshot, remaining, groupScope };
		},
		{ isolationLevel: "repeatable read" },
	);
	const rowsByTable = new Map(initial.snapshot.rowsByTable);
	const principals = [
		initial.authority.principal,
		initial.explicit?.principal ?? null,
	];
	let groupScope=initial.groupScope;
 if(includeGroups && initial.explicit && access.target){
  const creds=await getHqCredentials(access.scope.actorUserId,access.target.domain);
  if(!creds.ok || creds.creds.server!==access.target.server)return dataAccessLost();
  const read=await readWorkerGroupsRestore(creds.creds,access.target.domain,initial.explicit.worker,initial.explicit.digest);
  if("success" in read||read.principal!==(access.personaUuid?"commcare":"web"))throw new LookupError("managed_in_hq","Nova couldn't read the groups delivered to this worker. You can check their connection and try again.");
  groupScope={groups:read.groups,ownerIds:[...new Set([read.workerId,...read.groups.map(g=>g.id)])]};
  principals.push(canonicalJsonDigest([read.workerId,read.principal,read.groups]));
 }
 if(groupScope)chargeDeviceFixture(Buffer.byteLength(JSON.stringify(groupScope)),initial.remaining);
 const reads: {
		access: WorkerProjectionAccess;
		definition: LookupTableDefinition;
		digest: string;
	}[] = [];
	for (const definition of initial.snapshot.definitions)
		if (
			requiresLookupProjection(definition.hq) ||
			(access.target && definition.workerAccess === "assigned")
		) {
			const read = await readRemoteWorkerTable(access, definition);
			for (const row of read.rows)
				chargeDeviceFixture(
					128 + Buffer.byteLength(JSON.stringify(row)),
					initial.remaining,
				);
			rowsByTable.set(definition.id, read.rows);
			principals.push(read.principal);
			reads.push({ access: read.selected, definition, digest: read.digest });
		}

	const check: WorkerProjectionGrantCheck = async (tx) => {
		const now = await lockWorkerAccess(tx, access);
		if (now.digest !== initial.authority.digest) return dataAccessLost();
		if (
			initial.explicit &&
			(await assertWorkerTargetBinding(tx, access)).digest !==
				initial.explicit.digest
		)
			return dataAccessLost();
		for (const read of reads)
			if (
				canonicalJsonDigest(
					await lookupBinding(tx, read.access, read.definition),
				) !== read.digest
			)
				return dataAccessLost();
	};
	await withAppTx(check);
	const projected = {
		...initial.snapshot,
		rowsByTable,
		workerBinding: canonicalJsonDigest(principals),
		...(groupScope && {groupScope}),
	};
	projectionGrants.set(projected,check);
	return projected;
}
