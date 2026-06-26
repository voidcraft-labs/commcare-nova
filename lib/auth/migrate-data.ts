// One-shot copy of the durable auth state from Firestore → Postgres, run
// automatically by the migrate Job AFTER the auth tables are created, BEFORE
// traffic shifts to the Postgres-backed auth. Idempotent + guarded: it runs
// only when `auth_user` is empty (the first deploy after the tables land), so a
// re-deploy never re-copies over live Postgres writes.
//
// CUTOVER-WINDOW CAVEAT (accepted residual risk of the automatic one-shot): the
// copy reads a Firestore snapshot at migrate-Job time, but the OLD Firestore-auth
// revision keeps serving until traffic shifts to the new revision moments later.
// A brand-new user who FIRST signs in during that window writes to Firestore
// after the snapshot, is never copied (the empty-`auth_user` guard skips the copy
// on every later redeploy), and on the new revision re-logs in as a fresh user
// id — so anything they created in the window (apps keyed on the OLD id) orphans.
// The window is roughly the deploy's revision-promote time (seconds–minutes), so
// deploy at low traffic to shrink it; Firestore is retained, so an orphaned row
// is recoverable (an admin re-points `apps.owner` from the old id to the new).
// A zero-window cutover would need downtime or a pre-traffic re-run, both
// rejected in favor of this automatic single-shot.
//
// Faithful, ID-preserving transfer — `apps.owner` and every case-store
// `owner_id` key on the Better Auth user id, so the ids MUST survive verbatim.
// Encrypted account-token ciphertext and api-key hashes copy verbatim too
// (BETTER_AUTH_SECRET is unchanged), so existing OAuth accounts + API keys keep
// working. Firestore is NOT touched — it stays as a backup until a later manual
// cleanup, so a bad copy is always recoverable (empty `auth_user`, redeploy).
//
// Shape vs the destination's constraints. Better Auth's migrator creates real
// foreign keys + NOT NULLs the Firestore source never enforced, so the copy
// reconciles three things that would otherwise abort it:
//   1. `auth_oauth_refresh_token.sessionId` FKs `auth_session(id)`, but sessions
//      are intentionally NOT copied (ephemeral) — so sessionId is always nulled
//      (the FK is `ON DELETE SET NULL`, i.e. nullable by design).
//   2. consent / refresh-token / account / api-key rows FK `auth_oauth_client`
//      and `auth_user`; Firestore tolerated rows whose client/user doc was gone.
//      Rows whose required FK target wasn't copied are SKIPPED (counted), and a
//      client whose owner is gone keeps the row with a nulled `userId`. Required
//      columns with no DB default that legacy rows may lack are coalesced to a
//      safe value (api-key `configId` → "default" — the plugin's own default;
//      client `redirectUris` → []).
//   3. The copy still runs as ONE transaction, so anything the reconciliations
//      above don't cover — a UNIQUE collision (e.g. two users sharing an email,
//      which the community adapter never enforced) or a genuinely malformed row
//      missing a NOT NULL — aborts the whole copy and fails the Job by design.
//      Those have no safe automatic resolution (auto-dedup could drop the wrong
//      user and orphan their apps), so they halt + alert: an operator fixes the
//      source row and redeploys, and because `auth_user` is still empty the copy
//      retries cleanly. The cases that WOULD reliably fire (1 + 2) are handled,
//      so the abort path is reserved for genuine anomalies.
//
// Source Firestore collections: the `auth_*` trio is prefixed, the plugin tables
// use Better Auth's core default model names; targets are the `auth_`-prefixed
// Postgres tables. Ephemeral collections are SKIPPED — sessions, verification,
// rate-limit.
//
// Reads/writes use the typed Kysely builder (`CopyTables`) — no SQL literals.
// All collections are read up front (in parallel) so the transaction is
// insert-only and short — it never holds a pooled connection across Firestore
// round-trips. Inserts are chunked under Postgres' 65535-bind-parameter cap.
// Conversions: a Firestore `Timestamp` → JS `Date` (→ timestamptz); a jsonb
// column takes the value as JSON text (the Firestore adapter stores arrays as
// JSON strings) which Postgres casts to jsonb; `text` columns (e.g. api-key
// `permissions`) copy the string verbatim; everything else copies its scalar.

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
interface RawDoc {
	id: string;
	data: Doc;
}

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
 * Postgres caps a single Bind message at 65535 parameters; chunk so even the
 * widest table (auth_oauth_client, ~30 cols) stays well under it.
 */
const CHUNK_ROWS = 500;

async function readDocs(fs: Firestore, collection: string): Promise<RawDoc[]> {
	const snap = await fs.collection(collection).get();
	return snap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
}

/** Bulk-insert `rows` into `table` in capped chunks, conflict-skipping. */
async function chunkInsert<TB extends keyof CopyTables>(
	trx: Kysely<CopyTables>,
	table: TB,
	rows: Array<Insertable<CopyTables[TB]>>,
	conflict: ReadonlyArray<keyof CopyTables[TB] & string>,
): Promise<void> {
	for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
		const chunk = rows.slice(i, i + CHUNK_ROWS);
		await trx
			.insertInto(table)
			.values(chunk)
			.onConflict((oc) => oc.columns([...conflict]).doNothing())
			.execute();
	}
}

export interface AuthDataCopyResult {
	skipped: boolean;
	perTable: Array<{ table: string; read: number; inserted: number }>;
}

/**
 * Copy durable auth state Firestore → Postgres in one short, insert-only
 * transaction, guarded on an empty `auth_user`. Returns a per-table summary
 * (`read` = source rows, `inserted` = rows kept after FK-orphan filtering) or
 * `{skipped:true}` when `auth_user` already has rows. Throws on any failure (the
 * transaction rolls back first). Never ends the shared pool — that is owned by
 * the connection layer.
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
		// Read every collection up front (parallel), so the transaction below is
		// insert-only and never holds a connection across a Firestore round-trip.
		const [
			users,
			clients,
			accounts,
			apikeys,
			consents,
			refreshTokens,
			grants,
			jwks,
		] = await Promise.all([
			readDocs(fs, "auth_users"),
			readDocs(fs, "oauthClient"),
			readDocs(fs, "auth_accounts"),
			readDocs(fs, "apikey"),
			readDocs(fs, "oauthConsent"),
			readDocs(fs, "oauthRefreshToken"),
			readDocs(fs, "oauthGrantRevocation"),
			readDocs(fs, "jwks"),
		]);

		// FK target sets for orphan filtering. `auth_user.id` ← doc id;
		// `auth_oauth_client.clientId` ← the client's `clientId` field.
		const userIds = new Set(users.map((u) => u.id));
		const clientIds = new Set(
			clients
				.map((c) => strOf(c.data.clientId))
				.filter((v): v is string => v !== null),
		);
		const inUsers = (v: unknown): boolean =>
			typeof v === "string" && userIds.has(v);
		const inClients = (v: unknown): boolean =>
			typeof v === "string" && clientIds.has(v);

		// ── Build typed rows (mapping + FK-orphan filtering) ──────────────
		const userRows = users.map((u) => ({
			id: u.id,
			name: strOf(u.data.name),
			email: strOf(u.data.email),
			emailVerified: boolOf(u.data.emailVerified),
			image: strOf(u.data.image),
			role: strOf(u.data.role),
			banned: boolOf(u.data.banned),
			banReason: strOf(u.data.banReason),
			banExpires: dateOf(u.data.banExpires),
			lastActiveAt: dateOf(u.data.lastActiveAt),
			createdAt: dateOf(u.data.createdAt),
			updatedAt: dateOf(u.data.updatedAt),
		}));

		const clientRows = clients.map((c) => ({
			id: c.id,
			clientId: strOf(c.data.clientId),
			clientSecret: strOf(c.data.clientSecret),
			disabled: boolOf(c.data.disabled),
			skipConsent: boolOf(c.data.skipConsent),
			enableEndSession: boolOf(c.data.enableEndSession),
			subjectType: strOf(c.data.subjectType),
			scopes: jsonText(c.data.scopes),
			// A client whose registering user is gone keeps the row with a nulled
			// owner (the FK is nullable) rather than aborting the copy.
			userId: inUsers(c.data.userId) ? strOf(c.data.userId) : null,
			createdAt: dateOf(c.data.createdAt),
			updatedAt: dateOf(c.data.updatedAt),
			name: strOf(c.data.name),
			uri: strOf(c.data.uri),
			icon: strOf(c.data.icon),
			contacts: jsonText(c.data.contacts),
			tos: strOf(c.data.tos),
			policy: strOf(c.data.policy),
			softwareId: strOf(c.data.softwareId),
			softwareVersion: strOf(c.data.softwareVersion),
			softwareStatement: strOf(c.data.softwareStatement),
			// Required jsonb with no DB default; coalesce a missing value to an
			// empty array so a degenerate legacy client copies instead of aborting.
			redirectUris: jsonText(c.data.redirectUris) ?? "[]",
			postLogoutRedirectUris: jsonText(c.data.postLogoutRedirectUris),
			tokenEndpointAuthMethod: strOf(c.data.tokenEndpointAuthMethod),
			grantTypes: jsonText(c.data.grantTypes),
			responseTypes: jsonText(c.data.responseTypes),
			public: boolOf(c.data.public),
			type: strOf(c.data.type),
			requirePKCE: boolOf(c.data.requirePKCE),
			referenceId: strOf(c.data.referenceId),
			metadata: jsonText(c.data.metadata),
		}));

		const accountRows = accounts
			.filter((a) => inUsers(a.data.userId))
			.map((a) => ({
				id: a.id,
				accountId: strOf(a.data.accountId),
				providerId: strOf(a.data.providerId),
				userId: strOf(a.data.userId),
				accessToken: strOf(a.data.accessToken),
				refreshToken: strOf(a.data.refreshToken),
				idToken: strOf(a.data.idToken),
				accessTokenExpiresAt: dateOf(a.data.accessTokenExpiresAt),
				refreshTokenExpiresAt: dateOf(a.data.refreshTokenExpiresAt),
				scope: strOf(a.data.scope),
				password: strOf(a.data.password),
				createdAt: dateOf(a.data.createdAt),
				updatedAt: dateOf(a.data.updatedAt),
			}));

		const apikeyRows = apikeys
			.filter((k) => inUsers(k.data.referenceId))
			.map((k) => ({
				id: k.id,
				// Required column with no DB default; legacy keys minted before the
				// field existed lack it. "default" is the plugin's own default value
				// (createApiKey: `configId: opts.configId ?? "default"`), and verify
				// only matches configId when one is passed (Nova never does).
				configId: strOf(k.data.configId) ?? "default",
				name: strOf(k.data.name),
				start: strOf(k.data.start),
				referenceId: strOf(k.data.referenceId),
				prefix: strOf(k.data.prefix),
				key: strOf(k.data.key),
				refillInterval: numOf(k.data.refillInterval),
				refillAmount: numOf(k.data.refillAmount),
				lastRefillAt: dateOf(k.data.lastRefillAt),
				enabled: boolOf(k.data.enabled),
				rateLimitEnabled: boolOf(k.data.rateLimitEnabled),
				rateLimitTimeWindow: numOf(k.data.rateLimitTimeWindow),
				rateLimitMax: numOf(k.data.rateLimitMax),
				requestCount: numOf(k.data.requestCount),
				remaining: numOf(k.data.remaining),
				lastRequest: dateOf(k.data.lastRequest),
				expiresAt: dateOf(k.data.expiresAt),
				createdAt: dateOf(k.data.createdAt),
				updatedAt: dateOf(k.data.updatedAt),
				permissions: strOf(k.data.permissions),
				metadata: strOf(k.data.metadata),
			}));

		const consentRows = consents
			.filter(
				(c) =>
					inClients(c.data.clientId) &&
					(c.data.userId == null || inUsers(c.data.userId)),
			)
			.map((c) => ({
				id: c.id,
				clientId: strOf(c.data.clientId),
				userId: strOf(c.data.userId),
				referenceId: strOf(c.data.referenceId),
				scopes: jsonText(c.data.scopes),
				createdAt: dateOf(c.data.createdAt),
				updatedAt: dateOf(c.data.updatedAt),
			}));

		const refreshRows = refreshTokens
			.filter((t) => inClients(t.data.clientId) && inUsers(t.data.userId))
			.map((t) => ({
				id: t.id,
				token: strOf(t.data.token),
				clientId: strOf(t.data.clientId),
				// Sessions are intentionally not copied; null the FK (ON DELETE SET
				// NULL) rather than reference a row that won't exist.
				sessionId: null,
				userId: strOf(t.data.userId),
				referenceId: strOf(t.data.referenceId),
				expiresAt: dateOf(t.data.expiresAt),
				createdAt: dateOf(t.data.createdAt),
				revoked: dateOf(t.data.revoked),
				authTime: dateOf(t.data.authTime),
				scopes: jsonText(t.data.scopes),
			}));

		// Nova-owned table, no FK — copy every row (values come from the body, the
		// Firestore doc id was a sha256 digest).
		const grantRows = grants.map((g) => ({
			userId: strOf(g.data.userId),
			clientId: strOf(g.data.clientId),
			revokedAt: dateOf(g.data.revokedAt),
		}));

		const jwksRows = jwks.map((j) => ({
			id: j.id,
			publicKey: strOf(j.data.publicKey),
			privateKey: strOf(j.data.privateKey),
			createdAt: dateOf(j.data.createdAt),
			expiresAt: dateOf(j.data.expiresAt),
		}));

		// ── One short, insert-only transaction, in FK order ──────────────
		await db.transaction().execute(async (trx) => {
			await chunkInsert(trx, "auth_user", userRows, ["id"]);
			await chunkInsert(trx, "auth_oauth_client", clientRows, ["id"]);
			await chunkInsert(trx, "auth_account", accountRows, ["id"]);
			await chunkInsert(trx, "auth_apikey", apikeyRows, ["id"]);
			await chunkInsert(trx, "auth_oauth_consent", consentRows, ["id"]);
			await chunkInsert(trx, "auth_oauth_refresh_token", refreshRows, ["id"]);
			await chunkInsert(trx, "auth_oauth_grant_revocation", grantRows, [
				"userId",
				"clientId",
			]);
			await chunkInsert(trx, "auth_jwks", jwksRows, ["id"]);
		});

		return {
			skipped: false,
			perTable: [
				{ table: "auth_user", read: users.length, inserted: userRows.length },
				{
					table: "auth_oauth_client",
					read: clients.length,
					inserted: clientRows.length,
				},
				{
					table: "auth_account",
					read: accounts.length,
					inserted: accountRows.length,
				},
				{
					table: "auth_apikey",
					read: apikeys.length,
					inserted: apikeyRows.length,
				},
				{
					table: "auth_oauth_consent",
					read: consents.length,
					inserted: consentRows.length,
				},
				{
					table: "auth_oauth_refresh_token",
					read: refreshTokens.length,
					inserted: refreshRows.length,
				},
				{
					table: "auth_oauth_grant_revocation",
					read: grants.length,
					inserted: grantRows.length,
				},
				{ table: "auth_jwks", read: jwks.length, inserted: jwksRows.length },
			],
		};
	} finally {
		// Release the Firestore transport so the Job process can exit. The pg pool
		// is owned by the connection layer (the entrypoint closes it once) — never
		// end it here.
		await fs.terminate().catch(() => {});
	}
}
