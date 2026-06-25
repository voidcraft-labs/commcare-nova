/**
 * Nova API Key Server Actions — mint, revoke, edit-scopes.
 *
 * Mirrors the discriminated-union pattern in `oauth-actions.ts` and
 * `actions.ts`: never throws, always returns a structured result. Next.js
 * surfaces unhandled Server Action errors as full-page error boundaries,
 * which is the wrong UX for a settings card with inline error states.
 *
 * Auth model: every action calls `getSession()` server-side and refuses
 * if no session exists. The mint endpoint creates keys owned by the
 * session user; revoke / edit additionally re-check ownership against
 * the row's `referenceId` before invoking the plugin's typed delete or
 * update endpoint. Better Auth's own delete endpoint already checks
 * ownership, but matching the `revokeAuthorizedClient` pattern from
 * `lib/db/oauth-consents.ts` keeps both revoke flows symmetrical and
 * defends against any future plugin behavior change.
 *
 * Permissions shape: `{ scope: string[] }` — flat, mirrors Nova's
 * existing dot-namespaced scope vocabulary 1:1 (see
 * `NOVA_API_KEY_SCOPES` in `lib/auth.ts`). Avoids a translation layer
 * between the api-key plugin and the MCP route's scope-comparison code.
 *
 * Audit logging: mint / revoke / edit emit `log.info` events with the
 * key id and the userId. Per-request key usage is captured by the
 * plugin's own `lastRequest` field, surfaced in the settings UI as
 * "Last used".
 */

"use server";

import { Timestamp } from "@google-cloud/firestore";
import { APIError } from "better-auth/api";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { NOVA_API_KEY_SCOPES, NOVA_MCP_FLOOR_SCOPES } from "@/lib/auth-public";
import { callerIpFromHeaders, getSession } from "@/lib/auth-utils";
import {
	countUserApiKeys,
	isUserActive,
	PER_USER_KEY_LIMIT,
	toISOString,
	toISOStringOrNull,
} from "@/lib/db/api-keys";
import { getDb } from "@/lib/db/firestore";
import { log } from "@/lib/logger";

// ── Constants ───────────────────────────────────────────────────────

/* `PER_USER_KEY_LIMIT` is imported from `lib/db/api-keys` — the same
 * constant the listing query references, so the action's enforcement
 * and the UI's view share one source of truth. The pre-flight count
 * is a soft check; `mintApiKey` pairs it with a position-aware
 * compensating action (count → create → recount → if-over,
 * loser-only delete) so the per-user invariant is restored even when
 * concurrent Server Action calls all observe `< 10`. See
 * `isOverLimitMintLoser` for the loser-vs-winner determination. */

/**
 * Set of scope strings the mint / edit endpoints will accept. Anything
 * outside this set returns a validation error before the plugin call
 * fires — the plugin would store an unknown scope without complaint
 * (the schema is `Record<string, string[]>`), and the MCP route's
 * scope check would silently never grant it. Validating here means
 * the user gets a clear error at mint time, not a mysterious 403 at
 * runtime.
 */
const ALLOWED_SCOPE_SET: ReadonlySet<string> = new Set(NOVA_API_KEY_SCOPES);

// ── Types ───────────────────────────────────────────────────────────

/** Serializable expiry option from the mint UI's select. */
export type ExpiryOption = "30d" | "90d" | "1y" | "never";

/** Mint request body validated and forwarded to the plugin. */
export interface MintApiKeyInput {
	name: string;
	scopes: readonly string[];
	expiry: ExpiryOption;
}

export type MintApiKeyResult =
	| {
			success: true;
			/** Full plaintext key (`sk-nova-v1-…`). Returned ONCE. */
			key: string;
			/** Plugin row id — passed back on revoke / edit. */
			keyId: string;
			/** Visible-prefix portion (the `start` field). */
			displayPrefix: string;
			/**
			 * ISO string from the plugin's response. Server-clock
			 * timestamp, used by the optimistic UI so the freshly-minted
			 * row sorts identically to its eventual Firestore-derived
			 * shape after `revalidatePath`. Synthesizing `new Date()`
			 * client-side would create a sort-order skew between the
			 * optimistic insert and the canonical post-revalidation row.
			 */
			createdAt: string;
			/** ISO string from the plugin's response, or null when "never". */
			expiresAt: string | null;
	  }
	| { success: false; error: string };

export type RevokeApiKeyResult =
	| { success: true }
	| { success: false; error: string };

export type EditApiKeyScopesResult =
	| { success: true }
	| { success: false; error: string };

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Map the UI's expiry option to the plugin's `expiresIn` field, in
 * seconds. The plugin's create-endpoint Zod schema declares
 * `expiresIn` as a number with `.min(1).optional().nullable()`, where
 * `null` means "use the configured default" — but our default is also
 * 1y, so we pass the exact value the user picked, including for
 * "never".
 *
 * "Never" maps to 100 years (clamped at the configured `maxExpiresIn`
 * of 36500 days in `lib/auth.ts`). Functionally unbounded for any
 * realistic credential lifetime without leaving the create endpoint
 * un-bounds-checked.
 */
function expirySeconds(expiry: ExpiryOption): number {
	const SECONDS_PER_DAY = 60 * 60 * 24;
	switch (expiry) {
		case "30d":
			return 30 * SECONDS_PER_DAY;
		case "90d":
			return 90 * SECONDS_PER_DAY;
		case "1y":
			return 365 * SECONDS_PER_DAY;
		case "never":
			return 36500 * SECONDS_PER_DAY;
	}
}

/**
 * Validate the user-submitted scope list:
 *   - Every requested scope is in the allowed Nova vocabulary.
 *   - The floor scopes (`nova.read` + `nova.write`) are both present.
 *
 * Returns a `{ ok: true; scopes }` discriminated result so the caller
 * can hand the validated array straight to the plugin.
 */
function validateScopes(
	requested: readonly string[],
): { ok: true; scopes: string[] } | { ok: false; error: string } {
	const seen = new Set<string>();
	for (const scope of requested) {
		if (!ALLOWED_SCOPE_SET.has(scope)) {
			return {
				ok: false,
				error: `Unknown scope "${scope}". Pick from the read, write, hq.read, and hq.write options.`,
			};
		}
		seen.add(scope);
	}
	for (const required of NOVA_MCP_FLOOR_SCOPES) {
		if (!seen.has(required)) {
			return {
				ok: false,
				error: "Both read and write are required for any Nova API key.",
			};
		}
	}
	return { ok: true, scopes: Array.from(seen) };
}

/**
 * Translate Better Auth's `APIError` instances into UI-shaped strings.
 *
 * The plugin's error codes (e.g. `KEY_NOT_FOUND`, `INVALID_PREFIX`)
 * are useful for diagnostics in logs but not for the user. Every
 * branch here returns prose that reads as "a person talking to a
 * person who has a problem" per the project's error-message rule.
 *
 * `KEY_NOT_FOUND` is the plugin's collapsed code for both "no such
 * key" and "key exists but you don't own it" — see the
 * `apiKey.referenceId !== session.user.id` branches in
 * `node_modules/@better-auth/api-key/dist/index.mjs`'s delete and
 * update endpoints. The collapse is correct (it prevents leaking key
 * existence to non-owners), so we mirror it in our UI prose: a single
 * "no longer available" message for both cases.
 */
function readPluginErrorCode(err: unknown): string | undefined {
	if (err instanceof APIError) {
		return (err.body as { code?: string } | undefined)?.code;
	}
	return undefined;
}

/**
 * Match Better Auth's `generateId` output exactly: 32 characters from
 * `[a-zA-Z0-9]` (source: `@better-auth/core/utils/id::generateId` —
 * `createRandomStringGenerator("a-z", "A-Z", "0-9")(32)`). Server
 * Actions deserialize JSON from the wire so `keyId` is
 * client-controlled; tightening to the literal generator output
 * rejects everything that isn't a real Nova-issued key id —
 * whitespace, newlines, control characters, slashes, HTML,
 * oversized strings, and even legitimate-looking IDs from a
 * different generator the project doesn't use. Test fixtures use
 * realistic 32-char alphanumeric strings to match.
 */
const BETTER_AUTH_ID_PATTERN = /^[a-zA-Z0-9]{32}$/;

function isValidKeyId(value: unknown): value is string {
	return typeof value === "string" && BETTER_AUTH_ID_PATTERN.test(value);
}

/** Server-Action-shaped wrapper around `callerIpFromHeaders` — awaits
 * `next/headers` so the audit-log call sites stay one-liners. */
async function callerIp(): Promise<string> {
	return callerIpFromHeaders(await headers());
}

/**
 * Decide whether the just-minted row is a "loser" of a count→create
 * race — i.e., whether its position in the user's row set, ordered
 * deterministically, falls beyond `PER_USER_KEY_LIMIT`. Returns true
 * when the caller should delete its own row and surface the limit
 * error; false when the caller is a winner and should keep its row.
 *
 * Ordering is `createdAt asc, id asc`. Better Auth's `generateId`
 * emits 32-char alphanumeric ids that are random with respect to
 * order, but lexically comparable; the secondary sort by id resolves
 * the rare case where two creates land in the same millisecond.
 * Concurrent callers see the same Firestore-committed snapshot, so
 * they agree on the ordering — exactly the loser rows are pruned.
 *
 * If the caller's row isn't in the snapshot at all (eventual-
 * consistency stall, or a regression that mismatched the
 * `referenceId`), this function returns `false` and lets the caller
 * keep its row. The over-limit state is then logged when
 * `listUserApiKeys` next runs and the user can revoke from the UI;
 * deleting on a "row not found" verdict would risk destroying a
 * valid mint.
 */
async function isOverLimitMintLoser(
	userId: string,
	createdId: string,
): Promise<boolean> {
	let snap: FirebaseFirestore.QuerySnapshot;
	try {
		snap = await getDb()
			.collection("apikey")
			.where("referenceId", "==", userId)
			.get();
	} catch (err) {
		/* Read failure during compensating action — fail-open on
		 * delete (don't destroy the just-minted row). The over-
		 * limit state surfaces in `listUserApiKeys` and the user
		 * has a recovery path via the kebab-revoke flow. */
		log.error("[settings/api-keys] mint race position read failed", err);
		return false;
	}
	const ordered = snap.docs
		.map((d) => {
			const raw = (d.data() as { createdAt?: unknown }).createdAt;
			const createdAtMs =
				raw instanceof Timestamp
					? raw.toMillis()
					: raw instanceof Date
						? raw.getTime()
						: Number.NaN;
			return { id: d.id, createdAtMs };
		})
		.sort((a, b) => {
			if (a.createdAtMs !== b.createdAtMs) {
				return a.createdAtMs - b.createdAtMs;
			}
			return a.id.localeCompare(b.id);
		});
	const myIndex = ordered.findIndex((r) => r.id === createdId);
	if (myIndex === -1) return false;
	return myIndex >= PER_USER_KEY_LIMIT;
}

/**
 * Verify the session user isn't banned or deleted before performing
 * any authoring side effect. Better Auth's cookie cache (5-minute
 * `maxAge` configured at `lib/auth.ts::session.cookieCache`) means
 * `getSession()` can return a still-valid-looking session payload
 * for up to that window after `admin.banUser` deleted the underlying
 * `auth_sessions` row — a banned user with a stale cookie would
 * otherwise authenticate every Server Action in the gap. Mirrors
 * `requireAdminAccess`'s direct-Firestore bypass of the same cache
 * for `role` reads.
 *
 * Returns the same not-signed-in shape on a banned/deleted account
 * so the wire response doesn't disclose "you used to have an
 * account." `isUserActive` lives in `lib/db/api-keys.ts` for the
 * MCP-route revocation lock; reusing it here keeps the
 * Server Actions and the MCP route consistent on what "user is
 * authorized to act" means.
 */
async function isAuthorizedSession(
	userId: string,
	action: "mint" | "revoke" | "edit",
): Promise<boolean> {
	let active: boolean;
	try {
		active = await isUserActive(userId);
	} catch (err) {
		log.error("[settings/api-keys] user-status lookup failed", err);
		/* Fail closed — a Firestore outage rejects rather than
		 * authenticates a possibly-banned user. The action returns the
		 * "sign in" message; the user retries when the outage clears. */
		return false;
	}
	if (!active) {
		/* Mirrors `[mcp/api-key] user disabled or deleted` on the route
		 * side — the only persistent record that a banned-user action
		 * was attempted. Wire response is the generic "sign in"
		 * message; the audit signal lives here. */
		log.warn("[settings/api-keys] action rejected: user disabled", {
			userId,
			action,
			ip: await callerIp(),
		});
	}
	return active;
}

function pluginErrorMessage(err: unknown, fallback: string): string {
	const code = readPluginErrorCode(err);
	switch (code) {
		case "KEY_NOT_FOUND":
			return "That key isn't available — it may have been revoked already. The list will refresh on your next visit.";
		case "INVALID_NAME_LENGTH":
		case "NAME_REQUIRED":
			return "Names must be 1–32 characters.";
		case "EXPIRES_IN_IS_TOO_SMALL":
			return "Expiry must be at least 1 day from now.";
		case "EXPIRES_IN_IS_TOO_LARGE":
			return "Expiry must be no more than 100 years from now.";
		default:
			return fallback;
	}
}

// ── Actions ─────────────────────────────────────────────────────────

/**
 * Mint a new API key for the current session user.
 *
 * Pre-flight: enforce the per-user limit and validate the requested
 * scope set before invoking the plugin. The full plaintext key is
 * returned in the result and shown to the user exactly once — every
 * subsequent UI surface displays only the masked prefix.
 *
 * The `userId` body field is passed explicitly. The plugin can derive
 * it from a session if `headers` are forwarded, but passing it
 * directly is clearer at the Server Action boundary and matches the
 * pattern in the plugin's docs ("server-only — required for user-owned
 * keys when not using session headers").
 */
export async function mintApiKey(
	input: MintApiKeyInput,
): Promise<MintApiKeyResult> {
	try {
		const session = await getSession();
		if (!session) {
			return { success: false, error: "Sign in first to mint an API key." };
		}
		if (!(await isAuthorizedSession(session.user.id, "mint"))) {
			return { success: false, error: "Sign in first to mint an API key." };
		}

		/* Server Actions deserialize JSON; defend against malformed
		 * client payloads even though the type annotation says otherwise. */
		const name = typeof input?.name === "string" ? input.name.trim() : "";
		if (!name) {
			return {
				success: false,
				error: "Give your API key a name so you can recognize it later.",
			};
		}
		if (name.length > 32) {
			return {
				success: false,
				error: "Names must be 32 characters or fewer.",
			};
		}

		const scopeCheck = validateScopes(input?.scopes ?? []);
		if (!scopeCheck.ok) {
			return { success: false, error: scopeCheck.error };
		}

		const validExpiries: readonly ExpiryOption[] = [
			"30d",
			"90d",
			"1y",
			"never",
		];
		if (!validExpiries.includes(input?.expiry)) {
			return {
				success: false,
				error: "Pick one of the offered expiry options.",
			};
		}

		const existingCount = await countUserApiKeys(session.user.id);
		if (existingCount >= PER_USER_KEY_LIMIT) {
			return {
				success: false,
				error: `You already have ${PER_USER_KEY_LIMIT} keys, the per-account limit. Revoke one before minting another.`,
			};
		}

		const auth = await getAuth();
		/* Server-only mode: passing `headers` to `auth.api.createApiKey`
		 * makes the plugin's `isClientRequest` flag truthy, which then
		 * rejects every server-only field (including `permissions`) with
		 * a `SERVER_ONLY_PROPERTY` error. The plugin's docs spell the
		 * rule out: "If you're creating an API key on the server,
		 * without access to headers, you must pass the userId property."
		 * We deliberately omit headers and pass `userId` explicitly,
		 * derived from the session we already loaded above — the session
		 * check has already authenticated the caller; the plugin only
		 * needs the resolved id, not the request context. */
		const created = await auth.api.createApiKey({
			body: {
				name,
				expiresIn: expirySeconds(input.expiry),
				permissions: { scope: scopeCheck.scopes },
				userId: session.user.id,
			},
		});

		/* Compensating-action guard against the count→create race.
		 * The pre-flight `countUserApiKeys` is non-transactional, so
		 * two (or more) concurrent mints from the same user can both
		 * pass it and produce more rows than the limit allows.
		 *
		 * The compensation MUST be position-aware, not symmetric. A
		 * naive "if postCount > limit, delete my row" strategy lets
		 * every concurrent caller delete its own row — at count = 9,
		 * two parallel mints both create (count → 11), both observe
		 * 11, both delete, end state count = 9 with both callers
		 * seeing a misleading "you already have 10 keys" error. The
		 * invariant holds, but the user-visible behavior is wrong.
		 *
		 * Instead, every caller reads the user's full row set,
		 * applies the SAME deterministic ordering (createdAt asc,
		 * id asc as a millisecond-tie tiebreaker), finds its own
		 * row's index, and only deletes when that index falls beyond
		 * the limit. The earliest `PER_USER_KEY_LIMIT` rows are
		 * kept; later rows are pruned as losers. Concurrent callers
		 * agree on the ordering because Firestore returns the same
		 * snapshot of committed writes to each.
		 *
		 * Direct-Firestore delete sidesteps `auth.api.deleteApiKey`
		 * (which mounts `sessionMiddleware` and expects a cookie-
		 * bearing request that this server-only mode doesn't carry).
		 * Read failure or delete failure is logged but does NOT
		 * destroy the success — leaving an over-budget row surfaces
		 * as the over-limit warn in `listUserApiKeys` and the user
		 * can revoke it from the UI. The plaintext return below
		 * happens only after this check passes, preserving the
		 * plaintext-once contract for the failure branch. */
		const postCreateCount = await countUserApiKeys(session.user.id);
		if (postCreateCount > PER_USER_KEY_LIMIT) {
			const isLoser = await isOverLimitMintLoser(session.user.id, created.id);
			if (isLoser) {
				try {
					await getDb().collection("apikey").doc(created.id).delete();
					log.warn(
						"[settings/api-keys] mint race detected — over-limit row deleted",
						{
							userId: session.user.id,
							keyId: created.id,
							postCreateCount,
						},
					);
				} catch (delErr) {
					log.error("[settings/api-keys] mint race delete failed", delErr);
				}
				return {
					success: false,
					error: `You already have ${PER_USER_KEY_LIMIT} keys, the per-account limit. Revoke one before minting another.`,
				};
			}
			/* Else: I'm a winner of the race — keep my row, fall
			 * through to the success path below. The losers handle
			 * their own deletes. */
		}

		/* Build the success result FIRST, before any side-effect that
		 * can throw. Audit logging, `revalidatePath`, and even
		 * `toISOString` (if the plugin's response shape ever drifts to
		 * an unexpected createdAt type) must not swallow a successful
		 * mint into the catch block — the row already exists hashed in
		 * Firestore, the plaintext is unrecoverable, and the user has
		 * burned a slot toward `PER_USER_KEY_LIMIT`. The two `toISOString`
		 * calls are bracketed here as part of the success-shape
		 * construction; the audit log and revalidate run in their own
		 * try/catch below. */
		if (!created.start) {
			/* Symmetric with `lib/db/api-keys.ts::listUserApiKeys` —
			 * `startingCharactersConfig.shouldStore: true` makes `start`
			 * unconditional in production, so a missing value is a
			 * plugin regression worth surfacing. Coalesce to `""` so the
			 * UI's `displayPrefix &&` guard hides the empty chip. */
			log.warn("[settings/api-keys] mint response missing `start`", {
				userId: session.user.id,
				keyId: created.id,
			});
		}
		const result: MintApiKeyResult = {
			success: true,
			key: created.key,
			keyId: created.id,
			displayPrefix: created.start ?? "",
			/* `toISOString` / `toISOStringOrNull` from `lib/db/api-keys`
			 * handle both `Date` and Firestore `Timestamp` — the plugin
			 * may surface either depending on adapter round-trip path.
			 * `new Date(timestamp)` would silently produce "Invalid
			 * Date" and the subsequent `.toISOString()` would throw. */
			createdAt: toISOString(created.createdAt),
			expiresAt: toISOStringOrNull(created.expiresAt),
		};

		try {
			log.info("[settings/api-keys] minted", {
				userId: session.user.id,
				keyId: created.id,
				scopes: scopeCheck.scopes,
				expiry: input.expiry,
				ip: await callerIp(),
			});
			revalidatePath("/settings");
		} catch (err) {
			/* A failure here means the user has the key (we're returning
			 * the success result regardless) but the audit log or cache
			 * revalidation didn't land. Surface to Cloud Logging so
			 * persistent breakage gets investigated; never let it
			 * destroy the plaintext-once contract. */
			log.error("[settings/api-keys] post-mint side-effect failed", err);
		}

		return result;
	} catch (err) {
		log.error("[settings/api-keys] mint error", err);
		return {
			success: false,
			error: pluginErrorMessage(
				err,
				"Could not mint the key. Try again in a moment.",
			),
		};
	}
}

/**
 * Revoke an API key.
 *
 * The plugin's `/api-key/delete` endpoint mounts `sessionMiddleware`,
 * which means the typed `auth.api.deleteApiKey` call requires the
 * caller's session — passing `headers` is structural, not stylistic.
 * Mint and edit run in server-only mode (no headers, explicit
 * `userId` in body) because their endpoints accept `permissions` and
 * the plugin rejects `permissions` whenever `ctx.headers` is present.
 * Delete has neither concern: no `permissions` field on the body
 * schema, and the endpoint hard-requires a session. The asymmetry
 * with the other two actions tracks plugin endpoint shape, nothing
 * else.
 *
 * Idempotent on already-deleted rows: the plugin's delete handler
 * throws `KEY_NOT_FOUND` for both "no such key" and
 * "row exists but `referenceId !== session.user.id`" — same code,
 * deliberate collapse to avoid leaking key-existence to non-owners
 * (see the throws inside
 * `node_modules/@better-auth/api-key/dist/index.mjs::deleteApiKey`).
 * We mirror that collapse in the UI: the row is gone from the user's
 * perspective whether they already revoked it, never owned it, or
 * it never existed. The `log.warn` audit line in the catch
 * preserves the not-owned signal for ops without leaking it on the
 * wire.
 */
export async function revokeApiKey(keyId: string): Promise<RevokeApiKeyResult> {
	const session = await getSession();
	if (!session) {
		return { success: false, error: "Sign in first to revoke an API key." };
	}
	if (!(await isAuthorizedSession(session.user.id, "revoke"))) {
		return { success: false, error: "Sign in first to revoke an API key." };
	}
	if (!isValidKeyId(keyId)) {
		return { success: false, error: "Missing key identifier." };
	}

	try {
		const auth = await getAuth();
		const reqHeaders = await headers();
		await auth.api.deleteApiKey({
			body: { keyId },
			headers: reqHeaders,
		});

		log.info("[settings/api-keys] revoked", {
			userId: session.user.id,
			keyId,
			ip: await callerIp(),
		});

		revalidatePath("/settings");
		return { success: true };
	} catch (err) {
		/* `KEY_NOT_FOUND` is idempotent-success for revoke — see the
		 * function docblock for the missing/not-owned collapse. The
		 * audit-log line preserves the signal that would otherwise be
		 * lost: "user attempted to revoke a key id they don't own" is
		 * operationally interesting (suggests a UI regression or a
		 * misbehaving client), even though the wire response is
		 * deliberately the same as "user revoked their own key". */
		if (readPluginErrorCode(err) === "KEY_NOT_FOUND") {
			log.warn("[settings/api-keys] revoke: key not available", {
				userId: session.user.id,
				keyId,
			});
			revalidatePath("/settings");
			return { success: true };
		}
		log.error("[settings/api-keys] revoke error", err);
		return {
			success: false,
			error: pluginErrorMessage(
				err,
				"Could not revoke the key. Try again in a moment.",
			),
		};
	}
}

/**
 * Update the granted scope set on an existing key. The plaintext key
 * value is unchanged — only `permissions.scope` is rewritten. Same
 * floor-scope rule as mint: read + write are always required.
 */
export async function editApiKeyScopes(
	keyId: string,
	scopes: readonly string[],
): Promise<EditApiKeyScopesResult> {
	const session = await getSession();
	if (!session) {
		return { success: false, error: "Sign in first to edit an API key." };
	}
	if (!(await isAuthorizedSession(session.user.id, "edit"))) {
		return { success: false, error: "Sign in first to edit an API key." };
	}
	if (!isValidKeyId(keyId)) {
		return { success: false, error: "Missing key identifier." };
	}

	const scopeCheck = validateScopes(scopes ?? []);
	if (!scopeCheck.ok) {
		return { success: false, error: scopeCheck.error };
	}

	try {
		const auth = await getAuth();
		/* Server-only mode (same rationale as `mintApiKey`): omit
		 * `headers` so the plugin's `authRequired` flag stays false and
		 * the `permissions` field isn't rejected as a server-only
		 * property. Pass `userId` explicitly so the plugin can resolve
		 * the caller without a session.
		 *
		 * Ownership model: in server-only mode the plugin's update
		 * handler authenticates from `body.userId` (no session to
		 * cross-check), then verifies `apiKey.referenceId === user.id`
		 * — which compares against the value we passed. The check is
		 * tautologically true unless `referenceId` belongs to a
		 * different user, in which case it throws `KEY_NOT_FOUND` (the
		 * non-leaking missing-vs-not-owned collapse). The actual auth
		 * gate is therefore `getSession()` returning the right user
		 * above; everything below trusts that. The catch block
		 * translates `KEY_NOT_FOUND` to a single non-leaky message and
		 * a `log.warn` audit line. */
		await auth.api.updateApiKey({
			body: {
				keyId,
				permissions: { scope: scopeCheck.scopes },
				userId: session.user.id,
			},
		});

		log.info("[settings/api-keys] scopes edited", {
			userId: session.user.id,
			keyId,
			scopes: scopeCheck.scopes,
			ip: await callerIp(),
		});

		revalidatePath("/settings");
		return { success: true };
	} catch (err) {
		/* Same audit-log signal as the revoke path — preserves the
		 * "user tried to edit a key they don't own" diagnostic that the
		 * non-leaking wire response collapses. */
		if (readPluginErrorCode(err) === "KEY_NOT_FOUND") {
			log.warn("[settings/api-keys] edit: key not available", {
				userId: session.user.id,
				keyId,
			});
		} else {
			log.error("[settings/api-keys] edit error", err);
		}
		return {
			success: false,
			error: pluginErrorMessage(
				err,
				"Could not update the key. Try again in a moment.",
			),
		};
	}
}
