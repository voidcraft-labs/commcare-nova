/** A browser grant over Project data is held by the user acting in the
 * session: the signed-in user, or the admin acting through impersonation. */
import { sql } from "kysely";
import { expect, it } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { lockProjectDataGrant } from "@/lib/auth/dataGrant";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

const database = setupAppStateTestDb("data_grant_", {
	authSchema: "migrated",
});

async function session(
	id: string,
	userId: string,
	impersonatedBy: string | null = null,
): Promise<void> {
	await sql`INSERT INTO auth_session (id, token, "userId", "expiresAt", "createdAt", "updatedAt", "impersonatedBy")
		VALUES (${id}, ${`token-${id}`}, ${userId}, now() + interval '1 hour', now(), now(), ${impersonatedBy})`.execute(
		database.db(),
	);
}

async function ban(userId: string): Promise<void> {
	await database
		.pool()
		.query(
			'UPDATE auth_user SET banned = true, "banExpires" = NULL WHERE id = $1',
			[userId],
		);
}

function lock(userId: string, sessionId: string) {
	return database.withTransaction((tx) =>
		lockProjectDataGrant(tx, userId, { kind: "session", sessionId }, []),
	);
}

it("holds an ordinary session for its own active user and ends it with a ban", async () => {
	await database.seedProjectMember("worker", "project");
	await session("own", "worker");
	expect(await lock("worker", "own")).toEqual(["session", "own"]);
	await expect(lock("other", "own")).rejects.toMatchObject({
		code: "not_found",
	});
	await ban("worker");
	await expect(lock("worker", "own")).rejects.toMatchObject({
		code: "not_found",
	});
});

it("lets an active admin investigate a banned target", async () => {
	await database.seedProjectMember("target", "project");
	await database.seedProjectMember("admin", "admin-project");
	await session("investigation", "target", "admin");
	await ban("target");
	expect(await lock("target", "investigation")).toEqual([
		"session",
		"investigation",
	]);
});

it("ends an impersonated grant when the acting admin is banned during the wait", async () => {
	await database.seedProjectMember("target", "project");
	await database.seedProjectMember("admin", "admin-project");
	await session("investigation", "target", "admin");
	await expect(
		whileBlocked(
			database,
			(pg) =>
				pg.query(
					'UPDATE auth_user SET banned = true, "banExpires" = NULL WHERE id = $1',
					["admin"],
				),
			() => lock("target", "investigation"),
			async (settled) => {
				expect(settled).toBe(false);
			},
			undefined,
			"COMMIT",
		),
	).rejects.toMatchObject({ code: "not_found" });
	/* The target's own standing never decided the grant. */
	const target = await database
		.pool()
		.query<{ banned: boolean | null }>(
			"SELECT banned FROM auth_user WHERE id = $1",
			["target"],
		);
	expect(target.rows[0]?.banned ?? false).toBe(false);
});
