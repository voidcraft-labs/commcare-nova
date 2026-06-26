// Kysely typing + handle for the `auth_*` tables Nova's own code reads/writes
// DIRECTLY — i.e. OUTSIDE Better Auth's adapter (admin dashboard, the session
// revocation check, the OAuth consent/revocation surface). Better Auth manages
// the tables' creation + its own CRUD; this is the app-domain read/write side.
//
// Columns mirror Better Auth's generated schema verbatim: identifiers are
// case-sensitive camelCase (`userId`, `createdAt`, `lastActiveAt`, …) and array
// fields are `jsonb` (so Kysely returns them as real arrays, not JSON strings).
// Only the tables + columns Nova touches directly are typed here; Better Auth's
// full schema has more. `auth_oauth_grant_revocation` is Nova-OWNED (not a
// Better Auth model) — created by our own migration, queried only here.
//
// Runs on the SHARED case-store pool (one pool per instance — the connection
// budget). The pool's lifecycle is owned by `lib/case-store/postgres/connection`
// (`closeCaseStoreDatabase` ends it on SIGTERM); this module never ends it.

import {
	type ColumnType,
	Kysely,
	PostgresDialect,
	type PostgresPool,
} from "kysely";
import { getCaseStorePool } from "@/lib/case-store/postgres/connection";

/** Server-set timestamp: read as `Date`, write as `Date`, omit on insert when defaulted. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;

interface AuthUserTable {
	id: string;
	email: string;
	name: string;
	image: string | null;
	role: string | null;
	banned: boolean | null;
	banReason: string | null;
	banExpires: Timestamp | null;
	// App-added field (`additionalFields` in lib/auth.ts); written by `touchUser`.
	lastActiveAt: ColumnType<Date | null, Date | string, Date | string>;
	createdAt: Timestamp;
	updatedAt: Timestamp;
}

interface AuthOAuthClientTable {
	id: string;
	clientId: string;
	name: string | null;
	/** Public DCR clients (`token_endpoint_auth_method: none`). */
	public: boolean | null;
	/** Present only for clients registered by an authenticated user. */
	userId: string | null;
	createdAt: Timestamp | null;
}

interface AuthOAuthConsentTable {
	id: string;
	clientId: string;
	userId: string | null;
	/** `jsonb` array of granted scope strings. */
	scopes: ColumnType<string[], string[], string[]>;
	createdAt: Timestamp;
	updatedAt: Timestamp;
}

interface AuthOAuthRefreshTokenTable {
	id: string;
	/** Hashed refresh token. */
	token: string;
	clientId: string;
	userId: string;
	/** Set (a Date) when revoked; null while live. */
	revoked: ColumnType<Date | null, Date | string, Date | string>;
	createdAt: Timestamp;
	expiresAt: Timestamp;
}

interface AuthApikeyTable {
	id: string;
	/** The key's owner — Better Auth's `references: "user"` foreign key. */
	referenceId: string;
	name: string | null;
	/** Prefix-plus-first-six-chars, stamped for masked display. */
	start: string | null;
	prefix: string | null;
	/**
	 * `text` column the api-key plugin JSON-stringifies on write (its schema type
	 * is `"string"`, NOT `"string[]"`, so the adapter's auto-stringify never
	 * fires) — so this is a JSON string, decoded by `decodePermissions`, NOT a
	 * jsonb array like the oauth `scopes` column.
	 */
	permissions: string | null;
	createdAt: Timestamp;
	expiresAt: Timestamp | null;
	lastRequest: Timestamp | null;
}

/**
 * Nova-owned per-(user, client) JWT revocation watermark. NOT a Better Auth
 * model — created by our migration (`lib/auth/migrations`). `revokedAt` is the
 * cutoff: a token whose `iat` precedes it is rejected.
 */
interface AuthOAuthGrantRevocationTable {
	userId: string;
	clientId: string;
	revokedAt: ColumnType<Date, Date | string, Date | string>;
}

export interface AuthDatabase {
	auth_user: AuthUserTable;
	auth_apikey: AuthApikeyTable;
	auth_oauth_client: AuthOAuthClientTable;
	auth_oauth_consent: AuthOAuthConsentTable;
	auth_oauth_refresh_token: AuthOAuthRefreshTokenTable;
	auth_oauth_grant_revocation: AuthOAuthGrantRevocationTable;
}

let cached: Kysely<AuthDatabase> | null = null;
let injectedForTests: Kysely<AuthDatabase> | null = null;

/**
 * Test-only seam: point `getAuthDb` at a specific handle (e.g. a per-test
 * Postgres from `setupPerTestDatabase`) so the auth-table reads/writes —
 * which reach the DB through the `getAuthDb` singleton — can run against the
 * testcontainer. Pass `null` to clear. No-op in production code paths.
 */
export function __setAuthDbForTests(db: Kysely<AuthDatabase> | null): void {
	injectedForTests = db;
}

/**
 * The `Kysely<AuthDatabase>` handle for Nova's direct auth-table reads/writes,
 * on the shared case-store pool. Memoized; never destroyed here (the pool is
 * owned by the case-store connection layer).
 */
export async function getAuthDb(): Promise<Kysely<AuthDatabase>> {
	if (injectedForTests) return injectedForTests;
	if (cached) return cached;
	const pool = await getCaseStorePool();
	cached = new Kysely<AuthDatabase>({
		dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
	});
	return cached;
}
