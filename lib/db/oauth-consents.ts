/**
 * App-owned reads and revocations against `@better-auth/oauth-provider`'s
 * Firestore tables. Exists because the plugin's own
 * `deleteOAuthConsent` endpoint deletes the consent row but does NOT
 * revoke the (user, client)'s refresh tokens — real revocation needs
 * both atomically. The per-request consent lookup the MCP route uses
 * lives here too, colocated with the revoke that depends on it.
 *
 * Direct `getDb()` reads (rather than typed `collections` helpers)
 * mirror the pattern in `lib/db/admin.ts` for `auth_users` — the
 * plugin owns these schemas, duplicating Zod converters would split
 * the source of truth.
 *
 * Collection names are `oauthConsent`, `oauthClient`,
 * `oauthRefreshToken` — `better-auth-firestore` uses the modelName
 * as-is for plugin tables. Field names are camelCase under
 * `namingStrategy: "default"`.
 */

import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "@google-cloud/firestore";
import { decodeJwt } from "jose";
import { getDb } from "./firestore";

// ── Public types ────────────────────────────────────────────────────

/**
 * Single (user, client) authorization row as the settings UI consumes
 * it. `clientName` falls back to "An application" when the registered
 * client has no name set, matching the `/consent` page.
 */
export interface AuthorizedClient {
	/** `oauthConsent` document id — opaque to the UI; passed back on revoke. */
	consentId: string;
	clientId: string;
	clientName: string;
	/** ISO string from `oauthConsent.createdAt`. */
	authorizedAt: string;
	scopes: string[];
}

// ── Raw doc shapes (Firestore-side) ─────────────────────────────────

/**
 * Subset of the `oauthConsent` doc we actually read. `scopes` is
 * typed `unknown` because Better Auth's adapter framework JSON-
 * stringifies `string[]` fields on write — see `decodeScopes`.
 */
interface OAuthConsentDoc {
	clientId: string;
	userId: string;
	scopes: unknown;
	createdAt: Timestamp | Date;
	updatedAt?: Timestamp | Date;
	referenceId?: string;
}

/**
 * Raw `oauthClient` document fields. Only the two we need for display.
 *
 * Field names here are the *storage* names defined by the plugin's
 * schema (`oauthClient.fields` in `@better-auth/oauth-provider`'s
 * exported schema declaration). They are NOT the RFC 7591 wire names
 * (`client_id` / `client_name`) that the plugin's API endpoints
 * surface — those are translations. Raw Firestore reads see the
 * storage names, so we use them here.
 */
interface OAuthClientDoc {
	clientId: string;
	/** Human-readable client name. Stored as `name`; surfaced as `client_name` over the wire. */
	name?: string;
	/** Public clients are unauthenticated DCR clients (`token_endpoint_auth_method: none`). */
	public?: boolean;
	/** Present only for clients registered by an authenticated user. */
	userId?: string;
	createdAt?: Timestamp | Date;
}

/**
 * Raw `oauthRefreshToken` document — fields touched during revoke.
 * `revoked` is the plugin's own per-token revocation flag (a Date set
 * at revoke time, undefined while live).
 */
interface OAuthRefreshTokenDoc {
	userId: string;
	clientId: string;
	revoked?: Timestamp | Date;
}

/** Per-(user, client) revocation watermark used to invalidate JWT access tokens. */
interface OAuthGrantRevocationDoc {
	userId: string;
	clientId: string;
	revokedAt?: Timestamp | Date;
}

// ── Collection names ────────────────────────────────────────────────

const COLLECTION_CONSENT = "oauthConsent";
const COLLECTION_CLIENT = "oauthClient";
const COLLECTION_REFRESH_TOKEN = "oauthRefreshToken";
const COLLECTION_GRANT_REVOCATION = "oauthGrantRevocation";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Helpers ─────────────────────────────────────────────────────────

/** Firestore returns `Timestamp` on read, accepts `Date` on write. */
function toISOString(val: Timestamp | Date): string {
	if (val instanceof Timestamp) return val.toDate().toISOString();
	return val.toISOString();
}

/** Firestore timestamp-ish value to epoch millis. Invalid/missing means fail closed. */
function toMillis(val: Timestamp | Date | undefined): number | null {
	if (!val) return null;
	const date = val instanceof Timestamp ? val.toDate() : val;
	const ms = date.getTime();
	return Number.isFinite(ms) ? ms : null;
}

/** Deterministic doc id without exposing raw user/client ids in the path. */
function grantRevocationDocId(userId: string, clientId: string): string {
	const digest = createHash("sha256")
		.update(userId)
		.update("\0")
		.update(clientId)
		.digest("base64url");
	return `grant-rev-${digest}`;
}

function hashStoredOAuthToken(token: string): string {
	return createHash("sha256").update(token).digest("base64url");
}

/**
 * Decode a Firestore-stored `scopes` field back to `string[]`.
 *
 * Better Auth's adapter framework JSON-stringifies `string[]` fields
 * on write when the underlying adapter doesn't declare
 * `supportsArrays: true` — `better-auth-firestore` doesn't, so what
 * lands on disk is `'["nova.read",...]'` rather than a Firestore array.
 * The plugin's own reads invert this via the adapter; we read direct,
 * so we invert it here. Falls through to `[]` for any other shape,
 * which keeps a future schema change from crashing the UI.
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
 * `oauthConsent` rows for the user, then joins on `oauthClient` for
 * display names. The `in`-query Firestore caps at 30 values, which is
 * effectively unreachable per user.
 */
export async function listAuthorizedClients(
	userId: string,
): Promise<AuthorizedClient[]> {
	const consentsSnap = await getDb()
		.collection(COLLECTION_CONSENT)
		.where("userId", "==", userId)
		.get();

	if (consentsSnap.empty) return [];

	const consents = consentsSnap.docs.map((doc) => ({
		id: doc.id,
		data: doc.data() as OAuthConsentDoc,
	}));

	/* A user can have multiple consent rows for the same client when
	 * `referenceId` differs (the plugin keys consent uniqueness on
	 * `(userId, clientId, referenceId)`). Dedupe before the `in`-query. */
	const distinctClientIds = Array.from(
		new Set(consents.map((c) => c.data.clientId)),
	);

	const clientsByIdEntries = await fetchClientNames(distinctClientIds);
	const clientsById = new Map(clientsByIdEntries);

	const rows: AuthorizedClient[] = consents.map((c) => ({
		consentId: c.id,
		clientId: c.data.clientId,
		clientName: clientsById.get(c.data.clientId) ?? "An application",
		authorizedAt: toISOString(c.data.createdAt),
		scopes: decodeScopes(c.data.scopes),
	}));

	rows.sort((a, b) => b.authorizedAt.localeCompare(a.authorizedAt));
	return rows;
}

/**
 * Revoke a (user, client) authorization atomically: delete the consent
 * row + mark every refresh token for that pair revoked. Both are
 * needed — the consent check (`hasActiveConsent`) stops in-flight
 * JWTs immediately, the refresh-token revoke prevents a stolen
 * refresh token minting a fresh JWT.
 *
 * Idempotent on already-revoked consent. Throws on userId mismatch —
 * defense in depth against arbitrary `consentId` strings reaching this
 * function from a Server Action.
 */
export async function revokeAuthorizedClient(
	userId: string,
	consentId: string,
): Promise<void> {
	const db = getDb();
	const consentRef = db.collection(COLLECTION_CONSENT).doc(consentId);

	await db.runTransaction(async (tx) => {
		const consentSnap = await tx.get(consentRef);
		if (!consentSnap.exists) return; // idempotent — already revoked

		const consent = consentSnap.data() as OAuthConsentDoc;
		if (consent.userId !== userId) {
			throw new Error("Consent does not belong to this user");
		}

		/* Delete every consent row for the same pair. The plugin's
		 * find-then-create flow plus Firestore's lack of uniqueness can
		 * produce duplicates; leaving any one row behind would keep the
		 * MCP route's active-grant check alive. */
		const consentsSnap = await tx.get(
			db
				.collection(COLLECTION_CONSENT)
				.where("userId", "==", userId)
				.where("clientId", "==", consent.clientId),
		);

		/* Read tokens inside the txn so the bulk update commits atomically
		 * with consent deletion and the JWT revocation watermark. */
		const tokensSnap = await tx.get(
			db
				.collection(COLLECTION_REFRESH_TOKEN)
				.where("userId", "==", userId)
				.where("clientId", "==", consent.clientId),
		);

		for (const consentDoc of consentsSnap.docs) {
			tx.delete(consentDoc.ref);
		}

		/* `serverTimestamp()` resolves on commit so every revoked
		 * token and the watermark get the same server-side timestamp. */
		const revokedAt = FieldValue.serverTimestamp();
		for (const tokenDoc of tokensSnap.docs) {
			const data = tokenDoc.data() as OAuthRefreshTokenDoc;
			if (data.revoked) continue;
			tx.update(tokenDoc.ref, { revoked: revokedAt });
		}

		tx.set(
			db
				.collection(COLLECTION_GRANT_REVOCATION)
				.doc(grantRevocationDocId(userId, consent.clientId)),
			{
				userId,
				clientId: consent.clientId,
				revokedAt,
				updatedAt: revokedAt,
			},
			{ merge: true },
		);
	});
}

/** Write the per-(user, client) JWT revocation watermark outside a transaction. */
export async function recordOAuthGrantRevocation(
	userId: string,
	clientId: string,
): Promise<void> {
	const revokedAt = FieldValue.serverTimestamp();
	await getDb()
		.collection(COLLECTION_GRANT_REVOCATION)
		.doc(grantRevocationDocId(userId, clientId))
		.set(
			{
				userId,
				clientId,
				revokedAt,
				updatedAt: revokedAt,
			},
			{ merge: true },
		);
}

/**
 * Mirror a successful `/oauth2/revoke` call into Nova's instant JWT
 * revocation lock. JWT access tokens carry `sub` + `azp`; refresh tokens
 * are looked up by Better Auth's default hashed storage value.
 */
export async function recordOAuthGrantRevocationForToken(
	token: string,
): Promise<boolean> {
	try {
		const jwt = decodeJwt(token);
		const userId = typeof jwt.sub === "string" ? jwt.sub : undefined;
		const clientId = typeof jwt.azp === "string" ? jwt.azp : undefined;
		if (userId && clientId) {
			await recordOAuthGrantRevocation(userId, clientId);
			return true;
		}
	} catch {
		/* Not a JWT access token; fall through to refresh-token lookup. */
	}

	const snap = await getDb()
		.collection(COLLECTION_REFRESH_TOKEN)
		.where("token", "==", hashStoredOAuthToken(token))
		.limit(1)
		.get();
	if (snap.empty) return false;

	const refresh = snap.docs[0]?.data() as OAuthRefreshTokenDoc | undefined;
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
	const snap = await getDb()
		.collection(COLLECTION_CONSENT)
		.where("userId", "==", userId)
		.where("clientId", "==", clientId)
		.limit(1)
		.get();
	if (snap.empty) return false;

	if (tokenIssuedAt === undefined) return true;

	const issuedAtMs = Number.isFinite(tokenIssuedAt)
		? tokenIssuedAt * 1000
		: null;
	if (issuedAtMs === null) return false;

	const revocationSnap = await getDb()
		.collection(COLLECTION_GRANT_REVOCATION)
		.where("userId", "==", userId)
		.where("clientId", "==", clientId)
		.limit(1)
		.get();
	if (revocationSnap.empty) return true;

	const revocation = revocationSnap.docs[0]?.data() as
		| OAuthGrantRevocationDoc
		| undefined;
	const revokedAtMs = toMillis(revocation?.revokedAt);
	if (revokedAtMs === null) return false;
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
	const cutoff = new Date(now.getTime() - olderThanDays * MS_PER_DAY);
	const snap = await getDb()
		.collection(COLLECTION_CLIENT)
		.where("createdAt", "<", cutoff)
		.limit(limit)
		.get();

	let deleted = 0;
	for (const doc of snap.docs) {
		const client = doc.data() as OAuthClientDoc;
		if (!client.public || client.userId || !client.clientId) continue;

		const [consents, refreshTokens] = await Promise.all([
			getDb()
				.collection(COLLECTION_CONSENT)
				.where("clientId", "==", client.clientId)
				.limit(1)
				.get(),
			getDb()
				.collection(COLLECTION_REFRESH_TOKEN)
				.where("clientId", "==", client.clientId)
				.limit(1)
				.get(),
		]);
		if (!consents.empty || !refreshTokens.empty) continue;

		await doc.ref.delete();
		deleted += 1;
	}
	return deleted;
}

// ── Internals ───────────────────────────────────────────────────────

/**
 * Fetch display names for a deduped list of client ids. Returns
 * `[clientId, name]` entries; clients with no `name` are skipped and
 * the caller applies the "An application" fallback. Caller must
 * dedupe — Firestore caps `in` queries at 30 values.
 */
async function fetchClientNames(
	clientIds: string[],
): Promise<Array<[string, string]>> {
	if (clientIds.length === 0) return [];

	const snap = await getDb()
		.collection(COLLECTION_CLIENT)
		.where("clientId", "in", clientIds)
		.get();

	const entries: Array<[string, string]> = [];
	for (const doc of snap.docs) {
		const data = doc.data() as OAuthClientDoc;
		if (data.name) {
			entries.push([data.clientId, data.name]);
		}
	}
	return entries;
}
