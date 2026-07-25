/** Transactional membership admission for app moves. */

import { sql, type Transaction } from "kysely";
import { roleIsOwner } from "@/lib/auth/projectRoles";
import type { AppDatabase } from "./pg";
import { lockProjectMembershipGateShared } from "./projectMembershipGate";

interface MembershipRow {
	readonly organization_id: string;
	readonly user_id: string;
	readonly role: string;
}

export interface LockedProjectMoveMemberships {
	readonly actorSourceRole: string | null;
	readonly actorDestinationRole: string | null;
	readonly actorIsSourceOwner: boolean;
	readonly sourceOwnerIds: readonly string[];
	readonly sourceOwnersMissingFromDestination: readonly string[];
}

/**
 * Freeze membership DML, discover source owners, then lock the actor and every
 * source-owner membership pair across both Projects in canonical order.
 */
export async function lockProjectMoveMemberships(
	tx: Transaction<AppDatabase>,
	args: {
		actorUserId: string;
		sourceProjectId: string;
		destinationProjectId: string;
	},
): Promise<LockedProjectMoveMemberships> {
	await lockProjectMembershipGateShared(tx);
	const ownerDiscovery = await sql<{ user_id: string; role: string }>`
		SELECT "userId" AS user_id, role
		FROM auth_member
		WHERE "organizationId" = ${args.sourceProjectId}
		ORDER BY "userId"
	`.execute(tx);
	const sourceOwnerIds = ownerDiscovery.rows
		.filter((row) => roleIsOwner(row.role))
		.map((row) => row.user_id);
	const relevantUserIds = [
		...new Set([args.actorUserId, ...sourceOwnerIds]),
	].sort();
	const projectIds = [
		...new Set([args.sourceProjectId, args.destinationProjectId]),
	].sort();
	const locked = await sql<MembershipRow>`
		SELECT
			"organizationId" AS organization_id,
			"userId" AS user_id,
			role
		FROM auth_member
		WHERE "organizationId" IN (${sql.join(projectIds)})
			AND "userId" IN (${sql.join(relevantUserIds)})
		ORDER BY "organizationId", "userId"
		FOR SHARE
	`.execute(tx);
	const byPair = new Map(
		locked.rows.map((row) => [
			`${row.organization_id}\u0000${row.user_id}`,
			row.role,
		]),
	);
	const roleFor = (projectId: string, userId: string) =>
		byPair.get(`${projectId}\u0000${userId}`) ?? null;
	const actorSourceRole = roleFor(args.sourceProjectId, args.actorUserId);
	return {
		actorSourceRole,
		actorDestinationRole: roleFor(args.destinationProjectId, args.actorUserId),
		actorIsSourceOwner:
			actorSourceRole !== null && roleIsOwner(actorSourceRole),
		sourceOwnerIds,
		sourceOwnersMissingFromDestination: sourceOwnerIds.filter(
			(userId) => roleFor(args.destinationProjectId, userId) === null,
		),
	};
}
