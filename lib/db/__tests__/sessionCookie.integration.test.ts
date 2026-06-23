/**
 * Session-cookie contract test, against a real Firestore emulator.
 *
 * This is the auth-boundary guard. Every production login outage we've shipped
 * lived at the dependency seam between Better Auth, the community
 * `better-auth-firestore` adapter (peer-ranged `"*"`, so a major bump silently
 * satisfies it), and `better-call`'s cookie signing. None of those are covered
 * by the unit suite, which mocks `auth.api.*` at the boundary.
 *
 * It pins the exact thing the Playwright smoke suite (and the documented
 * "mint a cookie from a Firestore session row" recipe) depends on: a cookie
 * forged by `e2e/lib/session.ts::signSessionCookie` is accepted by
 * `auth.api.getSession` running on the SAME adapter stack production uses
 * (`withCompleteFirestoreAdapter(firestoreAdapter(...))`). If a better-auth /
 * better-call / adapter bump changes session lookup or cookie signing, this
 * fails loudly here — not silently in prod and not deep inside a Playwright
 * timeout.
 *
 * Auto-skipped when `FIRESTORE_EMULATOR_HOST` is unset. In CI the
 * `auth-contract` job (`.github/workflows/ci.yml`) boots the Firestore emulator
 * and runs exactly this file, so the gate is live on every PR; locally it runs
 * under `npm run test:integration`.
 */
import { betterAuth } from "better-auth";
import { firestoreAdapter } from "better-auth-firestore";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signSessionCookie } from "@/e2e/lib/session";
import { withCompleteFirestoreAdapter } from "@/lib/auth-firestore-adapter";
import { firestoreClientOptions } from "@/lib/db/firestoreClientOptions";

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const TEST_PROJECT_ID = "demo-test";
const TEST_SECRET = "x".repeat(32);
const TEST_USER_ID = "session-contract-user";
const SESSION_COOKIE = "better-auth.session_token";

/** Mirror of the production collection map (`lib/auth.ts::authCollections`). */
const COLLECTIONS = {
	users: "auth_users",
	sessions: "auth_sessions",
	accounts: "auth_accounts",
	verificationTokens: "auth_verifications",
};

const COLLECTIONS_TO_CLEAR = ["auth_users", "auth_sessions"] as const;

async function clearCollections(db: Firestore): Promise<void> {
	for (const name of COLLECTIONS_TO_CLEAR) {
		const snap = await db.collection(name).get();
		await Promise.all(snap.docs.map((d) => d.ref.delete()));
	}
}

/**
 * Build a Better Auth instance over the SAME adapter stack production wires up
 * — the complete-adapter wrapper around the community firestore adapter — so
 * the session read path under test is the real one.
 */
function createTestAuth(db: Firestore) {
	return betterAuth({
		secret: TEST_SECRET,
		baseURL: "http://localhost:3000",
		database: withCompleteFirestoreAdapter(
			firestoreAdapter({ firestore: db, collections: COLLECTIONS }),
			db,
			COLLECTIONS,
		),
	});
}

function cookieHeader(value: string): Headers {
	return new Headers({ cookie: `${SESSION_COOKIE}=${value}` });
}

describe.skipIf(!emulatorAvailable)("session-cookie contract", () => {
	let auth: ReturnType<typeof createTestAuth>;
	let db: Firestore;

	beforeAll(() => {
		initializeApp({ projectId: TEST_PROJECT_ID });
		// Same options as the production clients — gRPC against the emulator, so
		// no ADC is needed and this runs credential-free in CI.
		db = new Firestore({
			projectId: TEST_PROJECT_ID,
			...firestoreClientOptions(),
		});
		auth = createTestAuth(db);
	});

	afterAll(async () => {
		for (const app of getApps()) {
			await deleteApp(app);
		}
	});

	beforeEach(async () => {
		await clearCollections(db);
		await db.collection("auth_users").doc(TEST_USER_ID).set({
			id: TEST_USER_ID,
			email: "session-contract@dimagi.com",
			emailVerified: true,
			name: "Session contract user",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
	});

	/** Write a live session row and return its (random) token. */
	async function seedSession(): Promise<string> {
		const token = `tok-${TEST_USER_ID}-${Date.now()}`;
		await db.collection("auth_sessions").add({
			token,
			userId: TEST_USER_ID,
			expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
			createdAt: new Date(),
			updatedAt: new Date(),
			ipAddress: "",
			userAgent: "contract-test",
		});
		return token;
	}

	it("accepts a cookie forged by signSessionCookie() and returns the user", async () => {
		const token = await seedSession();
		const cookie = signSessionCookie(token, TEST_SECRET);

		const session = await auth.api.getSession({
			headers: cookieHeader(cookie),
		});

		expect(session).not.toBeNull();
		expect(session?.user.id).toBe(TEST_USER_ID);
		expect(session?.user.email).toBe("session-contract@dimagi.com");
	});

	it("rejects a cookie signed with the wrong secret (signature is verified)", async () => {
		const token = await seedSession();
		const forged = signSessionCookie(token, "not-the-server-secret");

		const session = await auth.api.getSession({
			headers: cookieHeader(forged),
		});

		expect(session).toBeNull();
	});

	it("rejects an expired session row", async () => {
		const token = `tok-expired-${Date.now()}`;
		await db.collection("auth_sessions").add({
			token,
			userId: TEST_USER_ID,
			expiresAt: new Date(Date.now() - 60_000),
			createdAt: new Date(),
			updatedAt: new Date(),
			ipAddress: "",
			userAgent: "contract-test",
		});

		const session = await auth.api.getSession({
			headers: cookieHeader(signSessionCookie(token, TEST_SECRET)),
		});

		expect(session).toBeNull();
	});
});
