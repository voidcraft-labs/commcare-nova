/**
 * App-owned reads and revocations against `@better-auth/oauth-provider`'s
 * tables. Exists because the plugin's own `deleteOAuthConsent` endpoint
 * deletes the consent row but does NOT revoke the (user, client)'s refresh
 * tokens — real revocation needs both atomically. The per-request consent
 * lookup the MCP route uses lives here too, colocated with the revoke that
 * depends on it.
 *
 * Reads/writes run on the shared `Kysely<AuthDatabase>` (`getAuthDb`) rather
 * than through the plugin's typed surface — the plugin owns these schemas and
 * duplicating its CRUD would split the source of truth. Table names are
 * `auth_oauth_{consent,client,refresh_token}` (the plugin's models,
 * `auth_`-prefixed via `modelName` in `lib/auth.ts`) plus the Nova-owned
 * `auth_oauth_grant_revocation`. Column names are the plugin's storage names
 * (camelCase), NOT the RFC 7591 wire names (`client_id` / `client_name`).
 */

import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { AS_ISSUER, AS_ORIGIN, MCP_RESOURCE_URL } from "@/lib/hostnames";
import { getAuthDb } from "../auth/db";

/**
 * JWKS for verifying OAuth-minted access tokens. `createRemoteJWKSet`
 * fetches lazily on first verify and caches keys in-process, so module
 * scope is the right place to construct it — the URL is the same
 * across every revoke call.
 *
 * Same JWKS the MCP route's `mcpHandler` wires up. The MCP route trusts
 * Better Auth's verify helper to enforce iss + aud + signature; the
 * revocation watermark path verifies independently because its trust
 * model can't piggyback on the helper (no `mcpHandler` here).
 */
const AS_JWKS = createRemoteJWKSet(new URL(`${AS_ORIGIN}/api/auth/jwks`));

// ── Public types ────────────────────────────────────────────────────

/**
 * Single (user, client) authorization row as the settings UI consumes
 * it. `clientName` falls back to "An application" when the registered
 * client has no name set, matching the `/consent` page.
 */
export interface AuthorizedClient {
	/** `auth_oauth_consent` row id — opaque to the UI; passed back on revoke. */
	consentId: string;
	clientId: string;
	clientName: string;
	/** ISO string from `auth_oauth_consent.createdAt`. */
	authorizedAt: string;
	scopes: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The Kysely adapter returns `timestamptz` columns as `Date`. */
function toISOString(val: Date): string {
	return val.toISOString();
}

/** Date to epoch millis. Invalid/missing means fail closed. */
function toMillis(val: Date | null | undefined): number | null {
	if (!val) return null;
	const ms = val.getTime();
	return Number.isFinite(ms) ? ms : null;
}

function hashStoredOAuthToken(token: string): string {
	return createHash("sha256").update(token).digest("base64url");
}

/**
 * Normalize a stored `scopes` value to `string[]`.
 *
 * Postgres stores `scopes` as `jsonb`, so Kysely returns it already
 * decoded as an array — unlike the api-key `permissions` column, which is
 * a JSON string. This helper is defensive: it filters non-string entries
 * and also tolerates a JSON-string shape, falling through to `[]` so a
 * stray shape never crashes the settings UI.
 */
function decodeScopes(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw.filter((s): s is string => typeof s === "string");
	}
	if (typeof raw === "string") {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				return parsed.filter((s): s is string => typeof s === "string");
			}
		} catch {
			/* fall through to []; raw was a non-JSON string */
		}
	}
	return [];
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * List the user's authorized OAuth clients, newest first. Reads
 * `auth_oauth_consent` rows for the user, then joins on
 * `auth_oauth_client` for display names.
 */
export async function listAuthorizedClients(
	userId: string,
): Promise<AuthorizedClient[]> {
	const db = await getAuthDb();
	const consents = await db
		.selectFrom("auth_oauth_consent")
		.select(["id", "clientId", "scopes", "createdAt"])
		.where("userId", "=", userId)
		.execute();

	if (consents.length === 0) return [];

	/* A user can have multiple consent rows for the same client when the
	 * plugin's find-then-create flow produces duplicates. Dedupe before the
	 * `in`-query that fetches display names. */
	const distinctClientIds = Array.from(
		new Set(consents.map((c) => c.clientId)),
	);

	const clientsById = new Map(await fetchClientNames(distinctClientIds));

	const rows: AuthorizedClient[] = consents.map((c) => ({
		consentId: c.id,
		clientId: c.clientId,
		clientName: clientsById.get(c.clientId) ?? "An application",
		authorizedAt: toISOString(c.createdAt),
		scopes: decodeScopes(c.scopes),
	}));

	rows.sort((a, b) => b.authorizedAt.localeCompare(a.authorizedAt));
	return rows;
}

/**
 * Revoke a (user, client) authorization atomically: delete the consent
 * row(s) + mark every refresh token for that pair revoked + bump the JWT
 * revocation watermark. All three are needed — the consent check
 * (`hasActiveConsent`) stops in-flight JWTs immediately, the refresh-token
 * revoke prevents a stolen refresh token minting a fresh JWT, and the
 * watermark invalidates already-minted JWTs by issue time.
 *
 * Idempotent on already-revoked consent. Throws on userId mismatch —
 * defense in depth against arbitrary `consentId` strings reaching this
 * function from a Server Action.
 */
export async function revokeAuthorizedClient(
	userId: string,
	consentId: string,
): Promise<void> {
	const db = await getAuthDb();

	await db.transaction().execute(async (trx) => {
		const consent = await trx
			.selectFrom("auth_oauth_consent")
			.select(["clientId", "userId"])
			.where("id", "=", consentId)
			.executeTakeFirst();
		if (!consent) return; // idempotent — already revoked
		if (consent.userId !== userId) {
			throw new Error("Consent does not belong to this user");
		}
		const { clientId } = consent;
		/* One app-server timestamp for the whole transaction, so the
		 * revoked tokens and the watermark share an instant. */
		const revokedAt = new Date();

		/* Delete every consent row for the same pair — leaving any one behind
		 * would keep the MCP route's active-grant check alive. */
		await trx
			.deleteFrom("auth_oauth_consent")
			.where("userId", "=", userId)
			.where("clientId", "=", clientId)
			.execute();

		/* Revoke every not-yet-revoked refresh token for the pair. */
		await trx
			.updateTable("auth_oauth_refresh_token")
			.set({ revoked: revokedAt })
			.where("userId", "=", userId)
			.where("clientId", "=", clientId)
			.where("revoked", "is", null)
			.execute();

		/* Upsert the JWT revocation watermark, keyed on (userId, clientId). */
		await trx
			.insertInto("auth_oauth_grant_revocation")
			.values({ userId, clientId, revokedAt })
			.onConflict((oc) =>
				oc.columns(["userId", "clientId"]).doUpdateSet({ revokedAt }),
			)
			.execute();
	});
}

/** Write the per-(user, client) JWT revocation watermark outside a transaction. */
export async function recordOAuthGrantRevocation(
	userId: string,
	clientId: string,
): Promise<void> {
	const db = await getAuthDb();
	const revokedAt = new Date();
	await db
		.insertInto("auth_oauth_grant_revocation")
		.values({ userId, clientId, revokedAt })
		.onConflict((oc) =>
			oc.columns(["userId", "clientId"]).doUpdateSet({ revokedAt }),
		)
		.execute();
}

/**
 * Mirror a successful `/oauth2/revoke` call into Nova's instant JWT
 * revocation lock.
 *
 * JWT access tokens carry `sub` + `azp` and are verified against the
 * AS's JWKS before their claims are trusted. Without that verification
 * the function would write a revocation watermark for any (`sub`,
 * `azp`) the caller chose to forge — and Better Auth's `/oauth2/revoke`
 * returns 200 even for invalid tokens (RFC 7009 §2.2), so the wrapper's
 * `response.ok` gate can't filter forgeries on its own. Verification
 * here closes that channel.
 *
 * Refresh tokens are opaque strings (not JWTs); they fall through to a
 * hashed-storage lookup against `auth_oauth_refresh_token`, which is safe
 * by construction — only tokens the AS itself minted can hit a row.
 */
export async function recordOAuthGrantRevocationForToken(
	token: string,
): Promise<boolean> {
	try {
		const { payload } = await jwtVerify(token, AS_JWKS, {
			issuer: AS_ISSUER,
			audience: MCP_RESOURCE_URL,
		});
		const userId = typeof payload.sub === "string" ? payload.sub : undefined;
		const clientId = typeof payload.azp === "string" ? payload.azp : undefined;
		if (userId && clientId) {
			await recordOAuthGrantRevocation(userId, clientId);
			return true;
		}
	} catch {
		/* Not a verifiable JWT (forged, expired, wrong audience, or just
		 * an opaque refresh token) — fall through to the refresh-token
		 * hash lookup, which is safe against forgery because only tokens
		 * the AS minted appear in the table. */
	}

	const db = await getAuthDb();
	const refresh = await db
		.selectFrom("auth_oauth_refresh_token")
		.select(["userId", "clientId"])
		.where("token", "=", hashStoredOAuthToken(token))
		.limit(1)
		.executeTakeFirst();
	if (!refresh?.userId || !refresh.clientId) return false;
	await recordOAuthGrantRevocation(refresh.userId, refresh.clientId);
	return true;
}

/**
 * Predicate the MCP route uses to enforce instant revocation. Pure
 * existence test — scope enforcement happens at the JWT-verify layer
 * against the token's own `scope` claim, not the persisted consent.
 */
export async function hasActiveConsent(
	userId: string,
	clientId: string,
	tokenIssuedAt?: number,
): Promise<boolean> {
	const db = await getAuthDb();
	// One round-trip on the per-request MCP path: the consent existence test
	// LEFT JOINed to the (user, client) revocation watermark. `revokedAt` is null
	// when no consent matches (row absent) OR no watermark exists.
	const row = await db
		.selectFrom("auth_oauth_consent as c")
		.leftJoin("auth_oauth_grant_revocation as r", (join) =>
			join.on("r.userId", "=", userId).on("r.clientId", "=", clientId),
		)
		.select(["c.id as consentId", "r.revokedAt as revokedAt"])
		.where("c.userId", "=", userId)
		.where("c.clientId", "=", clientId)
		.limit(1)
		.executeTakeFirst();
	if (!row) return false;

	if (tokenIssuedAt === undefined) return true;

	const issuedAtMs = Number.isFinite(tokenIssuedAt)
		? tokenIssuedAt * 1000
		: null;
	if (issuedAtMs === null) return false;

	if (row.revokedAt == null) return true;
	const revokedAtMs = toMillis(row.revokedAt);
	if (revokedAtMs === null) return false;
	/* Fail-closed at the JWT `iat`'s second granularity: `issuedAtMs` is floored
	 * to a whole second, so a token issued in the SAME wall-clock second as a
	 * revocation is treated as revoked (a brief, self-healing denial). The
	 * inequality never fails OPEN — a token from a later second always reads as
	 * active. */
	return revokedAtMs < issuedAtMs;
}

/**
 * Opportunistic cleanup for unauthenticated public DCR clients. Public
 * clients never receive a client secret, so `client_secret_expires_at`
 * cannot bound storage growth; stale clients with no consents or refresh
 * tokens are safe to delete.
 */
export async function cleanupStalePublicOAuthClients({
	now = new Date(),
	olderThanDays = 30,
	limit = 50,
}: {
	now?: Date;
	olderThanDays?: number;
	limit?: number;
} = {}): Promise<number> {
	const db = await getAuthDb();
	const cutoff = new Date(now.getTime() - olderThanDays * MS_PER_DAY);
	const clients = await db
		.selectFrom("auth_oauth_client")
		.select(["id", "clientId", "public", "userId"])
		.where("createdAt", "<", cutoff)
		.limit(limit)
		.execute();

	let deleted = 0;
	for (const client of clients) {
		if (!client.public || client.userId || !client.clientId) continue;

		const [consent, refreshToken] = await Promise.all([
			db
				.selectFrom("auth_oauth_consent")
				.select("id")
				.where("clientId", "=", client.clientId)
				.limit(1)
				.executeTakeFirst(),
			db
				.selectFrom("auth_oauth_refresh_token")
				.select("id")
				.where("clientId", "=", client.clientId)
				.limit(1)
				.executeTakeFirst(),
		]);
		if (consent || refreshToken) continue;

		await db
			.deleteFrom("auth_oauth_client")
			.where("id", "=", client.id)
			.execute();
		deleted += 1;
	}
	return deleted;
}

// ── Internals ───────────────────────────────────────────────────────

/**
 * Fetch display names for a deduped list of client ids. Returns
 * `[clientId, name]` entries; clients with no `name` are skipped and the
 * caller applies the "An application" fallback. Caller dedupes the ids.
 */
async function fetchClientNames(
	clientIds: string[],
): Promise<Array<[string, string]>> {
	if (clientIds.length === 0) return [];

	const db = await getAuthDb();
	const clients = await db
		.selectFrom("auth_oauth_client")
		.select(["clientId", "name"])
		.where("clientId", "in", clientIds)
		.execute();

	const entries: Array<[string, string]> = [];
	for (const c of clients) {
		if (c.name) entries.push([c.clientId, c.name]);
	}
	return entries;
}
