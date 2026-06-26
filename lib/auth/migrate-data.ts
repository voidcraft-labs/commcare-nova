// One-shot copy of the durable auth state from Firestore → Postgres, run
// automatically by the migrate Job AFTER the auth tables are created, BEFORE
// traffic shifts to the Postgres-backed auth. Idempotent + guarded: it runs
// only when `auth_user` is empty (the first deploy after the tables land), so a
// re-deploy never re-copies over live Postgres writes. The whole copy is ONE
// transaction — if any row fails it rolls back, `auth_user` stays empty, the Job
// exits non-zero, and the next deploy retries the whole copy cleanly (no partial
// migration can latch).
//
// Faithful, ID-preserving transfer — `apps.owner` and every case-store
// `owner_id` key on the Better Auth user id, so the ids MUST survive verbatim.
// Encrypted account-token ciphertext and api-key hashes copy verbatim too
// (BETTER_AUTH_SECRET is unchanged), so existing OAuth accounts + API keys keep
// working. Firestore is NOT touched — it stays as a backup until a later manual
// cleanup, so a bad copy is always recoverable (empty `auth_user`, redeploy).
//
// Source collection names are the PRE-migration Firestore names (the `auth_*`
// trio was prefixed; the plugin tables used core defaults); targets are the
// `auth_`-prefixed Postgres tables. SKIPPED as ephemeral (per the chosen scope):
// sessions, verification, rate-limit — users sign in once more, in-flight OAuth
// flows restart, counters reset.
//
// Field names match column names verbatim (Better Auth's camelCase model fields
// under the Firestore adapter's `namingStrategy: "default"`), so each spec's
// column list doubles as the field selector. Conversions: Firestore `Timestamp`
// → JS `Date` (→ timestamptz); for jsonb target columns the Firestore value (a
// JSON string, since the Firestore adapter stringified arrays) is passed as JSON
// text that Postgres casts to jsonb; everything else copies verbatim.

import { Firestore, Timestamp } from "@google-cloud/firestore";
import type { Pool } from "pg";
import { firestoreClientOptions } from "@/lib/db/firestoreClientOptions";

interface TableSpec {
	/** Source Firestore collection (pre-migration name). */
	collection: string;
	/** Target Postgres table. */
	table: string;
	/** Target columns to copy — also the field selector (names match). */
	columns: readonly string[];
	/** Subset of `columns` that are jsonb (value passed as JSON text). */
	jsonb: readonly string[];
	/** `ON CONFLICT` target, e.g. `("id")`. */
	conflict: string;
	/**
	 * When true, the Firestore doc id becomes the `id` column (the common
	 * case). False for the grant-revocation table, whose Firestore doc id was a
	 * sha256 digest and whose Postgres PK is `(userId, clientId)` — its values
	 * come from the doc body instead.
	 */
	useDocId: boolean;
}

/**
 * Ordered so foreign keys resolve: `auth_user` first; `auth_oauth_client`
 * before the consent/refresh rows that may reference it; the user-referencing
 * tables after `auth_user`.
 */
const SPECS: readonly TableSpec[] = [
	{
		collection: "auth_users",
		table: "auth_user",
		columns: [
			"name",
			"email",
			"emailVerified",
			"image",
			"createdAt",
			"updatedAt",
			"role",
			"banned",
			"banReason",
			"banExpires",
			"lastActiveAt",
		],
		jsonb: [],
		conflict: '("id")',
		useDocId: true,
	},
	{
		collection: "oauthClient",
		table: "auth_oauth_client",
		columns: [
			"clientId",
			"clientSecret",
			"disabled",
			"skipConsent",
			"enableEndSession",
			"subjectType",
			"scopes",
			"userId",
			"createdAt",
			"updatedAt",
			"name",
			"uri",
			"icon",
			"contacts",
			"tos",
			"policy",
			"softwareId",
			"softwareVersion",
			"softwareStatement",
			"redirectUris",
			"postLogoutRedirectUris",
			"tokenEndpointAuthMethod",
			"grantTypes",
			"responseTypes",
			"public",
			"type",
			"requirePKCE",
			"referenceId",
			"metadata",
		],
		jsonb: [
			"scopes",
			"contacts",
			"redirectUris",
			"postLogoutRedirectUris",
			"grantTypes",
			"responseTypes",
			"metadata",
		],
		conflict: '("id")',
		useDocId: true,
	},
	{
		collection: "auth_accounts",
		table: "auth_account",
		columns: [
			"accountId",
			"providerId",
			"userId",
			"accessToken",
			"refreshToken",
			"idToken",
			"accessTokenExpiresAt",
			"refreshTokenExpiresAt",
			"scope",
			"password",
			"createdAt",
			"updatedAt",
		],
		jsonb: [],
		conflict: '("id")',
		useDocId: true,
	},
	{
		collection: "apikey",
		table: "auth_apikey",
		columns: [
			"configId",
			"name",
			"start",
			"referenceId",
			"prefix",
			"key",
			"refillInterval",
			"refillAmount",
			"lastRefillAt",
			"enabled",
			"rateLimitEnabled",
			"rateLimitTimeWindow",
			"rateLimitMax",
			"requestCount",
			"remaining",
			"lastRequest",
			"expiresAt",
			"createdAt",
			"updatedAt",
			"permissions",
			"metadata",
		],
		// `permissions` / `metadata` are TEXT (the api-key plugin stringifies into
		// a string column on both stores), so they copy verbatim — NOT jsonb.
		jsonb: [],
		conflict: '("id")',
		useDocId: true,
	},
	{
		collection: "oauthConsent",
		table: "auth_oauth_consent",
		columns: [
			"clientId",
			"userId",
			"referenceId",
			"scopes",
			"createdAt",
			"updatedAt",
		],
		jsonb: ["scopes"],
		conflict: '("id")',
		useDocId: true,
	},
	{
		collection: "oauthRefreshToken",
		table: "auth_oauth_refresh_token",
		columns: [
			"token",
			"clientId",
			"sessionId",
			"userId",
			"referenceId",
			"expiresAt",
			"createdAt",
			"revoked",
			"authTime",
			"scopes",
		],
		jsonb: ["scopes"],
		conflict: '("id")',
		useDocId: true,
	},
	{
		collection: "oauthGrantRevocation",
		table: "auth_oauth_grant_revocation",
		columns: ["userId", "clientId", "revokedAt"],
		jsonb: [],
		conflict: '("userId", "clientId")',
		useDocId: false,
	},
	{
		collection: "jwks",
		table: "auth_jwks",
		columns: ["publicKey", "privateKey", "createdAt", "expiresAt"],
		jsonb: [],
		conflict: '("id")',
		useDocId: true,
	},
];

/** Convert a Firestore field value to a pg query parameter. */
function toParam(col: string, value: unknown, jsonb: Set<string>): unknown {
	if (value === null || value === undefined) return null;
	if (value instanceof Timestamp) return value.toDate();
	// jsonb target: pass JSON text (the Firestore adapter stored arrays as JSON
	// strings; a structured value gets stringified) — Postgres casts text→jsonb.
	if (jsonb.has(col)) {
		return typeof value === "string" ? value : JSON.stringify(value);
	}
	return value;
}

export interface AuthDataCopyResult {
	skipped: boolean;
	perTable: Array<{ table: string; read: number; inserted: number }>;
}

/**
 * Copy durable auth state Firestore → Postgres in one transaction, guarded on
 * an empty `auth_user`. Returns a per-table summary (or `{skipped:true}` when
 * `auth_user` already has rows). Throws on any failure (rolls back first).
 */
export async function copyAuthDataFromFirestore(
	pool: Pool,
): Promise<AuthDataCopyResult> {
	const guard = await pool.query<{ count: string }>(
		`SELECT count(*)::text AS count FROM auth_user`,
	);
	if (Number(guard.rows[0]?.count ?? "0") > 0) {
		return { skipped: true, perTable: [] };
	}

	const fs = new Firestore(firestoreClientOptions());
	const perTable: AuthDataCopyResult["perTable"] = [];
	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		for (const spec of SPECS) {
			const jsonb = new Set(spec.jsonb);
			const snap = await fs.collection(spec.collection).get();
			let inserted = 0;

			for (const doc of snap.docs) {
				const data = doc.data();
				const cols: string[] = [];
				const values: unknown[] = [];

				if (spec.useDocId) {
					cols.push("id");
					values.push(doc.id);
				}
				for (const col of spec.columns) {
					const raw = data[col];
					if (raw === undefined) continue; // let column default / NOT NULL apply
					cols.push(col);
					values.push(toParam(col, raw, jsonb));
				}

				const colIdents = cols.map((c) => `"${c}"`).join(", ");
				const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
				await client.query(
					`INSERT INTO "${spec.table}" (${colIdents}) VALUES (${placeholders}) ON CONFLICT ${spec.conflict} DO NOTHING`,
					values,
				);
				inserted += 1;
			}

			perTable.push({ table: spec.table, read: snap.size, inserted });
		}

		await client.query("COMMIT");
		return { skipped: false, perTable };
	} catch (err) {
		await client.query("ROLLBACK").catch(() => {});
		throw err;
	} finally {
		client.release();
		// Release the Firestore client's transport so the Job process can exit.
		await fs.terminate().catch(() => {});
	}
}
