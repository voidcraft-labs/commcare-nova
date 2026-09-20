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
import { deriveClientIdentityHost } from "@/lib/oauth/client-display";
import { getAuthDb } from "../auth/db";

/**
 * JWKS for verifying OAuth-minted access tokens. `createRemoteJWKSet`
 * fetches lazily on first verify and caches keys in-process, so module
 * scope is the right place to construct it — the URL is the same
 * across every revoke call.
 *
 * Same JWKS the MCP route's protected-request handler wires up. The MCP route
 * trusts Better Auth's verify helper to enforce iss + aud + signature; the
 * revocation watermark path verifies independently because its trust
 * model can't piggyback on that request handler here.
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
	/** The host the client is identified by when it came from a Client ID
	 * Metadata Document, in the same ASCII form the consent page showed.
	 * `null` for a registered client, whose name is all Nova knows. */
	identityHost: string | null;
	/** ISO string from `auth_oauth_consent.createdAt`. */
	authorizedAt: string;
	scopes: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────

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
 * `auth_oauth_client` for display names and identifying hosts.
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

	const clientsById = await fetchClientDisplays(distinctClientIds);

	const rows: AuthorizedClient[] = consents.map((c) => ({
		consentId: c.id,
		clientId: c.clientId,
		clientName: clientsById.get(c.clientId)?.name ?? "An application",
		identityHost: clientsById.get(c.clientId)?.identityHost ?? null,
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
 * How Nova came to know a client: the row's `clientDiscoveryId` (`"cimd"` for
 * a Client ID Metadata Document client), or `null` for a registered client
 * and for an id with no row. The consent page reads it so the identifying
 * host is shown on the database's word, never on the shape of the id.
 */
export async function getOAuthClientDiscovery(
	clientId: string,
): Promise<string | null> {
	const db = await getAuthDb();
	const row = await db
		.selectFrom("auth_oauth_client")
		.select("clientDiscoveryId")
		.where("clientId", "=", clientId)
		.executeTakeFirst();
	return row?.clientDiscoveryId ?? null;
}

// ── Internals ───────────────────────────────────────────────────────

/**
 * Fetch what the settings list shows about each client in a deduped list of
 * ids, in one query: its name (`null` when unset; the caller applies the
 * "An application" fallback) and the host that identifies it when it came
 * from a Client ID Metadata Document. Caller dedupes the ids.
 */
async function fetchClientDisplays(
	clientIds: string[],
): Promise<Map<string, { name: string | null; identityHost: string | null }>> {
	const displays = new Map<
		string,
		{ name: string | null; identityHost: string | null }
	>();
	if (clientIds.length === 0) return displays;

	const db = await getAuthDb();
	const clients = await db
		.selectFrom("auth_oauth_client")
		.select(["clientId", "name", "clientDiscoveryId"])
		.where("clientId", "in", clientIds)
		.execute();

	for (const c of clients) {
		displays.set(c.clientId, {
			name: c.name || null,
			identityHost: deriveClientIdentityHost(c.clientId, c.clientDiscoveryId),
		});
	}
	return displays;
}
