// Personal-Project provisioning — the idempotent get-or-create for a user's
// own Project (Better Auth organization). Every user has exactly one personal
// Project, created on first sign-in (the `session.create.before` hook in
// `lib/auth.ts`) and used as their default active Project; a backfill seeds it
// for users who predate the feature.
//
// Writes go DIRECTLY through `getAuthDb` (the shared Kysely handle), NOT through
// `auth.api.createOrganization`: this runs inside `session.create.before`, so a
// router round-trip would risk re-entrancy and the create-org endpoint's
// active-organization side effects. The org + owner membership are created in
// ONE transaction so a partial failure can't leave an org with no membership
// (which the fast path would then trust); the per-user-unique slug arbitrates
// concurrent callers via the org table's unique constraint.

import { randomUUID } from "node:crypto";
import { getAuthDb } from "./db";

/** Display name for every user's personal Project. */
const PERSONAL_PROJECT_NAME = "Personal";

/**
 * Deterministic, per-user-unique slug for the personal Project. `userId` is
 * unique, so the slug is too — which is what lets a concurrent caller detect
 * the race (a unique-violation on insert) and re-select the winner's row.
 */
export function personalProjectSlug(userId: string): string {
	return `personal-${userId}`;
}

/**
 * Returns the id of the user's personal Project, creating it (and the owner
 * membership) if absent. Idempotent and safe under concurrent calls.
 *
 * Throws only on an unexpected database failure — including a foreign-key
 * violation when `userId` has no `auth_user` row (a deleted/never-migrated
 * user). Callers inside auth hooks MUST wrap it so a provisioning hiccup never
 * blocks sign-in; the app backfill wraps it per-app so one ghost owner can't
 * abort the run.
 */
export async function ensurePersonalProject(userId: string): Promise<string> {
	const db = await getAuthDb();
	const slug = personalProjectSlug(userId);

	// Fast path: already provisioned. The personal org's slug is unique to this
	// user and its owner membership is created in the SAME transaction below, so
	// "org exists" implies "membership exists" — no redundant member write here.
	const existing = await db
		.selectFrom("auth_organization")
		.select("id")
		.where("slug", "=", slug)
		.executeTakeFirst();
	if (existing !== undefined) return existing.id;

	const organizationId = randomUUID();
	try {
		await db.transaction().execute(async (tx) => {
			await tx
				.insertInto("auth_organization")
				.values({
					id: organizationId,
					name: PERSONAL_PROJECT_NAME,
					slug,
					logo: null,
					metadata: JSON.stringify({ personal: true }),
					createdAt: new Date(),
				})
				.execute();
			await tx
				.insertInto("auth_member")
				.values({
					id: randomUUID(),
					organizationId,
					userId,
					role: "owner",
					createdAt: new Date(),
				})
				.execute();
		});
		return organizationId;
	} catch (err) {
		// A concurrent caller may have won the unique-slug race — re-select and
		// use the winner's org. If the org still isn't there, the failure was
		// something else (e.g. a foreign-key violation because `userId` has no
		// `auth_user` row), so surface it.
		const row = await db
			.selectFrom("auth_organization")
			.select("id")
			.where("slug", "=", slug)
			.executeTakeFirst();
		if (row !== undefined) return row.id;
		throw err;
	}
}
