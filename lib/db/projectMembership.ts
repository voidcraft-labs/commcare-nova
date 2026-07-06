// The `auth_member` role read — the caller's role in a Project.
//
// Extracted from `appAccess.ts` so both `appAccess.ts` and `apps.ts` can import
// it. `apps.ts::commitGuardedBatch` reauthorizes every commit against Project
// membership, and `appAccess.ts` already imports `apps.ts` (for `loadApp` /
// `loadAppProjectId`) — so keeping this read in `appAccess.ts` would form an
// `apps.ts`↔`appAccess.ts` cycle. This module reads `getAuthDb()` and imports
// nothing from `apps.ts`.

import { getAuthDb } from "@/lib/auth/db";

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
