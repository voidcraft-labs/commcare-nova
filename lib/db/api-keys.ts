/**
 * App-owned reads against `@better-auth/api-key`'s Firestore table.
 *
 * Exists for the same reason `lib/db/oauth-consents.ts` exists for the
 * oauth-provider plugin: the settings page needs a list view, and the
 * mint Server Action needs a pre-flight count for the per-user limit
 * check. Both are direct-Firestore reads against the plugin-owned
 * `apikey` collection — going through the plugin's typed `auth.api.*`
 * surface for these would require either a session-on-the-server
 * impersonation dance or duplicate Zod schemas.
 *
 * The api-key plugin manually JSON-stringifies the `permissions` field
 * on write (schema type is `"string"`, not `"string[]"`, so the adapter
 * factory's auto-stringify path does NOT fire). Plugin reads via
 * `ctx.context.adapter.findOne(...)` get the field decoded by the
 * plugin's own `safeJSONParse` wrapper. Direct Firestore reads see the
 * raw JSON string. Hence the local `decodePermissions` helper — same
 * shape as `decodeScopes` in `oauth-consents.ts`, different rationale
 * (manual stringify by plugin vs auto-stringify by adapter framework).
 *
 * Collection name is `apikey` — the api-key plugin's `API_KEY_TABLE_NAME`
 * constant. `better-auth-firestore` uses `modelName` as-is for plugin
 * tables, no `auth_` prefix (same convention as `oauthConsent` /
 * `oauthRefreshToken`).
 */

import { Timestamp } from "@google-cloud/firestore";
import { log } from "@/lib/logger";
import { getDb } from "./firestore";

// ── Public types ────────────────────────────────────────────────────

/**
 * Single api-key row as the settings UI consumes it. Every field that
 * users see in the list view is here; the raw `key` value is
 * deliberately absent — only the mint endpoint ever surfaces it, and
 * that response goes straight from `auth.api.createApiKey` into the
 * Server Action's return without passing through this module.
 */
export interface ApiKeySummary {
	/** `apikey` document id — opaque to the UI; passed back on revoke / scope edit. */
	keyId: string;
	/** Human-readable label the user gave at mint time. */
	name: string;
	/**
	 * Visible-prefix portion of the key (`sk-nova-v1-` plus the first few
	 * chars of the random body). Used for masked display in the list
	 * (`sk-nova-v1-aBc12X • • • …`) so users can identify a key without
	 * revealing its full value. Sourced from the plugin's `start` field.
	 */
	displayPrefix: string;
	/** Granted scope set, decoded from the JSON-stringified `permissions.scope` array. */
	scopes: string[];
	/** ISO string from `apikey.createdAt`. */
	createdAt: string;
	/** ISO string from `apikey.expiresAt`, or null when the key has no expiry. */
	expiresAt: string | null;
	/** ISO string from `apikey.lastRequest`, or null when the key has not been used. */
	lastUsedAt: string | null;
}

// ── Raw doc shape (Firestore-side) ──────────────────────────────────

/**
 * Subset of the `apikey` doc we read. The plugin's full schema has
 * many more fields (rate limiting, refill, request count) that the
 * settings UI doesn't need to surface yet; widening this interface is
 * how new fields opt in.
 *
 * `permissions` is typed `unknown` because the plugin manually
 * JSON-stringifies it on write — see `decodePermissions`.
 */
interface ApiKeyDoc {
	name?: string | null;
	start?: string | null;
	prefix?: string | null;
	referenceId: string;
	createdAt: Timestamp | Date;
	expiresAt?: Timestamp | Date | null;
	lastRequest?: Timestamp | Date | null;
	permissions?: unknown;
}

// ── Collection names + helpers ──────────────────────────────────────

/** Plugin-defined Firestore collection. Source of truth: `@better-auth/api-key`'s `API_KEY_TABLE_NAME`. */
const COLLECTION_API_KEY = "apikey";

/** Better Auth's user collection — used by `isUserActive` to verify the key's owner is still in good standing. */
const COLLECTION_AUTH_USERS = "auth_users";

/**
 * Hard cap on active keys per user. The mint Server Action enforces
 * the limit (count → create → recount-and-delete-if-over compensating
 * action). Single source of truth — both the action and the list
 * query reference this constant.
 */
export const PER_USER_KEY_LIMIT = 10;

/**
 * Safety bound on `listUserApiKeys`'s Firestore read. Sized well above
 * `PER_USER_KEY_LIMIT` so any pre-existing over-limit state — left by
 * an admin tool, partial migration, or compensating-delete failure
 * after a concurrent mint race — stays visible in the UI and the user
 * can revoke down to the limit from the kebab menu. Also caps the
 * blast radius of a runaway state so the settings page doesn't
 * degrade into an unbounded fetch.
 */
const LIST_KEYS_READ_CAP = 50;

/**
 * Convert a Firestore-shaped date value to an ISO string. Firestore
 * returns `Timestamp` on read, accepts `Date` on write; the api-key
 * plugin's `auth.api.createApiKey` return path may surface either
 * shape depending on how the adapter trip-routes the row, so any code
 * that reads the plugin's response should run through this helper
 * rather than constructing `new Date(...).toISOString()` directly —
 * `new Date(<Timestamp>)` produces "Invalid Date" since `Timestamp`
 * isn't a valid `Date` constructor input. Exported so the Server
 * Actions can use it on the create-endpoint response.
 */
export function toISOString(val: Timestamp | Date): string {
	if (val instanceof Timestamp) return val.toDate().toISOString();
	return val.toISOString();
}

export function toISOStringOrNull(
	val: Timestamp | Date | null | undefined,
): string | null {
	if (!val) return null;
	return toISOString(val);
}

/**
 * Decode the `permissions` field back to `Record<string, string[]>`.
 *
 * The api-key plugin writes via `JSON.stringify(permissions)` (see
 * `node_modules/@better-auth/api-key/dist/index.mjs::createApiKey`'s
 * `permissionsToApply` branch) and reads via `safeJSONParse`. Direct
 * Firestore reads bypass the plugin and see the raw string, so we
 * invert here.
 *
 * Falls through to an empty record on any unexpected shape — keeps a
 * future schema change from crashing the settings list view; the row
 * just renders with no scopes until the migration lands.
 */
function decodePermissions(raw: unknown): Record<string, string[]> {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const result: Record<string, string[]> = {};
		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			if (Array.isArray(value)) {
				result[key] = value.filter((s): s is string => typeof s === "string");
			}
		}
		return result;
	}
	if (typeof raw === "string") {
		try {
			const parsed: unknown = JSON.parse(raw);
			return decodePermissions(parsed);
		} catch {
			/* fall through to {}; raw was a non-JSON string */
		}
	}
	return {};
}

/**
 * Pull the `scope` resource out of the decoded permissions object.
 *
 * Nova's permissions shape is flat (`{ scope: [...nova scopes] }`) per
 * the design decision in `lib/auth.ts`'s api-key mount comment.
 * Permission resources we don't recognize are dropped — the UI only
 * renders the Nova scope vocabulary, so a forward-compatible permission
 * key (e.g. a future `nova.admin` resource) won't crash the list, it
 * just won't be visible until the UI is taught about it.
 */
function extractScopes(permissions: Record<string, string[]>): string[] {
	return permissions.scope ?? [];
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * List the user's API keys, newest first. Reads `apikey` rows for the
 * user. Mirrors `listAuthorizedClients` in `oauth-consents.ts`.
 *
 * Sort happens client-side because at this size (≤`PER_USER_KEY_LIMIT`
 * keys per user) the cost is negligible and the Firestore composite
 * index isn't worth carrying.
 *
 * Read is capped at `LIST_KEYS_READ_CAP`, which sits well above
 * `PER_USER_KEY_LIMIT`, so a temporarily over-limit state (race
 * compensating-delete failure, admin tool, partial migration) stays
 * visible in the UI — the user can still see and revoke every key
 * the row store holds for them. The cap bounds the runaway-state
 * blast radius without hiding rows that exist.
 */
export async function listUserApiKeys(
	userId: string,
): Promise<ApiKeySummary[]> {
	const snap = await getDb()
		.collection(COLLECTION_API_KEY)
		.where("referenceId", "==", userId)
		.limit(LIST_KEYS_READ_CAP)
		.get();

	if (snap.empty) return [];

	const rows: ApiKeySummary[] = snap.docs.map((doc) => {
		const data = doc.data() as ApiKeyDoc;
		/* `start` is the prefix-plus-first-six-chars portion the plugin
		 * stamps at create time per `startingCharactersConfig.shouldStore`
		 * (see `lib/auth.ts`'s api-key mount). It identifies the row in
		 * the masked list view. The bare wire prefix `data.prefix`
		 * (`sk-nova-v1-`) is never used as a fallback — it would render
		 * every row identically and hide a real schema regression
		 * behind a misleading display. An empty string falls through
		 * cleanly: the JSX guards `displayPrefix &&` before showing the
		 * chip. The `log.warn` makes the regression visible in Cloud
		 * Logging since under our config `start` should always be
		 * present. */
		if (!data.start) {
			log.warn("[lib/db/api-keys] apikey row missing `start` field", {
				keyId: doc.id,
			});
		}
		return {
			keyId: doc.id,
			name: data.name ?? "",
			displayPrefix: data.start ?? "",
			scopes: extractScopes(decodePermissions(data.permissions)),
			createdAt: toISOString(data.createdAt),
			expiresAt: toISOStringOrNull(data.expiresAt),
			lastUsedAt: toISOStringOrNull(data.lastRequest),
		};
	});

	if (rows.length > PER_USER_KEY_LIMIT) {
		/* Under normal operation the mint Server Action's count →
		 * create → recount-and-delete-if-over compensating action
		 * keeps the row count at or below the limit. An over-limit
		 * state here means something bypassed it (a compensating-
		 * delete failure during a mint race, admin tooling, partial
		 * migration, manual Firestore edit). Surface it in logs so a
		 * persistent over-limit doesn't go quietly unnoticed; rows
		 * stay visible in the UI so the user can revoke down. */
		log.warn("[lib/db/api-keys] user is over the per-user key limit", {
			userId,
			rowCount: rows.length,
			limit: PER_USER_KEY_LIMIT,
		});
	}

	rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return rows;
}

/**
 * Count every `apikey` row referencing this user, including disabled
 * and expired-but-not-yet-deleted rows. Used by the mint Server
 * Action's pre-flight limit check.
 *
 * Disabled keys count toward the per-user budget — a disabled row
 * still occupies storage and a slot in the list. Excluding them would
 * let a user pile up unlimited disabled keys, which is the exact
 * storage abuse the limit defends against. Expired rows count for the
 * same reason: the api-key plugin only deletes them lazily on a
 * verify-time sweep (every 10 seconds at most), so a freshly-expired
 * row is still on disk and in the list view until the next sweep
 * fires.
 */
export async function countUserApiKeys(userId: string): Promise<number> {
	const snap = await getDb()
		.collection(COLLECTION_API_KEY)
		.where("referenceId", "==", userId)
		.count()
		.get();
	return snap.data().count;
}

/**
 * Predicate the MCP route uses to enforce live revocation of API
 * keys for banned or deleted users. The api-key plugin's
 * `validateApiKey` does NOT cross-reference `auth_users` — it only
 * checks the apikey row's own state — so a banned user's pre-minted
 * keys would otherwise authenticate forever. The JWT path is
 * implicitly bounded by the access-token TTL plus consent-revocation
 * lookups; the API-key path has neither, so this read is the
 * equivalent live-revocation lock.
 *
 * Returns false when the row is missing (deleted user) or has
 * `banned: true` whose `banExpires` is still in the future. An
 * expired temp ban (`banExpires < now`) is treated as not-banned and
 * returns true — mirroring Better Auth admin plugin's
 * session-create hook (`databaseHooks.session.create.before`), which
 * is the only place the framework lazily clears expired bans. The
 * api-key path bypasses session creation, so this read replicates
 * the same expiry semantics inline; without it, a temp-banned user's
 * keys would stay disabled past the ban window until they signed in
 * interactively. Permanent bans (`banned: true` with `banExpires:
 * null`) keep returning false, matching the admin hook's fall-
 * through behavior.
 *
 * Throws on Firestore failure — the local catch in `handleApiKeyMcp`
 * translates the throw into a 401 (the same `"api key verify failed"`
 * reason as a verifier outage), so the wire posture is fail-closed: a
 * transient outage rejects rather than authenticates a possibly-banned
 * user. Server Actions wrap their own call in a parallel catch (see
 * `isAuthorizedSession` in `app/(app)/settings/api-key-actions.ts`)
 * for the same reason.
 */
export async function isUserActive(userId: string): Promise<boolean> {
	const snap = await getDb()
		.collection(COLLECTION_AUTH_USERS)
		.doc(userId)
		.get();
	if (!snap.exists) return false;
	const data = snap.data() as
		| { banned?: boolean; banExpires?: Timestamp | Date | null }
		| undefined;
	if (data?.banned !== true) return true;
	const expires = data.banExpires;
	if (!expires) return false;
	const expiresMs =
		expires instanceof Timestamp
			? expires.toMillis()
			: expires instanceof Date
				? expires.getTime()
				: null;
	if (expiresMs === null) return false;
	return expiresMs < Date.now();
}
