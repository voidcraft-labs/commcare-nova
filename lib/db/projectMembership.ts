// The `auth_member` role read — the caller's role in a Project.
//
// Extracted from `appAccess.ts` so both `appAccess.ts` and `apps.ts` can import
// it. `apps.ts::commitGuardedBatch` reauthorizes every commit against Project
// membership, and `appAccess.ts` already imports `apps.ts` (for `loadApp` /
// `loadAppProjectId`) — so keeping this read in `appAccess.ts` would form an
// `apps.ts`↔`appAccess.ts` cycle. This module reads `getAuthDb()` and imports
// nothing from `apps.ts`.

import { sql, type Transaction } from "kysely";
import { getAuthDb } from "@/lib/auth/db";
import type { AppDatabase } from "./pg";

/**
 * The caller's role in `organizationId` (the internal noun for a Project), or
 * `null` if they aren't a member. The `(organizationId, userId)` unique index
 * on `auth_member` makes one row per Project.
 */
export async function projectRoleFor(
	userId: string,
	organizationId: string,
): Promise<string | null> {
	const db = await getAuthDb();
	const row = await db
		.selectFrom("auth_member")
		.select("role")
		.where("userId", "=", userId)
		.where("organizationId", "=", organizationId)
		.executeTakeFirst();
	return row?.role ?? null;
}

interface LockedProjectRoleRow {
	role: string;
}

/**
 * Fresh Project membership read on an authoritative app writer's transaction.
 *
 * The raw query is intentional: Better Auth and Nova share the same Postgres,
 * while `AppDatabase` does not expose Better Auth's tables in its Kysely type.
 * `FOR SHARE` makes an existing membership/role row part of the writer's lock
 * set, so a concurrent downgrade or removal cannot commit until this app write
 * has made its decision. A missing row remains missing; S02c adds the separate
 * membership advisory gate needed to serialize absence for Project moves.
 */
export async function projectRoleForInTransaction(
	tx: Transaction<AppDatabase>,
	userId: string,
	organizationId: string,
): Promise<string | null> {
	const result = await sql<LockedProjectRoleRow>`
		SELECT role
		FROM auth_member
		WHERE "userId" = ${userId}
			AND "organizationId" = ${organizationId}
		FOR SHARE
	`.execute(tx);
	if (result.rows.length > 1) {
		throw new Error("Project membership uniqueness invariant was violated.");
	}
	return result.rows[0]?.role ?? null;
}
