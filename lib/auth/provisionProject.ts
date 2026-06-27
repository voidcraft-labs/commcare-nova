// Personal-Project provisioning — the idempotent get-or-create for a user's
// own Project (Better Auth organization). Every user has exactly one personal
// Project, created on first sign-in (the `session.create.before` hook in
// `lib/auth.ts`) and used as their default active Project; a backfill seeds it
// for users who predate the feature.
//
// Writes go DIRECTLY through `getAuthDb` (the shared Kysely handle), NOT through
// `auth.api.createOrganization`: this runs inside `session.create.before`, so a
// router round-trip would risk re-entrancy and the create-org endpoint's
// active-organization side effects. A direct insert populates every NOT NULL
// column the org plugin's schema requires (`id`/`name`/`slug`/`createdAt`) and a
// per-user-unique `slug`, and is race-safe via `ON CONFLICT DO NOTHING` + a
// re-select. The owner membership relies on the Nova-owned UNIQUE index on
// `auth_member(organizationId, userId)` (see lib/auth/migrations) for the same
// idempotency.

import { randomUUID } from "node:crypto";
import { getAuthDb } from "./db";

/** Display name for every user's personal Project. */
const PERSONAL_PROJECT_NAME = "Personal";

/**
 * Deterministic, per-user-unique slug for the personal Project. `userId` is
 * unique, so the slug is too — which is what makes the `ON CONFLICT (slug)`
 * insert idempotent and lets a concurrent caller re-select the winner's row.
 */
export function personalProjectSlug(userId: string): string {
	return `personal-${userId}`;
}

/**
 * Returns the id of the user's personal Project, creating it (and the owner
 * membership) if absent. Idempotent and safe under concurrent calls. Throws
 * only on an unexpected database failure — callers inside auth hooks MUST
 * wrap it so a provisioning hiccup never blocks sign-in.
 */
export async function ensurePersonalProject(userId: string): Promise<string> {
	const db = await getAuthDb();
	const slug = personalProjectSlug(userId);

	const existing = await db
		.selectFrom("auth_organization")
		.select("id")
		.where("slug", "=", slug)
		.executeTakeFirst();

	let organizationId = existing?.id;
	if (organizationId === undefined) {
		organizationId = randomUUID();
		await db
			.insertInto("auth_organization")
			.values({
				id: organizationId,
				name: PERSONAL_PROJECT_NAME,
				slug,
				logo: null,
				metadata: JSON.stringify({ personal: true }),
				createdAt: new Date(),
			})
			// A concurrent caller may have inserted first; the re-select below
			// recovers the winner's id either way.
			.onConflict((oc) => oc.column("slug").doNothing())
			.execute();
		const row = await db
			.selectFrom("auth_organization")
			.select("id")
			.where("slug", "=", slug)
			.executeTakeFirstOrThrow();
		organizationId = row.id;
	}

	// Idempotent via the Nova-owned UNIQUE(organizationId, userId) index.
	await db
		.insertInto("auth_member")
		.values({
			id: randomUUID(),
			organizationId,
			userId,
			role: "owner",
			createdAt: new Date(),
		})
		.onConflict((oc) => oc.columns(["organizationId", "userId"]).doNothing())
		.execute();

	return organizationId;
}
