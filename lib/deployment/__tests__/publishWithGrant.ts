import { sql } from "kysely";
import type { ProjectDataGrant } from "@/lib/auth/dataGrant";
import { getAppDb } from "@/lib/db/pg";
import { type PublishInput, publishAppToHq } from "../service";

/** A verified session backed by the same migrated auth tables as a browser publish. */
export async function publishSession(
	userId: string,
): Promise<ProjectDataGrant> {
	const id = `publish-session-${userId}`;
	await sql`INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt")
 SELECT ${id},${`token-${id}`},id,now()+interval '1 hour',now(),now() FROM auth_user WHERE id=${userId}
 ON CONFLICT(id) DO NOTHING`.execute(await getAppDb());
	return { kind: "session", sessionId: id };
}

export async function publishFromSession(input: PublishInput) {
	return publishAppToHq({
		...input,
		dataGrant:
			input.dataGrant ?? (await publishSession(input.scope.actorUserId)),
	});
}
