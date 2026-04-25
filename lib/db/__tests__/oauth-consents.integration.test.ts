/**
 * Integration tests for `lib/db/oauth-consents.ts` against a real
 * Firestore emulator. The unit suite mocks the SDK; the test author
 * controls both sides of the comparison there, so a schema-boundary
 * bug (e.g. querying the wrong field name) can't fail it. This file
 * runs the actual `@better-auth/oauth-provider` plugin and reads back
 * through our helpers, so field-name drift between the plugin's
 * Firestore schema and our queries fails loudly.
 *
 * Auto-skipped when `FIRESTORE_EMULATOR_HOST` is unset — run via
 * `npm run test:integration`.
 */

import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { firestoreAdapter } from "better-auth-firestore";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

/**
 * `demo-` prefix tells the Firebase tools to skip credential
 * resolution — without it the SDK would try to authenticate against
 * real GCP.
 */
const TEST_PROJECT_ID = "demo-test";

/** Collections this test populates and clears between cases. */
const PLUGIN_COLLECTIONS = [
	"oauthClient",
	"oauthConsent",
	"oauthRefreshToken",
] as const;

/** Wipe plugin collections between tests to keep cases independent. */
async function clearPluginCollections(db: Firestore): Promise<void> {
	for (const name of PLUGIN_COLLECTIONS) {
		const snap = await db.collection(name).get();
		await Promise.all(snap.docs.map((d) => d.ref.delete()));
	}
}

/**
 * Factored out (rather than declared inline in `beforeAll`) so the
 * inferred return type carries plugin augmentations like
 * `auth.api.registerOAuthClient` — inline declaration would widen back
 * to default `BetterAuthOptions`. Mirrors `lib/auth.ts` so the schema
 * the plugin writes here is the schema production also writes.
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
			/* `jwt` is a hard dependency of `oauthProvider` — provides
			 * the JWKS the AS signs access tokens with. */
			jwt({ disableSettingJwtHeader: true }),
			oauthProvider({
				loginPage: "/",
				consentPage: "/consent",
				validAudiences: ["http://localhost:3000/api/mcp"],
				scopes: ["openid", "profile", "email", "nova.read", "nova.write"],
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				clientRegistrationDefaultScopes: ["nova.read", "nova.write"],
			}),
		],
	});
}

// ── Suite ───────────────────────────────────────────────────────────

describe.skipIf(!emulatorAvailable)("oauth-consents integration", () => {
	let auth: ReturnType<typeof createTestAuth>;
	let db: Firestore;

	beforeAll(() => {
		initializeApp({ projectId: TEST_PROJECT_ID });
		db = new Firestore({ projectId: TEST_PROJECT_ID, preferRest: true });
		auth = createTestAuth(db);
	});

	afterAll(async () => {
		/* Avoid `[DEFAULT]` app accumulation across test files. */
		for (const app of getApps()) {
			await deleteApp(app);
		}
	});

	beforeEach(async () => {
		await clearPluginCollections(db);
	});

	// ── listAuthorizedClients ──────────────────────────────────────

	it("returns the real client_name written by the plugin (the bug-catching test)", async () => {
		/* Register a client via the plugin's actual DCR endpoint. This
		 * is the test's whole point — the plugin writes `oauthClient`
		 * docs with whatever field names its schema declares, and the
		 * unit suite cannot verify those names because the unit mocks
		 * are author-controlled. Here the plugin is the author. */
		const created = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				client_name: "Claude Code",
				token_endpoint_auth_method: "none",
			},
		});

		expect(created.client_id).toBeTruthy();
		const clientId = created.client_id;

		/* Insert through the plugin's own adapter so the write lands in
		 * the same on-disk shape a real /authorize consent would. */
		const ctx = await auth.$context;
		await ctx.adapter.create({
			model: "oauthConsent",
			data: {
				clientId,
				userId: "user-test-1",
				scopes: ["nova.read", "nova.write"],
				createdAt: new Date("2026-04-20T12:00:00.000Z"),
				updatedAt: new Date("2026-04-20T12:00:00.000Z"),
			},
		});

		const { listAuthorizedClients } = await import("../oauth-consents");
		const rows = await listAuthorizedClients("user-test-1");

		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(row.clientId).toBe(clientId);
		/* Pins the plugin's storage field names (`clientId`, `name`)
		 * against our reads. A regression to the RFC 7591 wire names
		 * (`client_id`, `client_name`) trips here, not in production. */
		expect(row.clientName).toBe("Claude Code");
		expect(row.scopes).toEqual(["nova.read", "nova.write"]);
		expect(row.authorizedAt).toBe("2026-04-20T12:00:00.000Z");
	});

	it("falls back to 'An application' when the registered client has no client_name", async () => {
		const created = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				/* No client_name — the registration succeeds and the
				 * plugin writes a client doc with no `name` field. */
				token_endpoint_auth_method: "none",
			},
		});

		const ctx = await auth.$context;
		await ctx.adapter.create({
			model: "oauthConsent",
			data: {
				clientId: created.client_id,
				userId: "user-test-1",
				scopes: ["nova.read"],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});

		const { listAuthorizedClients } = await import("../oauth-consents");
		const rows = await listAuthorizedClients("user-test-1");

		expect(rows).toHaveLength(1);
		expect(rows[0].clientName).toBe("An application");
	});

	it("does not leak other users' consents", async () => {
		const created = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				client_name: "Claude Code",
				token_endpoint_auth_method: "none",
			},
		});

		const ctx = await auth.$context;
		/* Two consents — one for our user, one for a different user. */
		await ctx.adapter.create({
			model: "oauthConsent",
			data: {
				clientId: created.client_id,
				userId: "user-test-1",
				scopes: ["nova.read"],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		await ctx.adapter.create({
			model: "oauthConsent",
			data: {
				clientId: created.client_id,
				userId: "user-other",
				scopes: ["nova.read"],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});

		const { listAuthorizedClients } = await import("../oauth-consents");
		const rows = await listAuthorizedClients("user-test-1");

		expect(rows).toHaveLength(1);
	});

	// ── hasActiveConsent ───────────────────────────────────────────

	it("returns false when no consent exists", async () => {
		const { hasActiveConsent } = await import("../oauth-consents");
		const result = await hasActiveConsent("user-test-1", "client-not-here");
		expect(result).toBe(false);
	});

	it("returns true when (userId, clientId) matches", async () => {
		const created = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				client_name: "Claude Code",
				token_endpoint_auth_method: "none",
			},
		});

		const ctx = await auth.$context;
		await ctx.adapter.create({
			model: "oauthConsent",
			data: {
				clientId: created.client_id,
				userId: "user-test-1",
				scopes: ["nova.read", "nova.write"],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});

		const { hasActiveConsent } = await import("../oauth-consents");
		const result = await hasActiveConsent("user-test-1", created.client_id);

		expect(result).toBe(true);
	});

	// ── revokeAuthorizedClient ─────────────────────────────────────

	it("deletes the consent and revokes refresh tokens atomically", async () => {
		const created = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				client_name: "Claude Code",
				token_endpoint_auth_method: "none",
			},
		});

		const ctx = await auth.$context;

		const consent = (await ctx.adapter.create({
			model: "oauthConsent",
			data: {
				clientId: created.client_id,
				userId: "user-test-1",
				scopes: ["nova.read", "nova.write"],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		})) as { id: string };

		/* Two refresh tokens: a live one (should be marked revoked) and
		 * one already revoked (should be left alone, no redundant write). */
		await ctx.adapter.create({
			model: "oauthRefreshToken",
			data: {
				token: "live-token",
				clientId: created.client_id,
				sessionId: "sess-1",
				userId: "user-test-1",
				expiresAt: new Date(Date.now() + 86400_000),
				createdAt: new Date(),
				scopes: ["nova.read"],
			},
		});
		const alreadyRevokedAt = new Date("2026-04-01T00:00:00.000Z");
		await ctx.adapter.create({
			model: "oauthRefreshToken",
			data: {
				token: "stale-token",
				clientId: created.client_id,
				sessionId: "sess-2",
				userId: "user-test-1",
				expiresAt: new Date(Date.now() + 86400_000),
				createdAt: new Date(),
				revoked: alreadyRevokedAt,
				scopes: ["nova.read"],
			},
		});

		const { revokeAuthorizedClient } = await import("../oauth-consents");
		await revokeAuthorizedClient("user-test-1", consent.id);

		/* Consent doc gone. */
		const consentSnap = await db
			.collection("oauthConsent")
			.doc(consent.id)
			.get();
		expect(consentSnap.exists).toBe(false);

		const tokensSnap = await db
			.collection("oauthRefreshToken")
			.where("userId", "==", "user-test-1")
			.where("clientId", "==", created.client_id)
			.get();

		const tokensByName = new Map<string, FirebaseFirestore.DocumentData>();
		for (const d of tokensSnap.docs) {
			tokensByName.set(d.data().token as string, d.data());
		}

		expect(tokensByName.get("live-token")?.revoked).toBeDefined();

		/* Already-revoked stays at its original timestamp — a rewrite
		 * would replace it with a `serverTimestamp()` sentinel. */
		const stale = tokensByName.get("stale-token");
		expect(stale?.revoked).toBeDefined();
		const staleRevoked =
			stale?.revoked instanceof Date
				? stale.revoked
				: (stale?.revoked as { toDate: () => Date }).toDate();
		expect(staleRevoked.getTime()).toBe(alreadyRevokedAt.getTime());
	});

	it("rejects when the consent belongs to a different user", async () => {
		const ctx = await auth.$context;
		const consent = (await ctx.adapter.create({
			model: "oauthConsent",
			data: {
				clientId: "client-A",
				userId: "user-other",
				scopes: ["nova.read"],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		})) as { id: string };

		const { revokeAuthorizedClient } = await import("../oauth-consents");
		await expect(
			revokeAuthorizedClient("user-test-1", consent.id),
		).rejects.toThrow(/does not belong to this user/);
	});
});
