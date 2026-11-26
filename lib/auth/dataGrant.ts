import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import { LookupError } from "@/lib/lookup/errors";
import { lockOAuthGrantGate } from "./grantGate";

/** Identifiers from a verified request. No bearer, cookie, or plaintext HQ key
 * is retained by a bulk job. Expiry and permissions are checked for each page. */
export type ProjectDataGrant =
	| { kind: "session"; sessionId: string }
	| { kind: "api-key"; keyId: string }
	| {
			kind: "oauth";
			clientId: string;
			issuedAt: number;
			expiresAt: number;
			scopes: readonly string[];
	  };

export function dataAccessLost(): never {
	throw new LookupError(
		"not_found",
		"This data is no longer available with this connection. You can sign in and refresh it.",
	);
}

/** Lock the user that must still be active for this grant: `userId`, or for a
 * session the acting user. During admin impersonation Better Auth puts the
 * session on the TARGET user and records the acting admin in
 * `impersonatedBy` (`lib/auth-utils.ts::sessionUserIsActive`). The admin's
 * ban ends the grant, and a banned target an active admin is investigating
 * does not. Project membership stays the effective user's, which the caller
 * checks with `userId`. */
async function lockActiveUser(
	tx: Transaction<AppDatabase>,
	userId: string,
): Promise<boolean> {
	const user = await sql`SELECT 1 FROM auth_user WHERE id = ${userId} AND
		(banned IS DISTINCT FROM true OR "banExpires" < clock_timestamp()) FOR SHARE`.execute(
		tx,
	);
	return user.rows.length === 1;
}

/** Hold current user, credential, consent and scopes until the consuming
 * operation commits. Immediate management writes do not retain grant epochs. */
export async function lockCurrentProjectGrant(
	tx: Transaction<AppDatabase>,
	userId: string,
	grant: ProjectDataGrant,
	requiredScopes: readonly string[],
): Promise<readonly string[] | null> {
	if (grant.kind === "session") {
		/* The acting user is locked before the session, in the order a ban
		 * takes them, and the session row is then rechecked for that same
		 * actor under its own lock. */
		const read = await sql<{ actor: string | null }>`SELECT
			"impersonatedBy" AS actor FROM auth_session WHERE id=${grant.sessionId}
			AND "userId"=${userId}`.execute(tx);
		const peeked = read.rows[0];
		if (peeked === undefined) return null;
		const actor = peeked.actor ?? userId;
		if (!(await lockActiveUser(tx, actor))) return null;
		const session =
			await sql`SELECT 1 FROM auth_session WHERE id=${grant.sessionId}
			AND "userId"=${userId} AND "impersonatedBy" IS NOT DISTINCT FROM ${peeked.actor}
			AND "expiresAt" > clock_timestamp() FOR SHARE`.execute(tx);
		if (session.rows.length !== 1) return null;
		return ["session", grant.sessionId];
	}
	if (!(await lockActiveUser(tx, userId))) return null;
	const scopes = JSON.stringify(requiredScopes);
	if (grant.kind === "api-key") {
		const key =
			await sql`SELECT 1 FROM auth_apikey WHERE id=${grant.keyId} AND "referenceId"=${userId}
			AND enabled IS DISTINCT FROM false AND ("expiresAt" IS NULL OR "expiresAt" > clock_timestamp())
			AND CASE WHEN permissions IS JSON OBJECT THEN (permissions::jsonb->'scope') @> ${scopes}::jsonb ELSE false END FOR SHARE`.execute(
				tx,
			);
		if (!key.rows.length) return null;
		return ["api-key", grant.keyId];
	}
	if (requiredScopes.some((scope) => !grant.scopes.includes(scope)))
		return null;
	await lockOAuthGrantGate(tx, userId, grant.clientId, "read");
	const consent = await sql<{ id: string }>`SELECT id FROM auth_oauth_consent
		WHERE "clientId"=${grant.clientId} AND "userId"=${userId} AND scopes @> ${scopes}::jsonb
		AND to_timestamp(${grant.expiresAt}) > clock_timestamp() ORDER BY id LIMIT 1 FOR SHARE`.execute(
		tx,
	);
	if (consent.rows.length !== 1) return null;
	const watermark = await sql<{
		revoked: Date;
		active: boolean;
	}>`SELECT "revokedAt" AS revoked,
		("revokedAt" < to_timestamp(${grant.issuedAt})) AS active FROM auth_oauth_grant_revocation
		WHERE "userId"=${userId} AND "clientId"=${grant.clientId} FOR SHARE`.execute(
		tx,
	);
	if (watermark.rows[0] && !watermark.rows[0].active) return null;
	return [
		"oauth",
		grant.clientId,
		consent.rows[0].id,
		watermark.rows[0]?.revoked.toISOString() ?? "",
	];
}

/** Resumable private-data operations additionally bind the API-key grant epoch. */
export async function lockProjectDataGrant(
	tx: Transaction<AppDatabase>,
	userId: string,
	grant: ProjectDataGrant,
	requiredScopes: readonly string[],
): Promise<readonly string[]> {
	const identity = await lockCurrentProjectGrant(
		tx,
		userId,
		grant,
		requiredScopes,
	);
	if (!identity) return dataAccessLost();
	if (grant.kind !== "api-key") return identity;
	const epoch = await sql<{
		epoch: string;
	}>`SELECT epoch::text AS epoch FROM auth_apikey_grant_epoch WHERE key_id=${grant.keyId}`.execute(
		tx,
	);
	return [...identity, epoch.rows[0]?.epoch ?? ""];
}
