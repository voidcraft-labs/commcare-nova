/**
 * Integration test for the one-shot Firestore→Postgres auth copy
 * (`lib/auth/migrate-data.ts`) against a real Firestore emulator + the Postgres
 * testcontainer. This pins the cutover's structural contracts — the ones a unit
 * test with mocked stores can't, and exactly where the review found a
 * deploy-blocker: IDs preserved verbatim, `sessionId` nulled (sessions are
 * skipped, but the column FKs the empty auth_session table), FK-orphan rows
 * skipped instead of aborting the copy, jsonb `scopes` decoded to real arrays,
 * and the empty-`auth_user` guard.
 *
 * Emulator-gated (run via `npm run test:integration`); the Postgres half uses
 * the per-test-database harness. The copy reads the emulator through its own
 * Firestore client (routed by FIRESTORE_EMULATOR_HOST); we seed the same
 * emulator and assert the Postgres side through the typed `Kysely<AuthDatabase>`.
 */

import { Firestore, Timestamp } from "@google-cloud/firestore";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __setAuthDbForTests, type AuthDatabase } from "@/lib/auth/db";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { copyAuthDataFromFirestore } from "@/lib/auth/migrate-data";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { firestoreClientOptions } from "@/lib/db/firestoreClientOptions";

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const TEST_PROJECT_ID = "demo-test";

const SOURCE_COLLECTIONS = [
	"auth_users",
	"oauthClient",
	"auth_accounts",
	"apikey",
	"oauthConsent",
	"oauthRefreshToken",
	"oauthGrantRevocation",
	"jwks",
] as const;

const dbHandle = setupPerTestDatabase({ databaseNamePrefix: "auth_copy_" });

describe.skipIf(!emulatorAvailable)(
	"auth data copy (Firestore → Postgres)",
	() => {
		let fs: Firestore;
		let authDb: Kysely<AuthDatabase>;

		beforeAll(() => {
			fs = new Firestore({
				projectId: TEST_PROJECT_ID,
				...firestoreClientOptions(),
			});
		});

		afterAll(async () => {
			await fs.terminate();
		});

		beforeEach(async () => {
			const { runMigrations } = await getMigrations(
				authMigrateOptions(dbHandle.pool),
			);
			await runMigrations();
			await runAuthAppMigrations(dbHandle.db);
			authDb = new Kysely<AuthDatabase>({
				dialect: new PostgresDialect({
					pool: dbHandle.pool as unknown as PostgresPool,
				}),
			});
			__setAuthDbForTests(authDb);
			for (const name of SOURCE_COLLECTIONS) {
				const snap = await fs.collection(name).get();
				await Promise.all(snap.docs.map((d) => d.ref.delete()));
			}
		});

		it("copies durable state — IDs preserved, sessionId nulled, FK orphans skipped, scopes as jsonb", async () => {
			const now = Timestamp.now();
			await fs.collection("auth_users").doc("u1").set({
				email: "a@dimagi.com",
				name: "A",
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			});
			await fs.collection("auth_users").doc("u2").set({
				email: "b@dimagi.com",
				name: "B",
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			});
			await fs
				.collection("oauthClient")
				.doc("c1")
				.set({
					clientId: "client-1",
					name: "C1",
					public: true,
					redirectUris: JSON.stringify(["https://x/cb"]),
					createdAt: now,
					updatedAt: now,
				});
			await fs.collection("auth_accounts").doc("acc1").set({
				accountId: "google-acc",
				providerId: "google",
				userId: "u1",
				createdAt: now,
				updatedAt: now,
			});
			await fs
				.collection("apikey")
				.doc("k1")
				.set({
					referenceId: "u1",
					configId: "cfg",
					key: "key-hash",
					name: "K1",
					permissions: JSON.stringify({ scope: ["nova.read"] }),
					createdAt: now,
					updatedAt: now,
				});
			// Valid consent (client + user exist) and an ORPHAN consent (clientId has
			// no client row → must be skipped, not abort the copy).
			await fs
				.collection("oauthConsent")
				.doc("con1")
				.set({
					clientId: "client-1",
					userId: "u1",
					scopes: JSON.stringify(["nova.read", "nova.write"]),
					createdAt: now,
					updatedAt: now,
				});
			await fs
				.collection("oauthConsent")
				.doc("orphan")
				.set({
					clientId: "ghost-client",
					userId: "u1",
					scopes: JSON.stringify(["nova.read"]),
					createdAt: now,
					updatedAt: now,
				});
			// Refresh token carrying a sessionId — sessions are skipped, so this MUST
			// be nulled or the sessionId→auth_session FK aborts the whole copy.
			await fs
				.collection("oauthRefreshToken")
				.doc("rt1")
				.set({
					token: "rt-hash",
					clientId: "client-1",
					userId: "u1",
					sessionId: "session-not-copied",
					scopes: JSON.stringify(["nova.read"]),
					expiresAt: now,
					createdAt: now,
				});
			await fs
				.collection("oauthGrantRevocation")
				.doc("grant-rev-deadbeef")
				.set({
					userId: "u1",
					clientId: "client-1",
					revokedAt: now,
				});
			await fs.collection("jwks").doc("j1").set({
				publicKey: "pub",
				privateKey: "priv",
				createdAt: now,
			});

			const result = await copyAuthDataFromFirestore(dbHandle.pool);
			expect(result.skipped).toBe(false);

			// IDs preserved verbatim.
			const users = await authDb
				.selectFrom("auth_user")
				.select("id")
				.orderBy("id")
				.execute();
			expect(users.map((u) => u.id)).toEqual(["u1", "u2"]);

			// The refresh token copied at all → its sessionId FK didn't fire (nulled).
			const tokens = await authDb
				.selectFrom("auth_oauth_refresh_token")
				.select("id")
				.execute();
			expect(tokens.map((t) => t.id)).toEqual(["rt1"]);

			// Orphan consent skipped; the valid one kept with jsonb scopes decoded.
			const consents = await authDb
				.selectFrom("auth_oauth_consent")
				.select(["id", "scopes"])
				.execute();
			expect(consents).toHaveLength(1);
			expect(consents[0]?.id).toBe("con1");
			expect(consents[0]?.scopes).toEqual(["nova.read", "nova.write"]);

			// Per-table summary reflects the skipped orphan.
			const consentSummary = result.perTable.find(
				(t) => t.table === "auth_oauth_consent",
			);
			expect(consentSummary).toEqual({
				table: "auth_oauth_consent",
				read: 2,
				inserted: 1,
			});

			// Account + api-key + jwks + grant-revocation all landed.
			const apiKeys = await authDb
				.selectFrom("auth_apikey")
				.select("id")
				.execute();
			expect(apiKeys.map((k) => k.id)).toEqual(["k1"]);
			const grants = await authDb
				.selectFrom("auth_oauth_grant_revocation")
				.select(["userId", "clientId"])
				.execute();
			expect(grants).toEqual([{ userId: "u1", clientId: "client-1" }]);
		});

		it("is a no-op when auth_user is already populated (the one-shot guard)", async () => {
			const ctx = await betterAuth(authMigrateOptions(dbHandle.pool)).$context;
			await ctx.adapter.create({
				model: "user",
				forceAllowId: true,
				data: {
					id: "existing",
					name: "x",
					email: "x@dimagi.com",
					emailVerified: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
			await fs.collection("auth_users").doc("would-copy").set({
				email: "y@dimagi.com",
				name: "Y",
				emailVerified: true,
				createdAt: Timestamp.now(),
				updatedAt: Timestamp.now(),
			});

			const result = await copyAuthDataFromFirestore(dbHandle.pool);
			expect(result.skipped).toBe(true);

			const ids = await authDb.selectFrom("auth_user").select("id").execute();
			expect(ids.map((u) => u.id)).toEqual(["existing"]);
		});
	},
);
