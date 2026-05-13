/**
 * Integration tests for the api-key auth path against a real Firestore
 * emulator. The unit suite mocks `auth.api.{createApiKey, verifyApiKey,
 * deleteApiKey, updateApiKey}` at the boundary; the test author
 * controls both sides of those mocks, so a schema-boundary bug (a
 * field rename in the plugin, a Zod-validation rule we forgot, the
 * `SERVER_ONLY_PROPERTY` rejection of `permissions` when headers are
 * passed) can't fail it. This file runs the actual
 * `@better-auth/api-key` plugin and reads back through our helpers,
 * so plugin-API drift fails loudly here instead of silently in
 * production.
 *
 * What this proves that the unit tests can't:
 *   - The full mint → verify → revoke round-trip works end-to-end
 *     against the plugin's actual schema. A future plugin version
 *     that renames `userId` to `principalId` or adds a required
 *     field would trip mint here.
 *   - `permissions` is accepted in server-only mode (no `headers` arg
 *     to `auth.api.createApiKey`) — the regression risk this defends
 *     against is a future Server Action refactor that adds back the
 *     `headers` arg and silently fails with `SERVER_ONLY_PROPERTY`.
 *   - The `verifyApiKey` response shape carries `referenceId` and
 *     decoded `permissions.scope` exactly as the route's
 *     `handleApiKeyMcp` consumes them.
 *   - `lib/db/api-keys.ts::listUserApiKeys` reads what the plugin
 *     writes — pins the plugin's storage field names (`referenceId`,
 *     `permissions` as JSON-stringified, `start`) against our direct-
 *     Firestore decoder.
 *
 * Auto-skipped when `FIRESTORE_EMULATOR_HOST` is unset — run via
 * `npm run test:integration`.
 */

import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { firestoreAdapter } from "better-auth-firestore";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NOVA_API_KEY_PREFIX } from "@/lib/auth-public";

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const TEST_PROJECT_ID = "demo-test";
const TEST_USER_ID = "user-integration-test";

/** Collections this test populates and clears between cases. */
const COLLECTIONS_TO_CLEAR = ["apikey", "auth_users"] as const;

async function clearCollections(db: Firestore): Promise<void> {
	for (const name of COLLECTIONS_TO_CLEAR) {
		const snap = await db.collection(name).get();
		await Promise.all(snap.docs.map((d) => d.ref.delete()));
	}
}

/**
 * Mirrors the api-key plugin config in `lib/auth.ts`. Factored out
 * (rather than declared inline in `beforeAll`) so the inferred return
 * type carries plugin augmentations like `auth.api.createApiKey` —
 * inline declaration would widen back to default `BetterAuthOptions`.
 */
function createTestAuth(db: Firestore) {
	return betterAuth({
		secret: "x".repeat(32),
		baseURL: "http://localhost:3000",
		database: firestoreAdapter({
			firestore: db,
			collections: {
				users: "auth_users",
				sessions: "auth_sessions",
				accounts: "auth_accounts",
				verificationTokens: "auth_verifications",
			},
		}),
		plugins: [
			jwt({ disableSettingJwtHeader: true }),
			apiKey({
				defaultPrefix: NOVA_API_KEY_PREFIX,
				defaultKeyLength: 32,
				startingCharactersConfig: {
					shouldStore: true,
					charactersLength: NOVA_API_KEY_PREFIX.length + 6,
				},
				requireName: true,
				enableMetadata: false,
				enableSessionForAPIKeys: false,
				storage: "database",
				/* Mirror production: per-key rate limiting disabled. The
				 * plugin's `isRateLimited` algorithm is fixed-window-since-
				 * last-request, which doesn't deliver a meaningful per-hour
				 * cap, so the production mount sets `enabled: false`. The
				 * integration test must run against the production-shape
				 * config to detect plugin regressions on the path Nova
				 * actually exercises. */
				rateLimit: { enabled: false },
				keyExpiration: {
					defaultExpiresIn: 365 * 24 * 60 * 60,
					minExpiresIn: 1,
					maxExpiresIn: 36500,
				},
				references: "user",
			}),
		],
	});
}

describe.skipIf(!emulatorAvailable)("api-key integration", () => {
	let auth: ReturnType<typeof createTestAuth>;
	let db: Firestore;

	beforeAll(() => {
		initializeApp({ projectId: TEST_PROJECT_ID });
		db = new Firestore({ projectId: TEST_PROJECT_ID, preferRest: true });
		auth = createTestAuth(db);
	});

	afterAll(async () => {
		for (const app of getApps()) {
			await deleteApp(app);
		}
	});

	beforeEach(async () => {
		await clearCollections(db);
		/* Seed the auth user the keys reference so `isUserActive` reads
		 * a real row. Without this, every key would resolve as
		 * "user disabled" when the route verifies. */
		await db.collection("auth_users").doc(TEST_USER_ID).set({
			id: TEST_USER_ID,
			email: "user@dimagi.com",
			emailVerified: true,
			name: "Integration test user",
			banned: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
	});

	it("mint + verify round-trip works against the real plugin (server-only mode)", async () => {
		/* Mint in server-only mode (no headers, explicit userId) — the
		 * exact shape `mintApiKey` Server Action uses. If the plugin
		 * ever rejects this combination, the test fails loudly here
		 * instead of silently in production.
		 *
		 * Delete is exercised separately at the adapter layer rather
		 * than via `auth.api.deleteApiKey` — that endpoint mounts
		 * `sessionMiddleware`, which expects a real cookie-bearing
		 * request. Production routes through that middleware via
		 * forwarded headers; the integration test has no session to
		 * forward, so we sidestep with the adapter and assert the
		 * effect (row gone). */
		const created = await auth.api.createApiKey({
			body: {
				name: "integration test key",
				expiresIn: 365 * 24 * 60 * 60,
				permissions: { scope: ["nova.read", "nova.write"] },
				userId: TEST_USER_ID,
			},
		});

		expect(created.id).toBeTruthy();
		expect(created.key).toMatch(new RegExp(`^${NOVA_API_KEY_PREFIX}`));
		expect(created.start).toMatch(new RegExp(`^${NOVA_API_KEY_PREFIX}`));

		/* Pin the key-row id shape: Better Auth's adapter factory
		 * injects `data.id = generateId()` (32-char alphanumeric) via
		 * `transformInput` BEFORE the firestore adapter's `create`
		 * runs, and `firestoreAdapter` honors the supplied id (its
		 * `col.doc()` auto-id branch is the fallback that fires only
		 * when no id is supplied). The Server Actions'
		 * `BETTER_AUTH_ID_PATTERN = /^[a-zA-Z0-9]{32}$/` regex
		 * accepts that exact shape, so revoke/edit on a real-minted
		 * key must pass validation. If a future plugin/adapter
		 * version emits a different id shape (Firestore auto-id, UUID,
		 * etc.), this assertion fails loudly here, BEFORE the regex
		 * starts rejecting real keys in production. */
		expect(created.id).toMatch(/^[a-zA-Z0-9]{32}$/);

		/* Permissions round-trip: what we sent should be what the
		 * verify response surfaces (decoded back from the plugin's
		 * manual JSON.stringify on write + safeJSONParse on read). */
		const verified = await auth.api.verifyApiKey({
			body: { key: created.key },
		});
		expect(verified.valid).toBe(true);
		expect(verified.error).toBeNull();
		expect(verified.key?.referenceId).toBe(TEST_USER_ID);
		expect(verified.key?.permissions).toEqual({
			scope: ["nova.read", "nova.write"],
		});

		/* Direct-Firestore read via the public helper — pins our decoder
		 * against the plugin's actual storage shape. A regression in
		 * `decodePermissions` (or in the plugin's stringify path)
		 * surfaces here. */
		const { listUserApiKeys } = await import("../api-keys");
		const rows = await listUserApiKeys(TEST_USER_ID);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			keyId: created.id,
			name: "integration test key",
			scopes: ["nova.read", "nova.write"],
		});
		expect(rows[0]?.displayPrefix).toBe(created.start);

		/* Direct adapter delete (sidestepping `sessionMiddleware`),
		 * then re-verify to confirm the row is gone. The plugin emits
		 * `INVALID_API_KEY` (not `KEY_NOT_FOUND`) for "no row matches
		 * the hashed bearer" — `KEY_NOT_FOUND` is reserved for paths
		 * where a row was located but downstream checks (permissions,
		 * org membership) failed. The route's `mapApiKeyErrorCode`
		 * collapses both into `"api key invalid"`, so the wire response
		 * is the same; this test pins the plugin-side semantics so a
		 * future code rename trips here. */
		await db.collection("apikey").doc(created.id).delete();
		const afterDelete = await auth.api.verifyApiKey({
			body: { key: created.key },
		});
		expect(afterDelete.valid).toBe(false);
		expect(afterDelete.error?.code).toBe("INVALID_API_KEY");
	});

	it("mintApiKey rejects `permissions` with SERVER_ONLY_PROPERTY when `headers` is passed", async () => {
		/* This is the regression test for the bug the unit suite can't
		 * catch: passing both `headers` and `permissions` makes the
		 * plugin's `isClientRequest` check fire and reject `permissions`
		 * as a server-only property. If the plugin ever softens this
		 * rule (or our config inadvertently disables it), the production
		 * Server Action's "no headers, explicit userId" pattern needs
		 * to be re-evaluated.
		 *
		 * Pin the specific error code (`SERVER_ONLY_PROPERTY`) so the
		 * test fails informatively if the plugin's check ordering
		 * shifts to a different rejection path (e.g.
		 * `UNAUTHORIZED_SESSION` from the headers + body.userId
		 * combination). The wire shape we depend on is specifically
		 * the property-level rejection, not the userId-level one. */
		await expect(
			auth.api.createApiKey({
				body: {
					name: "should-fail",
					expiresIn: 365 * 24 * 60 * 60,
					permissions: { scope: ["nova.read", "nova.write"] },
					userId: TEST_USER_ID,
				},
				headers: new Headers(),
			}),
		).rejects.toMatchObject({
			body: { code: "SERVER_ONLY_PROPERTY" },
		});
	});

	it("verifyApiKey returns `valid: false` for a stale / non-existent key", async () => {
		const result = await auth.api.verifyApiKey({
			body: { key: `${NOVA_API_KEY_PREFIX}nonexistent-key-value-here` },
		});

		expect(result.valid).toBe(false);
		expect(result.key).toBeNull();
		/* The plugin emits `INVALID_API_KEY` for "no row hashed matches
		 * the bearer." `KEY_NOT_FOUND` is reserved for downstream
		 * checks against a located row (permissions, org membership).
		 * Pin the actual emitted code here so a plugin-version bump
		 * that renames it surfaces in tests. The route's
		 * `mapApiKeyErrorCode` collapses both into "api key invalid"
		 * on the wire. */
		expect(result.error?.code).toBe("INVALID_API_KEY");
	});

	it("isUserActive returns true for an existing non-banned user, false for a banned user", async () => {
		const { isUserActive } = await import("../api-keys");

		expect(await isUserActive(TEST_USER_ID)).toBe(true);

		await db
			.collection("auth_users")
			.doc(TEST_USER_ID)
			.set({ banned: true }, { merge: true });

		expect(await isUserActive(TEST_USER_ID)).toBe(false);
	});

	it("isUserActive returns false for a missing user (deleted-account case)", async () => {
		const { isUserActive } = await import("../api-keys");

		expect(await isUserActive("user-that-was-deleted")).toBe(false);
	});
});
