import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import type { Uuid } from "@/lib/domain/uuid";
import {
	type WorkerGroupEdit,
	workerGroupEditSchema,
} from "./assignmentVocabulary";
import { LookupError } from "./errors";
import { lookupEditOnce } from "./operationReceipt";
import { searchAssignmentDirectory } from "./rowAssignments";
import { parseLookupRevision } from "./schema";
import { assertWorkbookGroupAvailable } from "./workbookHold";
import {
	advanceLookupProjectRevision,
	type LookupWriteAuthority,
	lockLookupProjectState,
	notifyCommittedLookupMutation,
} from "./writerTransaction";

export interface WorkerGroup {
	id: Uuid;
	name: string;
	sharesCases: boolean;
	metadata: Record<string, string>;
}
export function readPersonaGroups(
	tx: Transaction<AppDatabase>,
	appId: string,
	personaId: string,
	sharesCasesOnly: boolean,
	page?: { after?: string; limit: number },
) {
	return sql<WorkerGroup>`SELECT g.id,g.name,g.shares_cases AS "sharesCases",g.metadata FROM apps a
		JOIN worker_group_members m ON (m.project_id,m.app_id)=(a.project_id,a.id)
		JOIN worker_groups g ON (g.project_id,g.id)=(m.project_id,m.group_id)
		WHERE m.persona_id=${personaId} AND a.id=${appId} AND a.deleted_at IS NULL AND (${!sharesCasesOnly} OR g.shares_cases)
		${page?.after ? sql`AND g.id>${page.after}::uuid` : sql``}
		ORDER BY g.id ${page ? sql`LIMIT ${page.limit}` : sql``}`
		.execute(tx)
		.then((result) => result.rows);
}
export async function readWorkerGroup(
	tx: Transaction<AppDatabase>,
	projectId: string,
	id: Uuid,
	offset: number,
) {
	const group =
		await sql<WorkerGroup>`SELECT id,name,shares_cases AS "sharesCases",metadata FROM worker_groups WHERE project_id=${projectId} AND id=${id}`.execute(
			tx,
		);
	if (!group.rows[0])
		throw new LookupError(
			"not_found",
			"This group is no longer available. You can refresh your Project data.",
		);
	const members = await sql<{
		appId: string;
		appName: string;
		personaId: Uuid;
		name: string;
	}>`SELECT m.app_id AS "appId",a.app_name AS "appName",m.persona_id AS "personaId",p.data->>'name' AS name
		FROM worker_group_members m JOIN apps a ON a.id=m.app_id AND a.project_id=m.project_id JOIN blueprint_entities p ON (p.app_id,p.uuid)=(m.app_id,m.persona_id) AND p.kind='persona'
		WHERE m.project_id=${projectId} AND m.group_id=${id} AND a.deleted_at IS NULL ORDER BY m.app_id,m.persona_id LIMIT 51 OFFSET ${offset}`.execute(
		tx,
	);
	return {
		group: group.rows[0],
		members: members.rows.slice(0, 50),
		nextOffset: members.rows.length > 50 ? offset + 50 : null,
	};
}
export async function editWorkerGroup(
	tx: Transaction<AppDatabase>,
	scope: LookupWriteAuthority,
	input: WorkerGroupEdit,
) {
	const parsed = workerGroupEditSchema.parse(input);
	const { projectId } = scope;
	if (parsed.change.kind === "connect")
		throw new LookupError(
			"invalid_input",
			"This group connection needs a fresh review from the project space.",
		);
	const change = parsed.change;
	const state = await lockLookupProjectState(tx, scope);
	return lookupEditOnce(
		tx,
		scope,
		parsed.operationId,
		"workerGroup",
		parsed,
		async () => {
			if (state.revision !== parsed.expectedProjectRevision)
				throw new LookupError(
					"conflict",
					"The Project data changed. You can refresh the group and try again.",
				);

			let id: Uuid;
			let changed: boolean;
			if (change.kind === "membership") {
				id = change.groupId;
				const persona =
					await sql`SELECT 1 FROM worker_groups g,apps a JOIN blueprint_entities p ON p.app_id=a.id WHERE a.project_id=${projectId} AND a.deleted_at IS NULL AND a.id=${change.appId} AND p.kind='persona' AND p.uuid=${change.personaId} AND g.id=${id} AND g.project_id=${projectId} FOR SHARE OF a,g`.execute(
						tx,
					);
				if (!persona.rows.length)
					throw new LookupError(
						"not_found",
						"The worker or group is no longer available. You can refresh your Project data.",
					);
				const result = change.member
					? await sql`INSERT INTO worker_group_members(project_id,group_id,app_id,persona_id) VALUES (${projectId},${id},${change.appId},${change.personaId}) ON CONFLICT DO NOTHING`.execute(
							tx,
						)
					: await sql`DELETE FROM worker_group_members WHERE project_id=${projectId} AND group_id=${id} AND app_id=${change.appId} AND persona_id=${change.personaId}`.execute(
							tx,
						);
				changed = Boolean(result.numAffectedRows);
			} else {
				const metadata = Object.fromEntries(
					change.metadata.map((k) => [k.key, k.value]),
				);
				if (Object.keys(metadata).length !== change.metadata.length)
					throw new LookupError(
						"invalid_input",
						"Each group detail needs its own name.",
					);
				const data = JSON.stringify(metadata);
				if (change.kind === "create") {
					const created = await sql<{
						id: Uuid;
					}>`INSERT INTO worker_groups(project_id,name,shares_cases,metadata) VALUES (${projectId},${change.name},${change.sharesCases},${data}::jsonb) RETURNING id`.execute(
						tx,
					);
					id = created.rows[0].id;
					changed = true;
				} else {
					id = change.groupId;
					const row =
						await sql`SELECT 1 FROM worker_groups WHERE project_id=${projectId} AND id=${id} FOR UPDATE`.execute(
							tx,
						);
					if (!row.rows.length)
						throw new LookupError(
							"not_found",
							"This group is no longer available.",
						);
					const updated =
						await sql`UPDATE worker_groups SET name=${change.name},shares_cases=${change.sharesCases},metadata=${data}::jsonb
					WHERE project_id=${projectId} AND id=${id} AND (name,shares_cases,metadata) IS DISTINCT FROM (${change.name},${change.sharesCases},${data}::jsonb)`.execute(
							tx,
						);
					changed = Boolean(updated.numAffectedRows);
				}
			}
			if (changed) await assertWorkbookGroupAvailable(tx, projectId, id);
			const projectRevision = changed
				? await advanceLookupProjectRevision(tx, projectId)
				: state.revision;
			if (changed)
				await notifyCommittedLookupMutation(tx, projectId, projectRevision);
			return { groupId: id, projectRevision };
		},
	);
}

export async function readGroupDirectory(
	tx: Transaction<AppDatabase>,
	projectId: string,
	input: import("zod").infer<
		typeof import("./assignmentVocabulary").workerDirectoryReadSchema
	>,
) {
	const state = await tx
		.selectFrom("lookup_project_state")
		.select("revision")
		.where("project_id", "=", projectId)
		.executeTakeFirst();
	return {
		projectRevision: parseLookupRevision(state?.revision ?? "0"),
		...(await searchAssignmentDirectory(tx, projectId, input.search)),
		...(input.groupId
			? {
					selected: await readWorkerGroup(
						tx,
						projectId,
						input.groupId,
						input.memberOffset ?? 0,
					),
				}
			: {}),
	};
}
