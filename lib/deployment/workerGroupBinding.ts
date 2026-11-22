import "server-only";
import { sql, type Transaction } from "kysely";
import {
	dataAccessLost,
	lockProjectDataGrant,
	type ProjectDataGrant,
} from "@/lib/auth/dataGrant";
import { NOVA_MCP_FLOOR_SCOPES } from "@/lib/auth-public";
import {
	readTargetWorkerGroup,
	searchTargetWorkerGroups,
	type TargetWorkerGroup,
} from "@/lib/commcare/hq/workerGroups";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { getHqCredentials } from "@/lib/db/settings";
import type { Uuid } from "@/lib/domain/uuid";
import { authorizeAgentScopeInTransaction } from "@/lib/lookup/agentService";
import { LookupError } from "@/lib/lookup/errors";
import { lookupEditOnce } from "@/lib/lookup/operationReceipt";
import type { LookupAgentWriteScope } from "@/lib/lookup/types";
import {
	advanceLookupProjectRevision,
	authorizeLookupWriteInTransaction,
	lockLookupProjectState,
	notifyCommittedLookupMutation,
} from "@/lib/lookup/writerTransaction";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

export interface GroupBindingAccess {
	scope: { projectId: string; actorId: string };
	grant:
		| ProjectDataGrant
		| { kind: "architect"; authority: LookupAgentWriteScope };
}
type Tx = Transaction<AppDatabase>;
type Selection = { groupId: Uuid; domain: string };
function unavailable(): never {
	throw new LookupError(
		"managed_in_hq",
		"Nova couldn't verify this group in the selected project space. A target administrator can check your permission to read groups and the workers connected to this group, then you can review it again.",
	);
}
async function authority(tx: Tx, { scope, grant }: GroupBindingAccess) {
	const writer = await authorizeLookupWriteInTransaction(tx, scope, "edit");
	if (grant.kind === "architect") {
		const a = grant.authority;
		if (
			!a.chatRunHolder ||
			a.actorId !== scope.actorId ||
			a.projectId !== scope.projectId
		)
			return dataAccessLost();
		await authorizeAgentScopeInTransaction(tx, a, "edit");
	} else
		await lockProjectDataGrant(tx, scope.actorId, grant, [
			...NOVA_MCP_FLOOR_SCOPES,
			"nova.hq.read",
		]);
	return writer;
}

async function settingsFor(tx: Tx, userId: string) {
	return tx
		.selectFrom("user_settings")
		.select([
			"commcare_server",
			"commcare_username",
			"commcare_api_key",
			"approved_domains",
		])
		.where("user_id", "=", userId)
		.forShare()
		.executeTakeFirst();
}
export async function approvedGroupSpaces(access: GroupBindingAccess) {
	return withAppTx(async (tx) => {
		await authority(tx, access);
		const key = await settingsFor(tx, access.scope.actorId);
		return key?.commcare_api_key
			? key.approved_domains.map((domain) => domain.name)
			: [];
	});
}

/** Match each local member by its deployment's stable mobile worker identity.
 * An extra remote member receives every row assigned to this group, so the
 * exact remote audience must equal the reviewed local audience. */
export async function targetGroupFacts(
	tx: Tx,
	projectId: string,
	groupId: string,
	server: string,
	domain: string,
) {
	const {
		rows: [group],
	} = await sql<{
		name: string;
		sharesCases: boolean;
		metadata: Record<string, string>;
	}>`SELECT name,shares_cases "sharesCases",metadata FROM worker_groups WHERE project_id=${projectId} AND id=${groupId} FOR SHARE`.execute(
		tx,
	);
	if (!group) return unavailable();
	const { rows: members } = await sql<{
		app: string;
		persona: string;
		remote: string | null;
		token: string | null;
	}>`SELECT m.app_id app,m.persona_id::text persona,r.remote_id remote,r.push_token::text token
 FROM worker_group_members m LEFT JOIN apps a ON (a.project_id,a.id)=(m.project_id,m.app_id) AND a.deleted_at IS NULL
 LEFT JOIN blueprint_entities p ON p.app_id=a.id AND p.uuid=m.persona_id AND p.kind='persona'
 LEFT JOIN app_deployments d ON d.app_id=p.app_id AND d.project_id=m.project_id AND d.server=${server} AND d.domain=${domain} AND d.state<>'ended'
 LEFT JOIN app_deployment_resources r ON r.deployment_id=d.id AND r.kind='worker' AND r.nova_resource_id=m.persona_id::text AND r.superseded_at IS NULL
 WHERE m.project_id=${projectId} AND m.group_id=${groupId} ORDER BY m.app_id,m.persona_id`.execute(
		tx,
	);
	return { group, members };
}
export function groupAudienceMatches(
	local: Awaited<ReturnType<typeof targetGroupFacts>>,
	remote: TargetWorkerGroup,
) {
	if (local.members.some((row) => !row.remote)) return false;
	const expected = new Set(local.members.map((row) => row.remote));
	const actual = new Set(remote.users);
	return (
		actual.size === expected.size &&
		[...actual].every((id) => expected.has(id)) &&
		local.group.sharesCases === remote.sharesCases
	);
}

async function checkedState(
	tx: Tx,
	access: GroupBindingAccess,
	selected: Selection,
) {
	const writer = await authority(tx, access);
	const key = await settingsFor(tx, access.scope.actorId);
	if (
		!key?.commcare_server ||
		!key.commcare_api_key ||
		!key.approved_domains.some((d) => d.name === selected.domain)
	)
		return dataAccessLost();
	const server = key.commcare_server;
	const local = await targetGroupFacts(
		tx,
		writer.projectId,
		selected.groupId,
		server,
		selected.domain,
	);
	const digest = canonicalJsonDigest([
		writer.projectId,
		writer.actorId,
		selected.groupId,
		selected.domain,
		server,
		key.commcare_username,
		key.commcare_api_key,
		local,
	]);
	return { writer, server, local, digest };
}
export async function reviewWorkerGroupTarget(
	access: GroupBindingAccess,
	selected: Selection,
	query: { name: string } | { remoteId: string },
) {
	const current = () =>
		withAppTx((tx) => checkedState(tx, access, selected), {
			isolationLevel: "repeatable read",
		});
	const start = await current();
	const key = await getHqCredentials(access.scope.actorId, selected.domain);
	if (!key.ok || key.creds.server !== start.server) return unavailable();
	if ("name" in query) {
		const choices = await searchTargetWorkerGroups(
			key.creds,
			selected.domain,
			query.name,
		);
		if (!choices || (await current()).digest !== start.digest)
			return unavailable();
		if (choices.length > 50)
			throw new LookupError(
				"invalid_input",
				"More than 50 target groups have this name. A target administrator can give you the group identifier to review.",
			);
		return { kind: "choices" as const, choices };
	}
	const remote = await readTargetWorkerGroup(
		key.creds,
		selected.domain,
		query.remoteId,
	);
	if (!remote || (await current()).digest !== start.digest)
		return unavailable();
	return {
		kind: "review" as const,
		remoteId: remote.id,
		name: remote.name,
		sharesCases: remote.sharesCases,
		memberCount: remote.users.length,
		matches: groupAudienceMatches(start.local, remote),
		witness: canonicalJsonDigest([start.digest, remote]),
		state: start.digest,
	};
}
export async function bindWorkerGroupTarget(
	access: GroupBindingAccess,
	input: Selection & {
		remoteId: string;
		witness: string;
		operationId: string;
		expectedProjectRevision: string;
	},
) {
	const evidence = await reviewWorkerGroupTarget(access, input, {
		remoteId: input.remoteId,
	});
	if (
		evidence.kind !== "review" ||
		!evidence.matches ||
		evidence.witness !== input.witness
	)
		return unavailable();
	return withAppTx(async (tx) => {
		const current = await checkedState(tx, access, input);
		if (current.digest !== evidence.state) return unavailable();
		const state = await lockLookupProjectState(tx, current.writer);
		return lookupEditOnce(
			tx,
			current.writer,
			input.operationId,
			"workerGroupTarget",
			input,
			async () => {
				if (state.revision !== input.expectedProjectRevision)
					throw new LookupError(
						"conflict",
						"The Project data changed. You can refresh the group and review its connection again.",
					);
				const result =
					await sql`INSERT INTO worker_group_targets(project_id,group_id,server,domain,remote_id,confirmed_name)
    VALUES (${access.scope.projectId},${input.groupId},${current.server},${input.domain},${input.remoteId},${evidence.name}) ON CONFLICT(project_id,group_id,server,domain) DO UPDATE SET remote_id=excluded.remote_id,confirmed_name=excluded.confirmed_name WHERE (worker_group_targets.remote_id,worker_group_targets.confirmed_name) IS DISTINCT FROM (excluded.remote_id,excluded.confirmed_name)`.execute(
						tx,
					);
				const projectRevision = result.numAffectedRows
					? await advanceLookupProjectRevision(tx, access.scope.projectId)
					: state.revision;
				if (result.numAffectedRows)
					await notifyCommittedLookupMutation(
						tx,
						access.scope.projectId,
						projectRevision,
					);
				return { groupId: input.groupId, projectRevision };
			},
		);
	});
}

export async function readGroupTarget(
	access: GroupBindingAccess,
	request: import("@/lib/lookup/assignmentVocabulary").TargetGroupRead,
) {
	if (request.kind === "spaces")
		return {
			kind: "spaces" as const,
			domains: await approvedGroupSpaces(access),
		};
	return reviewWorkerGroupTarget(
		access,
		request,
		request.kind === "find"
			? { name: request.name }
			: { remoteId: request.remoteId },
	);
}
