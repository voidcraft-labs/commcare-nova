import "server-only";
import { sql, type Transaction } from "kysely";
import { HQ_LOOKUP_TABLE_ROWS_MAX_BYTES } from "@/lib/commcare/hq/bounds";
import { lookupDeviceRow } from "@/lib/commcare/hq/lookupCoverage";
import { readLookupWorkerRestore } from "@/lib/commcare/hq/lookupRestore";
import {
	readSelectedHqLookupRows,
	verifyHqLookupDefinition,
} from "@/lib/commcare/hq/lookupSource";
import {
	type LookupOwnerKind,
	lookupOwnerKinds,
} from "@/lib/commcare/hq/lookupWorkbook";
import { giveBackHeld } from "@/lib/commcare/hq/memoryMeter";
import { readTargetWorkerGroup } from "@/lib/commcare/hq/workerGroups";
import { findHqMobileWorkers } from "@/lib/commcare/hq/workers";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import {
	type RowAssignee,
	rowAssigneeSchema,
} from "@/lib/lookup/assignmentVocabulary";
import { LookupError } from "@/lib/lookup/errors";
import {
	type InventoryAccess,
	lockInventoryScope,
} from "@/lib/lookup/generations/scope";
import { transferGeneration } from "@/lib/lookup/generations/transfer";
import {
	type ManagedTableReview,
	takeOverManagedLookupTableInTransaction,
} from "@/lib/lookup/managed";
import type { SourceRowAssignment } from "@/lib/lookup/sourceAssignments";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { canonicalLookupTable } from "./hqResourceBaseline";
import {
	type SelectedWorkbookEvidence,
	withFreshSelectedWorkbook,
} from "./managedLookupObservation";
import { groupAudienceMatches, targetGroupFacts } from "./workerGroupBinding";

function missing(): never {
	throw new LookupError(
		"managed_in_hq",
		"Each row assignment needs one confirmed worker, group or place in the source project space. You can connect missing people, groups and places, or keep using the source table.",
	);
}
function changed(): never {
	throw new LookupError(
		"conflict",
		"The source or its worker access changed. You can refresh the table, download its current workbook and try again.",
	);
}
const key = (kind: string, id: string) => JSON.stringify([kind, id]);

/** A name is never a reverse lookup key. Each source principal resolves to exactly
 * one live local principal through this same space's own immutable source IDs. */
async function mappedAudience(
	tx: Transaction<AppDatabase>,
	access: InventoryAccess,
	evidence: SelectedWorkbookEvidence,
) {
	const { scope, tableId } = access;
	const locked = await lockInventoryScope(tx, access, "transfer");
	if (
		locked.scopeDigest !== evidence.scopeDigest ||
		locked.revision !== evidence.revision ||
		locked.table.hq_canonical?.digest !== evidence.receipt.contentDigest
	)
		return changed();
	const { server, domain } = locked.origin;
	const wanted = new Map<string, { kind: LookupOwnerKind; id: string }>();
	for (const row of evidence.owners)
		for (const kind of lookupOwnerKinds)
			for (const { id } of row.owners[kind])
				wanted.set(key(kind, id), { kind, id });
	const selected = sql`SELECT kind,id FROM jsonb_to_recordset(${JSON.stringify([...wanted.values()])}::jsonb) q(kind text,id text)`;
	const active = sql`SELECT d.id,d.app_id FROM app_deployments d JOIN apps a ON (d.project_id,d.app_id)=(a.project_id,a.id) WHERE d.project_id=${scope.projectId} AND d.server=${server} AND d.domain=${domain} AND d.state!='ended' AND a.deleted_at IS NULL`;
	const resources = await sql<{
		kind: LookupOwnerKind;
		remote: string;
		app: string | null;
		id: string;
	}>`WITH wanted AS (${selected}), active AS (${active}), principals AS (
  SELECT 'user' kind,r.remote_id remote,d.app_id app,p.uuid id FROM active d JOIN app_deployment_resources r ON r.deployment_id=d.id AND r.kind='worker' AND r.superseded_at IS NULL JOIN blueprint_entities p ON (p.app_id,p.uuid::text)=(d.app_id,r.nova_resource_id) AND p.kind='persona'
  UNION SELECT 'location',r.remote_id,d.app_id,p.id FROM active d JOIN app_deployment_resources r ON r.deployment_id=d.id AND r.kind='location' AND r.superseded_at IS NULL JOIN app_locations p ON (p.app_id,p.id::text)=(d.app_id,r.nova_resource_id) AND p.archived_at IS NULL
  UNION SELECT 'location',p.hq_location_id,a.id,p.id FROM apps a JOIN app_organization_state o ON o.app_id=a.id AND o.hq_server=${server} AND o.hq_domain=${domain} JOIN app_locations p ON p.app_id=a.id AND p.archived_at IS NULL WHERE a.project_id=${scope.projectId} AND a.deleted_at IS NULL
  UNION SELECT 'group',g.remote_id,NULL,g.group_id FROM worker_group_targets g WHERE g.project_id=${scope.projectId} AND g.server=${server} AND g.domain=${domain}
 ) SELECT p.* FROM principals p JOIN wanted w ON (w.kind,w.id)=(p.kind,p.remote) ORDER BY kind,remote,app,id`.execute(
		tx,
	);
	const principals = new Map<string, RowAssignee>();
	for (const r of resources.rows) {
		const k = key(r.kind, r.remote);
		if (principals.has(k)) return missing();
		const p = rowAssigneeSchema.safeParse(
			r.kind === "group"
				? { kind: "group", id: r.id }
				: {
						kind: r.kind === "location" ? "place" : "worker",
						appId: r.app,
						id: r.id,
					},
		);
		if (!p.success) return missing();
		principals.set(k, p.data);
	}
	if (principals.size !== wanted.size) return missing();
	const groups = [];
	for (const [remote, p] of principals)
		if (p.kind === "group") {
			const id = wanted.get(remote);
			if (!id) return missing();
			groups.push({
				remote: id.id,
				facts: await targetGroupFacts(
					tx,
					scope.projectId,
					p.id,
					server,
					domain,
				),
			});
		}
	const assignments: SourceRowAssignment[] = evidence.owners.map((row) => ({
		sourceId: row.rowId,
		principals: lookupOwnerKinds.flatMap((kind) =>
			row.owners[kind].map(
				(owner) => principals.get(key(kind, owner.id)) ?? missing(),
			),
		),
	}));
	const flat = [...principals.values()].map((p) => ({
		kind: p.kind,
		id: p.id,
		app: p.kind === "group" ? null : p.appId,
	}));
	// Include mapped workers with zero rows too: revoking their last row must
	// produce an empty restore. A worker who would gain rows needs a real binding.
	const workers = await sql<{
		app: string;
		persona: string;
		remote: string | null;
		name: string | null;
		grants: string[];
		organization: string | null;
	}>`WITH RECURSIVE active AS (${active}),
  wanted AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(flat)}::jsonb) q(kind text,id uuid,app text)),
  people AS (SELECT p.app_id app,p.uuid persona,p.data #>> '{locations,primaryUuid}' place
    FROM apps a JOIN blueprint_entities p ON p.app_id=a.id AND p.kind='persona' WHERE a.project_id=${scope.projectId} AND a.deleted_at IS NULL),
  paths(app,persona,id,parent_id) AS (SELECT p.app,p.persona,l.id,l.parent_id FROM people p JOIN app_locations l ON l.app_id=p.app AND l.id::text=p.place AND l.archived_at IS NULL
    UNION SELECT s.app,s.persona,l.id,l.parent_id FROM paths s JOIN app_locations l ON l.app_id=s.app AND s.parent_id=l.id AND l.archived_at IS NULL),
  matches AS (SELECT w.kind,w.id,w.app source_app,p.app,p.persona FROM wanted w JOIN people p ON w.kind='worker' AND (w.app,w.id)=(p.app,p.persona)
    UNION SELECT w.kind,w.id,w.app source_app,m.app_id,m.persona_id FROM wanted w JOIN worker_group_members m ON w.kind='group' AND m.group_id=w.id AND m.project_id=${scope.projectId}
    UNION SELECT w.kind,w.id,w.app source_app,p.app,p.persona FROM wanted w JOIN paths p ON w.kind='place' AND (w.app,w.id)=(p.app,p.id)),
  remote AS (SELECT d.app_id app,r.nova_resource_id persona,r.remote_id id,r.pushed_identity name FROM active d JOIN app_deployment_resources r ON r.deployment_id=d.id AND r.kind='worker' AND r.superseded_at IS NULL)
  SELECT p.app,p.persona,r.id remote,r.name,ARRAY(SELECT jsonb_build_array(m.kind,m.source_app,m.id)::text FROM matches m WHERE (m.app,m.persona)=(p.app,p.persona) ORDER BY m.kind,m.id) grants,o.revision::text organization
  FROM people p LEFT JOIN remote r ON (r.app,r.persona)=(p.app,p.persona::text) LEFT JOIN app_organization_state o ON o.app_id=p.app
  WHERE r.id IS NOT NULL OR EXISTS(SELECT 1 FROM matches m WHERE (m.app,m.persona)=(p.app,p.persona)) ORDER BY p.app,p.persona,r.id`.execute(
		tx,
	);
	if (workers.rows.some((w) => !w.remote || !w.name)) return missing();
	return {
		assignments,
		groups,
		workers: workers.rows,
		digest: canonicalJsonDigest([
			scope.projectId,
			tableId,
			locked.scopeDigest,
			locked.revision,
			assignments,
			groups,
			workers.rows,
		]),
	};
}

export async function transferAssignedSource(
	access: InventoryAccess,
	review: ManagedTableReview,
	bytes: Buffer,
) {
	return withFreshSelectedWorkbook(
		access,
		bytes,
		"transfer",
		async (evidence) => {
			const { table, receipt, credentials, signal } = evidence;
			if (
				table.isGlobal ||
				review.definition.hq?.source?.inventory !== "complete"
			)
				return changed();
			const before = await withAppTx(
				(tx) => mappedAudience(tx, access, evidence),
				{ isolationLevel: "repeatable read" },
			);
			for (const group of before.groups) {
				signal.throwIfAborted();
				const remote = await readTargetWorkerGroup(
					credentials,
					receipt.domain,
					group.remote,
				);
				if (!remote || !groupAudienceMatches(group.facts, remote))
					return missing();
			}
			const rowDigests = evidence.rows.map((row) => {
				const value = lookupDeviceRow(table, row);
				if (!value) return changed();
				return canonicalJsonDigest(value);
			});
			const ownerKeys = before.assignments.map((row) =>
				row.principals.map((p) =>
					JSON.stringify([p.kind, p.kind === "group" ? null : p.appId, p.id]),
				),
			);
			// The web user's empty fixture also observes index flags when no worker owns
			// any row. Each mapped mobile worker is checked independently, in source order.
			const probes = [
				{ remote: null, name: credentials.username, grants: [] as string[] },
				...before.workers,
			];
			for (const worker of probes) {
				signal.throwIfAborted();
				if (!worker.name) return missing();
				if (worker.remote) {
					const current = await findHqMobileWorkers(
						credentials,
						receipt.domain,
						[worker.name],
					);
					if (
						"success" in current ||
						current.length !== 1 ||
						current[0].userId !== worker.remote ||
						current[0].username !== worker.name
					)
						return missing();
				}
				const observed = await readLookupWorkerRestore(
					credentials,
					receipt.domain,
					table,
					{
						username: worker.name,
						...(worker.remote ? { userId: worker.remote } : {}),
					},
					{ binding: before.digest, cancel: signal },
				);
				if (
					"success" in observed ||
					observed.read !== "full" ||
					observed.principal !== (worker.remote ? "commcare" : "web") ||
					(worker.remote && observed.workerId !== worker.remote) ||
					canonicalJsonDigest(observed.indexedFields) !==
						canonicalJsonDigest(receipt.indexedFields)
				)
					return changed();
				const granted = new Set(
					worker.grants.map((g) => JSON.stringify(JSON.parse(g))),
				);
				const expected = rowDigests.filter((_, i) =>
					ownerKeys[i].some((k) => granted.has(k)),
				);
				if (
					expected.length !== observed.rows.length ||
					expected.some(
						(digest, i) => digest !== canonicalJsonDigest(observed.rows[i]),
					)
				)
					return changed();
			}
			const ended = await readSelectedHqLookupRows(
				credentials,
				receipt.domain,
				table,
				{
					maxBytes: HQ_LOOKUP_TABLE_ROWS_MAX_BYTES,
					maxRows: evidence.rows.length,
					cancel: signal,
				},
			);
			if ("success" in ended || "kind" in ended) return changed();
			try {
				if (
					canonicalLookupTable(table, ended.rows).digest !==
						receipt.contentDigest ||
					ended.rows.some((row, i) => row.id !== evidence.rows[i]?.id)
				)
					return changed();
			} finally {
				giveBackHeld("text", ended.bytes);
			}
			if (
				await verifyHqLookupDefinition(
					credentials,
					receipt.domain,
					table,
					signal,
				)
			)
				return changed();
			await withAppTx(async (tx) => {
				const after = await mappedAudience(tx, access, evidence);
				if (after.digest !== before.digest) return changed();
				const locked = await lockInventoryScope(tx, access, "transfer");
				const generation = locked.table.active_generation_id
					? await transferGeneration(tx, access, "assigned")
					: undefined;
				await takeOverManagedLookupTableInTransaction(
					tx,
					locked.authority,
					access.tableId,
					review,
					new Date(),
					{
						sourceDigest: receipt.contentDigest,
						indexedFields: receipt.indexedFields,
						assignments: after.assignments,
						...(generation
							? { generation: { access, evidence: generation.evidence } }
							: {}),
					},
				);
			});
		},
	);
}
