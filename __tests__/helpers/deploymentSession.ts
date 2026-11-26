import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";

/** The request has already authenticated this session. Its durable row can
 * expire or disappear while Nova waits for a response from CommCare HQ. */
export async function deploymentSession<DB>(db: Kysely<DB>, userId: string) {
	const id = randomUUID();
	await sql`INSERT INTO auth_session (id, token, "userId", "createdAt", "updatedAt", "expiresAt")
		SELECT ${id}, ${id}, id, now(), now(), now() + interval '1 day'
		FROM auth_user WHERE id = ${userId}`.execute(db);
	return { user: { id: userId }, session: { id } };
}
