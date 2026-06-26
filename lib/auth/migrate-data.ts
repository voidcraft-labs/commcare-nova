// One-shot copy of the durable auth state from Firestore → Postgres, run
// automatically by the migrate Job AFTER the auth tables are created, BEFORE
// traffic shifts to the Postgres-backed auth. Idempotent + guarded: it runs
// only when `auth_user` is empty (the first deploy after the tables land), so a
// re-deploy never re-copies over live Postgres writes. The whole copy is ONE
// Kysely transaction — if any row fails it rolls back, `auth_user` stays empty,
// the Job exits non-zero, and the next deploy retries the whole copy cleanly (no
// partial migration can latch).
//
// Faithful, ID-preserving transfer — `apps.owner` and every case-store
// `owner_id` key on the Better Auth user id, so the ids MUST survive verbatim.
// Encrypted account-token ciphertext and api-key hashes copy verbatim too
// (BETTER_AUTH_SECRET is unchanged), so existing OAuth accounts + API keys keep
// working. Firestore is NOT touched — it stays as a backup until a later manual
// cleanup, so a bad copy is always recoverable (empty `auth_user`, redeploy).
//
// Source Firestore collections: the `auth_*` trio is prefixed, the plugin tables
// use Better Auth's core default model names; targets are the `auth_`-prefixed
// Postgres tables. Ephemeral collections are SKIPPED — sessions, verification,
// rate-limit — so users sign in once more, in-flight OAuth flows restart, and
// counters reset.
//
// Reads/writes use the typed Kysely builder (`CopyTables`) — no SQL literals.
// The destination columns mirror Better Auth's generated schema; columns are
// typed permissively (nullable) because the COPY's correctness guarantee is the
// destination tables' own NOT NULL constraints (a violation rolls the whole
// transaction back). Conversions: a Firestore `Timestamp` → JS `Date` (→
// timestamptz); a jsonb column takes the value as JSON text (the Firestore
// adapter stores arrays as JSON strings) which Postgres casts to jsonb; `text`
// columns (e.g. api-key `permissions`) copy the string verbatim; everything else
// copies its scalar.

import { Firestore, Timestamp } from "@google-cloud/firestore";
import {
	type Insertable,
	Kysely,
	PostgresDialect,
	type PostgresPool,
} from "kysely";
import type { Pool } from "pg";
import { firestoreClientOptions } from "@/lib/db/firestoreClientOptions";

/** Insert-shaped column types for the auth tables this copy writes. */
interface CopyTables {
	auth_user: {
		id: string;
		name: string | null;
		email: string | null;
		emailVerified: boolean | null;
		image: string | null;
		role: string | null;
		banned: boolean | null;
		banReason: string | null;
		banExpires: Date | null;
		lastActiveAt: Date | null;
		createdAt: Date | null;
		updatedAt: Date | null;
	};
	auth_oauth_client: {
		id: string;
		clientId: string | null;
		clientSecret: string | null;
		disabled: boolean | null;
		skipConsent: boolean | null;
		enableEndSession: boolean | null;
		subjectType: string | null;
		scopes: string | null;
		userId: string | null;
		createdAt: Date | null;
		updatedAt: Date | null;
		name: string | null;
		uri: string | null;
		icon: string | null;
		contacts: string | null;
		tos: string | null;
		policy: string | null;
		softwareId: string | null;
		softwareVersion: string | null;
		softwareStatement: string | null;
		redirectUris: string | null;
		postLogoutRedirectUris: string | null;
		tokenEndpointAuthMethod: string | null;
		grantTypes: string | null;
		responseTypes: string | null;
		public: boolean | null;
		type: string | null;
		requirePKCE: boolean | null;
		referenceId: string | null;
		metadata: string | null;
	};
	auth_account: {
		id: string;
		accountId: string | null;
		providerId: string | null;
		userId: string | null;
		accessToken: string | null;
		refreshToken: string | null;
		idToken: string | null;
		accessTokenExpiresAt: Date | null;
		refreshTokenExpiresAt: Date | null;
		scope: string | null;
		password: string | null;
		createdAt: Date | null;
		updatedAt: Date | null;
	};
	auth_apikey: {
		id: string;
		configId: string | null;
		name: string | null;
		start: string | null;
		referenceId: string | null;
		prefix: string | null;
		key: string | null;
		refillInterval: number | null;
		refillAmount: number | null;
		lastRefillAt: Date | null;
		enabled: boolean | null;
		rateLimitEnabled: boolean | null;
		rateLimitTimeWindow: number | null;
		rateLimitMax: number | null;
		requestCount: number | null;
		remaining: number | null;
		lastRequest: Date | null;
		expiresAt: Date | null;
		createdAt: Date | null;
		updatedAt: Date | null;
		permissions: string | null;
		metadata: string | null;
	};
	auth_oauth_consent: {
		id: string;
		clientId: string | null;
		userId: string | null;
		referenceId: string | null;
		scopes: string | null;
		createdAt: Date | null;
		updatedAt: Date | null;
	};
	auth_oauth_refresh_token: {
		id: string;
		token: string | null;
		clientId: string | null;
		sessionId: string | null;
		userId: string | null;
		referenceId: string | null;
		expiresAt: Date | null;
		createdAt: Date | null;
		revoked: Date | null;
		authTime: Date | null;
		scopes: string | null;
	};
	auth_oauth_grant_revocation: {
		userId: string | null;
		clientId: string | null;
		revokedAt: Date | null;
	};
	auth_jwks: {
		id: string;
		publicKey: string | null;
		privateKey: string | null;
		createdAt: Date | null;
		expiresAt: Date | null;
	};
}

type Doc = FirebaseFirestore.DocumentData;

/** Firestore `Timestamp`/`Date` → `Date`; anything else → null. */
const dateOf = (v: unknown): Date | null =>
	v instanceof Timestamp ? v.toDate() : v instanceof Date ? v : null;
/** jsonb value as JSON text (the Firestore adapter stored arrays as strings). */
const jsonText = (v: unknown): string | null =>
	v === null || v === undefined
		? null
		: typeof v === "string"
			? v
			: JSON.stringify(v);
const strOf = (v: unknown): string | null => (typeof v === "string" ? v : null);
const boolOf = (v: unknown): boolean | null =>
	typeof v === "boolean" ? v : null;
const numOf = (v: unknown): number | null => (typeof v === "number" ? v : null);

/**
 * Read a Firestore collection and bulk-insert it into `table` via the typed
 * builder, conflict-skipping on `conflict`. Returns a per-table count.
 */
async function copyCollection<TB extends keyof CopyTables>(
	fs: Firestore,
	trx: Kysely<CopyTables>,
	collection: string,
	table: TB,
	conflict: ReadonlyArray<keyof CopyTables[TB] & string>,
	map: (id: string, data: Doc) => Insertable<CopyTables[TB]>,
): Promise<{ table: string; read: number; inserted: number }> {
	const snap = await fs.collection(collection).get();
	if (snap.empty) return { table: String(table), read: 0, inserted: 0 };

	const rows = snap.docs.map((doc) => map(doc.id, doc.data()));
	await trx
		.insertInto(table)
		.values(rows)
		.onConflict((oc) => oc.columns([...conflict]).doNothing())
		.execute();

	return { table: String(table), read: snap.size, inserted: rows.length };
}

export interface AuthDataCopyResult {
	skipped: boolean;
	perTable: Array<{ table: string; read: number; inserted: number }>;
}

/**
 * Copy durable auth state Firestore → Postgres in one transaction, guarded on
 * an empty `auth_user`. Returns a per-table summary (or `{skipped:true}` when
 * `auth_user` already has rows). Throws on any failure (the transaction rolls
 * back first). Never ends the shared pool — that is owned by the connection
 * layer.
 */
export async function copyAuthDataFromFirestore(
	pool: Pool,
): Promise<AuthDataCopyResult> {
	const db = new Kysely<CopyTables>({
		dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
	});

	const guard = await db
		.selectFrom("auth_user")
		.select((eb) => eb.fn.countAll<string>().as("count"))
		.executeTakeFirst();
	if (Number(guard?.count ?? "0") > 0) {
		return { skipped: true, perTable: [] };
	}

	const fs = new Firestore(firestoreClientOptions());
	try {
		// Ordered so foreign keys resolve: users first; the client before the
		// consent/refresh rows that reference it; the user-referencing tables
		// after users.
		const perTable = await db.transaction().execute(async (trx) => {
			const out: AuthDataCopyResult["perTable"] = [];

			out.push(
				await copyCollection(
					fs,
					trx,
					"auth_users",
					"auth_user",
					["id"],
					(id, d) => ({
						id,
						name: strOf(d.name),
						email: strOf(d.email),
						emailVerified: boolOf(d.emailVerified),
						image: strOf(d.image),
						role: strOf(d.role),
						banned: boolOf(d.banned),
						banReason: strOf(d.banReason),
						banExpires: dateOf(d.banExpires),
						lastActiveAt: dateOf(d.lastActiveAt),
						createdAt: dateOf(d.createdAt),
						updatedAt: dateOf(d.updatedAt),
					}),
				),
			);

			out.push(
				await copyCollection(
					fs,
					trx,
					"oauthClient",
					"auth_oauth_client",
					["id"],
					(id, d) => ({
						id,
						clientId: strOf(d.clientId),
						clientSecret: strOf(d.clientSecret),
						disabled: boolOf(d.disabled),
						skipConsent: boolOf(d.skipConsent),
						enableEndSession: boolOf(d.enableEndSession),
						subjectType: strOf(d.subjectType),
						scopes: jsonText(d.scopes),
						userId: strOf(d.userId),
						createdAt: dateOf(d.createdAt),
						updatedAt: dateOf(d.updatedAt),
						name: strOf(d.name),
						uri: strOf(d.uri),
						icon: strOf(d.icon),
						contacts: jsonText(d.contacts),
						tos: strOf(d.tos),
						policy: strOf(d.policy),
						softwareId: strOf(d.softwareId),
						softwareVersion: strOf(d.softwareVersion),
						softwareStatement: strOf(d.softwareStatement),
						redirectUris: jsonText(d.redirectUris),
						postLogoutRedirectUris: jsonText(d.postLogoutRedirectUris),
						tokenEndpointAuthMethod: strOf(d.tokenEndpointAuthMethod),
						grantTypes: jsonText(d.grantTypes),
						responseTypes: jsonText(d.responseTypes),
						public: boolOf(d.public),
						type: strOf(d.type),
						requirePKCE: boolOf(d.requirePKCE),
						referenceId: strOf(d.referenceId),
						metadata: jsonText(d.metadata),
					}),
				),
			);

			out.push(
				await copyCollection(
					fs,
					trx,
					"auth_accounts",
					"auth_account",
					["id"],
					(id, d) => ({
						id,
						accountId: strOf(d.accountId),
						providerId: strOf(d.providerId),
						userId: strOf(d.userId),
						accessToken: strOf(d.accessToken),
						refreshToken: strOf(d.refreshToken),
						idToken: strOf(d.idToken),
						accessTokenExpiresAt: dateOf(d.accessTokenExpiresAt),
						refreshTokenExpiresAt: dateOf(d.refreshTokenExpiresAt),
						scope: strOf(d.scope),
						password: strOf(d.password),
						createdAt: dateOf(d.createdAt),
						updatedAt: dateOf(d.updatedAt),
					}),
				),
			);

			out.push(
				await copyCollection(
					fs,
					trx,
					"apikey",
					"auth_apikey",
					["id"],
					(id, d) => ({
						id,
						configId: strOf(d.configId),
						name: strOf(d.name),
						start: strOf(d.start),
						referenceId: strOf(d.referenceId),
						prefix: strOf(d.prefix),
						key: strOf(d.key),
						refillInterval: numOf(d.refillInterval),
						refillAmount: numOf(d.refillAmount),
						lastRefillAt: dateOf(d.lastRefillAt),
						enabled: boolOf(d.enabled),
						rateLimitEnabled: boolOf(d.rateLimitEnabled),
						rateLimitTimeWindow: numOf(d.rateLimitTimeWindow),
						rateLimitMax: numOf(d.rateLimitMax),
						requestCount: numOf(d.requestCount),
						remaining: numOf(d.remaining),
						lastRequest: dateOf(d.lastRequest),
						expiresAt: dateOf(d.expiresAt),
						createdAt: dateOf(d.createdAt),
						updatedAt: dateOf(d.updatedAt),
						permissions: strOf(d.permissions),
						metadata: strOf(d.metadata),
					}),
				),
			);

			out.push(
				await copyCollection(
					fs,
					trx,
					"oauthConsent",
					"auth_oauth_consent",
					["id"],
					(id, d) => ({
						id,
						clientId: strOf(d.clientId),
						userId: strOf(d.userId),
						referenceId: strOf(d.referenceId),
						scopes: jsonText(d.scopes),
						createdAt: dateOf(d.createdAt),
						updatedAt: dateOf(d.updatedAt),
					}),
				),
			);

			out.push(
				await copyCollection(
					fs,
					trx,
					"oauthRefreshToken",
					"auth_oauth_refresh_token",
					["id"],
					(id, d) => ({
						id,
						token: strOf(d.token),
						clientId: strOf(d.clientId),
						sessionId: strOf(d.sessionId),
						userId: strOf(d.userId),
						referenceId: strOf(d.referenceId),
						expiresAt: dateOf(d.expiresAt),
						createdAt: dateOf(d.createdAt),
						revoked: dateOf(d.revoked),
						authTime: dateOf(d.authTime),
						scopes: jsonText(d.scopes),
					}),
				),
			);

			out.push(
				await copyCollection(
					fs,
					trx,
					"oauthGrantRevocation",
					"auth_oauth_grant_revocation",
					["userId", "clientId"],
					// Nova-owned table: the Firestore doc id was a sha256 digest; the
					// Postgres PK is (userId, clientId), so the values come from the body.
					(_id, d) => ({
						userId: strOf(d.userId),
						clientId: strOf(d.clientId),
						revokedAt: dateOf(d.revokedAt),
					}),
				),
			);

			out.push(
				await copyCollection(fs, trx, "jwks", "auth_jwks", ["id"], (id, d) => ({
					id,
					publicKey: strOf(d.publicKey),
					privateKey: strOf(d.privateKey),
					createdAt: dateOf(d.createdAt),
					expiresAt: dateOf(d.expiresAt),
				})),
			);

			return out;
		});

		return { skipped: false, perTable };
	} finally {
		// Release the Firestore transport so the Job process can exit. The pg pool
		// is owned by the connection layer (the entrypoint closes it once) — never
		// end it here.
		await fs.terminate().catch(() => {});
	}
}
