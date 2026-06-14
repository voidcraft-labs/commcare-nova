/**
 * Unit tests for `app/(app)/settings/api-key-actions.ts`.
 *
 * Mocks: `getSession` (auth-utils), the api-keys db helpers, the
 * Better Auth `auth.api` surface, `next/headers`, and `next/cache`.
 * Tests assert the Server Actions' discriminated-union return shape
 * and the side-effects (audit logs, `revalidatePath`, plugin calls)
 * the production code is responsible for.
 */

import { APIError } from "better-auth/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ───────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
	type SessionShape = { user: { id: string; email: string } } | null;

	const getSession = vi.fn<() => Promise<SessionShape>>();
	const countUserApiKeys = vi.fn<(userId: string) => Promise<number>>();
	const isUserActive = vi.fn<(userId: string) => Promise<boolean>>();
	const createApiKey = vi.fn();
	const deleteApiKey = vi.fn();
	const updateApiKey = vi.fn();
	const revalidatePath = vi.fn();
	const headers = vi.fn(async () => new Headers());

	/** Stand-in for the Firestore admin client `getDb()` returns. The
	 *  default is "no rows for this user" — race-compensation tests
	 *  override `apikeyQuerySnapshot` to surface specific position
	 *  orderings. The doc-delete branch records every targeted id so
	 *  a test can assert which row was pruned. */
	type FakeDoc = { id: string; data: () => unknown };
	const apikeyQuerySnapshot = { docs: [] as FakeDoc[] };
	const apikeyDocDelete = vi.fn(async () => {});

	function fakeDb() {
		return {
			collection: (name: string) => {
				if (name !== "apikey") {
					throw new Error(`unexpected collection: ${name}`);
				}
				return {
					where: (_field: string, _op: string, _value: unknown) => ({
						get: async () => apikeyQuerySnapshot,
					}),
					doc: (_id: string) => ({ delete: apikeyDocDelete }),
				};
			},
		};
	}

	function reset() {
		getSession.mockReset();
		countUserApiKeys.mockReset();
		isUserActive.mockReset();
		/* Default to active — banned-user tests opt in by overriding. */
		isUserActive.mockResolvedValue(true);
		createApiKey.mockReset();
		deleteApiKey.mockReset();
		updateApiKey.mockReset();
		revalidatePath.mockReset();
		headers.mockReset();
		headers.mockImplementation(async () => new Headers());
		apikeyQuerySnapshot.docs = [];
		apikeyDocDelete.mockReset();
		apikeyDocDelete.mockImplementation(async () => {});
	}

	return {
		getSession,
		countUserApiKeys,
		isUserActive,
		createApiKey,
		deleteApiKey,
		updateApiKey,
		revalidatePath,
		headers,
		fakeDb,
		apikeyQuerySnapshot,
		apikeyDocDelete,
		reset,
	};
});

vi.mock("@/lib/auth-utils", async () => {
	/* `callerIpFromHeaders` is a pure helper — re-export the real
	 * implementation so the audit-log IP normalization is exercised
	 * end-to-end (any future test passing a fake Headers object with
	 * a real `x-forwarded-for` value gets the actual `isValidIP` /
	 * `normalizeIP` path). `getSession` stays mocked so test cases
	 * can drive the auth state. */
	const actual =
		await vi.importActual<typeof import("@/lib/auth-utils")>(
			"@/lib/auth-utils",
		);
	return {
		getSession: mocks.getSession,
		callerIpFromHeaders: actual.callerIpFromHeaders,
	};
});

vi.mock("@/lib/db/api-keys", async () => {
	/* `toISOString` / `toISOStringOrNull` are pure helpers — re-export
	 * the real implementations rather than mocking, so the date
	 * conversion is exercised end-to-end (and Timestamp / Date
	 * compatibility is preserved for any future test fixture using
	 * Firestore Timestamps). */
	const actual =
		await vi.importActual<typeof import("@/lib/db/api-keys")>(
			"@/lib/db/api-keys",
		);
	return {
		countUserApiKeys: mocks.countUserApiKeys,
		isUserActive: mocks.isUserActive,
		PER_USER_KEY_LIMIT: 10,
		toISOString: actual.toISOString,
		toISOStringOrNull: actual.toISOStringOrNull,
	};
});

vi.mock("@/lib/auth", () => ({
	getAuth: () => ({
		api: {
			createApiKey: mocks.createApiKey,
			deleteApiKey: mocks.deleteApiKey,
			updateApiKey: mocks.updateApiKey,
		},
	}),
}));

/* `lib/auth-public` is the client-safe seam — must be mocked
 * separately from `@/lib/auth` since they're different modules from
 * vitest's POV. */
vi.mock("@/lib/auth-public", () => ({
	NOVA_API_KEY_PREFIX: "sk-nova-v1-",
	NOVA_API_KEY_SCOPES: [
		"nova.read",
		"nova.write",
		"nova.hq.read",
		"nova.hq.write",
	],
	NOVA_MCP_FLOOR_SCOPES: ["nova.read", "nova.write"],
}));

vi.mock("next/cache", () => ({
	revalidatePath: mocks.revalidatePath,
}));

vi.mock("next/headers", () => ({
	headers: mocks.headers,
}));

/* `getDb` is the only `lib/db/firestore` surface the action reaches —
 * the race-compensation path reads sibling rows for position
 * resolution and may delete the just-minted row. The fake collection
 * record set is configured per-test via `mocks.apikeyQuerySnapshot`. */
vi.mock("@/lib/db/firestore", () => ({
	getDb: () => mocks.fakeDb(),
}));

/**
 * Realistic Better Auth-shaped key IDs for fixtures: 32 chars from
 * `[a-zA-Z0-9]`, matching `@better-auth/core/utils/id::generateId`'s
 * output. Toy short identifiers would now fail the action's
 * `isValidKeyId` shape check, defeating the test's intent.
 */
const KEY_ID_GENERIC = "abcdefghijklmnopqrstuvwxyz123456";
const KEY_ID_MINE = "a1b2c3d4e5f6g7h8i9j0K1L2M3N4O5P6";
const KEY_ID_GONE = "0000000000000000000000000000ffff";

// ── Test setup ──────────────────────────────────────────────────────

beforeEach(() => {
	mocks.reset();
});

const sessionUser = { id: "user-1", email: "user@example.com" };

// ── mintApiKey ──────────────────────────────────────────────────────

describe("mintApiKey", () => {
	it("refuses without a session", async () => {
		mocks.getSession.mockResolvedValue(null);

		const { mintApiKey } = await import("../api-key-actions");
		const result = await mintApiKey({
			name: "test",
			scopes: ["nova.read", "nova.write"],
			expiry: "1y",
		});

		expect(result).toEqual({
			success: false,
			error: expect.stringContaining("Sign in"),
		});
		expect(mocks.createApiKey).not.toHaveBeenCalled();
	});

	it("refuses when the session user is banned (defends against the cookie-cache TOCTOU)", async () => {
		/* Better Auth's cookie cache (5-minute maxAge) means
		 * `getSession()` can return a still-truthy session for a banned
		 * user during the cache window. The action's secondary
		 * `isUserActive` check is the live-revocation lock that closes
		 * that gap — same pattern as `requireAdminAccess`'s direct
		 * Firestore read. Mirrors the MCP route's `isUserActive`
		 * lookup so the two surfaces agree on "user can act." */
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.isUserActive.mockResolvedValue(false);

		const { mintApiKey } = await import("../api-key-actions");
		const result = await mintApiKey({
			name: "test",
			scopes: ["nova.read", "nova.write"],
			expiry: "1y",
		});

		expect(result).toMatchObject({ success: false });
		expect(mocks.createApiKey).not.toHaveBeenCalled();
	});

	it("rejects an empty name", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });

		const { mintApiKey } = await import("../api-key-actions");
		const result = await mintApiKey({
			name: "  ",
			scopes: ["nova.read", "nova.write"],
			expiry: "1y",
		});

		expect(result).toMatchObject({ success: false });
		expect(mocks.createApiKey).not.toHaveBeenCalled();
	});

	it("rejects unknown scope strings", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });

		const { mintApiKey } = await import("../api-key-actions");
		const result = await mintApiKey({
			name: "test",
			scopes: ["nova.read", "nova.write", "nova.admin"],
			expiry: "1y",
		});

		expect(result).toMatchObject({
			success: false,
			error: expect.stringContaining("nova.admin"),
		});
		expect(mocks.createApiKey).not.toHaveBeenCalled();
	});

	it("requires both floor scopes (nova.read + nova.write)", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });

		const { mintApiKey } = await import("../api-key-actions");
		const result = await mintApiKey({
			name: "test",
			scopes: ["nova.read"], // missing write
			expiry: "1y",
		});

		expect(result).toMatchObject({
			success: false,
			error: expect.stringContaining("read and write"),
		});
		expect(mocks.createApiKey).not.toHaveBeenCalled();
	});

	it("enforces the per-user 10-key limit", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.countUserApiKeys.mockResolvedValue(10);

		const { mintApiKey } = await import("../api-key-actions");
		const result = await mintApiKey({
			name: "test",
			scopes: ["nova.read", "nova.write"],
			expiry: "1y",
		});

		expect(result).toMatchObject({
			success: false,
			error: expect.stringContaining("10 keys"),
		});
		expect(mocks.createApiKey).not.toHaveBeenCalled();
	});

	it("compensating delete: when count→create races push the user over the limit, the loser row is deleted and the loser caller errors", async () => {
		/* Race scenario: the user has 9 rows. Two parallel mints
		 * both pass the pre-flight (count=9), both create, ending
		 * count=11. Each caller's compensating action reads the row
		 * set, sorts deterministically, and deletes only its own
		 * row when its position falls beyond the limit. This test
		 * stages the post-create state for the LOSER caller — the
		 * just-created row sits at position 10 (the 11th-newest),
		 * so the action must delete it and surface the limit error. */
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		/* Pre-flight returns 9 (under limit), post-create returns
		 * 11 (over limit by one). */
		mocks.countUserApiKeys.mockResolvedValueOnce(9).mockResolvedValueOnce(11);
		mocks.createApiKey.mockResolvedValue({
			id: KEY_ID_MINE,
			key: "sk-nova-v1-LOSER",
			start: "sk-nova-v1-LSE",
			createdAt: new Date("2026-04-22T12:00:00.500Z"),
			expiresAt: new Date("2027-04-22T12:00:00.000Z"),
		});
		/* Snapshot the user's apikey rows in the order Firestore
		 * would surface them. Newer rows have later `createdAt`;
		 * the just-minted (`KEY_ID_MINE`) is the LATER of the two
		 * race winners, putting it at position 10 — the loser slot. */
		const baseTime = new Date("2026-04-22T11:00:00.000Z").getTime();
		mocks.apikeyQuerySnapshot.docs = Array.from({ length: 9 }, (_, i) => ({
			id: `0000000000000000000000000000000${i.toString().padStart(2, "0")}`.slice(
				-32,
			),
			data: () => ({ createdAt: new Date(baseTime + i * 1000) }),
		}))
			.concat([
				{
					id: "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
					data: () => ({
						createdAt: new Date("2026-04-22T12:00:00.499Z"),
					}),
				},
			])
			.concat([
				{
					id: KEY_ID_MINE,
					data: () => ({
						createdAt: new Date("2026-04-22T12:00:00.500Z"),
					}),
				},
			]);

		const { mintApiKey } = await import("../api-key-actions");
		const result = await mintApiKey({
			name: "race-loser",
			scopes: ["nova.read", "nova.write"],
			expiry: "1y",
		});

		expect(result).toMatchObject({
			success: false,
			error: expect.stringContaining("10 keys"),
		});
		expect(mocks.apikeyDocDelete).toHaveBeenCalledTimes(1);
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});

	it("compensating delete: when count→create races push the user over the limit, a winner row is kept and success returns", async () => {
		/* Symmetric scenario to the loser test. Same race shape —
		 * pre-flight 9, post-create 11 — but the just-minted row
		 * sits at position 9 (the 10th-newest, last allowed slot).
		 * The action must NOT delete it; the success result returns
		 * with the plaintext key. The OTHER racing caller (not
		 * exercised here) sees its own row at position 10 and
		 * handles its own delete in its own invocation. */
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.countUserApiKeys.mockResolvedValueOnce(9).mockResolvedValueOnce(11);
		const winnerCreatedAt = new Date("2026-04-22T12:00:00.499Z");
		const winnerExpiresAt = new Date("2027-04-22T12:00:00.000Z");
		mocks.createApiKey.mockResolvedValue({
			id: KEY_ID_MINE,
			key: "sk-nova-v1-WINNER",
			start: "sk-nova-v1-WIN",
			createdAt: winnerCreatedAt,
			expiresAt: winnerExpiresAt,
		});
		const baseTime = new Date("2026-04-22T11:00:00.000Z").getTime();
		mocks.apikeyQuerySnapshot.docs = Array.from({ length: 9 }, (_, i) => ({
			id: `0000000000000000000000000000000${i.toString().padStart(2, "0")}`.slice(
				-32,
			),
			data: () => ({ createdAt: new Date(baseTime + i * 1000) }),
		}))
			.concat([
				{
					id: KEY_ID_MINE,
					data: () => ({ createdAt: winnerCreatedAt }),
				},
			])
			.concat([
				{
					id: "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
					data: () => ({
						createdAt: new Date("2026-04-22T12:00:00.500Z"),
					}),
				},
			]);

		const { mintApiKey } = await import("../api-key-actions");
		const result = await mintApiKey({
			name: "race-winner",
			scopes: ["nova.read", "nova.write"],
			expiry: "1y",
		});

		expect(result).toEqual({
			success: true,
			key: "sk-nova-v1-WINNER",
			keyId: KEY_ID_MINE,
			displayPrefix: "sk-nova-v1-WIN",
			createdAt: winnerCreatedAt.toISOString(),
			expiresAt: winnerExpiresAt.toISOString(),
		});
		expect(mocks.apikeyDocDelete).not.toHaveBeenCalled();
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings");
	});

	it("happy path: returns the plaintext key once and revalidates", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.countUserApiKeys.mockResolvedValue(2);
		const expiresAtDate = new Date("2027-04-22T12:00:00Z");
		const createdAtDate = new Date("2026-04-22T12:00:00Z");
		mocks.createApiKey.mockResolvedValue({
			id: "key-id-abc",
			key: "sk-nova-v1-AAAA",
			start: "sk-nova-v1-XYZ",
			createdAt: createdAtDate,
			expiresAt: expiresAtDate,
		});

		const { mintApiKey } = await import("../api-key-actions");
		const result = await mintApiKey({
			name: "ace-service",
			scopes: ["nova.read", "nova.write", "nova.hq.write"],
			expiry: "1y",
		});

		expect(result).toEqual({
			success: true,
			key: "sk-nova-v1-AAAA",
			keyId: "key-id-abc",
			displayPrefix: "sk-nova-v1-XYZ",
			createdAt: createdAtDate.toISOString(),
			expiresAt: expiresAtDate.toISOString(),
		});
		expect(mocks.createApiKey).toHaveBeenCalledTimes(1);
		const callArg = mocks.createApiKey.mock.calls[0]?.[0];
		expect(callArg?.body).toMatchObject({
			name: "ace-service",
			expiresIn: 365 * 24 * 60 * 60,
			permissions: { scope: ["nova.read", "nova.write", "nova.hq.write"] },
			userId: "user-1",
		});
		/* Critically, `headers` is NOT passed — the plugin's create
		 * endpoint rejects `permissions` (and other server-only props) as
		 * `SERVER_ONLY_PROPERTY` when `ctx.headers` is set, and we want
		 * to pass permissions. Server-only mode (no headers, explicit
		 * userId in body) is the only path that accepts permissions.
		 * If this assertion ever flips, expect a runtime
		 * `UNAUTHORIZED_SESSION` / `SERVER_ONLY_PROPERTY` from the plugin. */
		expect(callArg?.headers).toBeUndefined();
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings");
	});

	it("maps 30d / 90d / 1y / never to the right expiresIn seconds", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.countUserApiKeys.mockResolvedValue(0);
		mocks.createApiKey.mockResolvedValue({
			id: "k",
			key: "sk-nova-v1-x",
			start: "sk-nova-v1-x",
			createdAt: new Date("2026-04-22T12:00:00Z"),
			expiresAt: null,
		});
		const { mintApiKey } = await import("../api-key-actions");

		await mintApiKey({
			name: "k",
			scopes: ["nova.read", "nova.write"],
			expiry: "30d",
		});
		expect(mocks.createApiKey.mock.calls[0]?.[0]?.body.expiresIn).toBe(
			30 * 86400,
		);

		await mintApiKey({
			name: "k",
			scopes: ["nova.read", "nova.write"],
			expiry: "90d",
		});
		expect(mocks.createApiKey.mock.calls[1]?.[0]?.body.expiresIn).toBe(
			90 * 86400,
		);

		await mintApiKey({
			name: "k",
			scopes: ["nova.read", "nova.write"],
			expiry: "1y",
		});
		expect(mocks.createApiKey.mock.calls[2]?.[0]?.body.expiresIn).toBe(
			365 * 86400,
		);

		await mintApiKey({
			name: "k",
			scopes: ["nova.read", "nova.write"],
			expiry: "never",
		});
		expect(mocks.createApiKey.mock.calls[3]?.[0]?.body.expiresIn).toBe(
			36500 * 86400,
		);
	});

	it("translates plugin APIError codes into UI-shaped messages", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.countUserApiKeys.mockResolvedValue(0);
		const err = new APIError("BAD_REQUEST", { code: "KEY_NOT_FOUND" });
		mocks.createApiKey.mockRejectedValue(err);

		const { mintApiKey } = await import("../api-key-actions");
		const result = await mintApiKey({
			name: "k",
			scopes: ["nova.read", "nova.write"],
			expiry: "1y",
		});

		expect(result).toMatchObject({
			success: false,
			error: expect.stringContaining("isn't available"),
		});
	});
});

// ── revokeApiKey ────────────────────────────────────────────────────

describe("revokeApiKey", () => {
	it("refuses without a session", async () => {
		mocks.getSession.mockResolvedValue(null);

		const { revokeApiKey } = await import("../api-key-actions");
		const result = await revokeApiKey(KEY_ID_GENERIC);

		expect(result).toMatchObject({ success: false });
		expect(mocks.deleteApiKey).not.toHaveBeenCalled();
	});

	it("rejects empty / non-string keyId", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });

		const { revokeApiKey } = await import("../api-key-actions");
		const result = await revokeApiKey("   ");

		expect(result).toMatchObject({ success: false });
		expect(mocks.deleteApiKey).not.toHaveBeenCalled();
	});

	it("refuses when the session user is banned (cookie-cache TOCTOU)", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.isUserActive.mockResolvedValue(false);

		const { revokeApiKey } = await import("../api-key-actions");
		const result = await revokeApiKey(KEY_ID_MINE);

		expect(result).toMatchObject({ success: false });
		expect(mocks.deleteApiKey).not.toHaveBeenCalled();
	});

	it("rejects keyIds that don't match Better Auth's generateId shape", async () => {
		/* `isValidKeyId` matches `^[a-zA-Z0-9]{32}$` exactly — the
		 * literal output of `@better-auth/core/utils/id::generateId`.
		 * Lock the tighter contract in: anything else (HTML, control
		 * chars, slashes, off-length, non-alphanumeric chars) is
		 * rejected before reaching the plugin or audit logs. */
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		const { revokeApiKey } = await import("../api-key-actions");

		const badInputs = [
			"short",
			"too-many-x".repeat(20), // way over 32 chars
			"has-hyphens-but-32-chars-aaaaaaa", // 32 chars but contains `-`
			"<script>alert(1)</script>aaaaaaaa", // HTML
			"abcdefghijklmnopqrstuvwxyz12345\n", // newline
			"valid-shape-but-31-chars-abcdef", // 31 chars
			"valid-shape-but-33-chars-abcdefgh", // 33 chars
		];

		for (const bad of badInputs) {
			const result = await revokeApiKey(bad);
			expect(result).toMatchObject({ success: false });
			expect(mocks.deleteApiKey).not.toHaveBeenCalled();
		}
	});

	it("happy path deletes via the plugin and revalidates", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.deleteApiKey.mockResolvedValue({ success: true });

		const { revokeApiKey } = await import("../api-key-actions");
		const result = await revokeApiKey(KEY_ID_MINE);

		expect(result).toEqual({ success: true });
		expect(mocks.deleteApiKey).toHaveBeenCalledWith({
			body: { keyId: KEY_ID_MINE },
			headers: expect.any(Headers),
		});
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings");
	});

	it("treats plugin KEY_NOT_FOUND as idempotent success and emits the audit-log warning (covers missing + not-owned)", async () => {
		/* The plugin's deleteApiKey throws KEY_NOT_FOUND for both
		 * "no such row" and "row exists but referenceId !== this user".
		 * Server Action collapses both into success — same UX outcome
		 * (the key is gone from the user's perspective), and matches
		 * the plugin's deliberate non-leaking collapse.
		 *
		 * The `log.warn` is the only surface that distinguishes the
		 * legitimate path ("user revoked their own key") from the
		 * suspicious path ("user tried to revoke a keyId they don't
		 * own"). If a regression drops it, the wire still says
		 * `success: true` and the regression is undetectable. Pinning
		 * the log call here is the regression test for that signal. */
		const { log } = await import("@/lib/logger");
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.deleteApiKey.mockRejectedValue(
			new APIError("NOT_FOUND", { code: "KEY_NOT_FOUND" }),
		);

		const { revokeApiKey } = await import("../api-key-actions");
		const result = await revokeApiKey(KEY_ID_GONE);

		expect(result).toEqual({ success: true });
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings");
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("revoke: key not available"),
			expect.objectContaining({
				userId: "user-1",
				keyId: KEY_ID_GONE,
			}),
		);
	});

	it("surfaces other plugin errors as failure (not silent success)", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.deleteApiKey.mockRejectedValue(
			new APIError("INTERNAL_SERVER_ERROR", {
				code: "FAILED_TO_UPDATE_API_KEY",
			}),
		);

		const { revokeApiKey } = await import("../api-key-actions");
		const result = await revokeApiKey(KEY_ID_MINE);

		expect(result).toMatchObject({ success: false });
	});
});

// ── editApiKeyScopes ────────────────────────────────────────────────

describe("editApiKeyScopes", () => {
	it("refuses without a session", async () => {
		mocks.getSession.mockResolvedValue(null);

		const { editApiKeyScopes } = await import("../api-key-actions");
		const result = await editApiKeyScopes(KEY_ID_GENERIC, [
			"nova.read",
			"nova.write",
		]);

		expect(result).toMatchObject({ success: false });
		expect(mocks.updateApiKey).not.toHaveBeenCalled();
	});

	it("refuses when the session user is banned (cookie-cache TOCTOU)", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.isUserActive.mockResolvedValue(false);

		const { editApiKeyScopes } = await import("../api-key-actions");
		const result = await editApiKeyScopes(KEY_ID_MINE, [
			"nova.read",
			"nova.write",
		]);

		expect(result).toMatchObject({ success: false });
		expect(mocks.updateApiKey).not.toHaveBeenCalled();
	});

	it("rejects unknown scope strings", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });

		const { editApiKeyScopes } = await import("../api-key-actions");
		const result = await editApiKeyScopes(KEY_ID_GENERIC, [
			"nova.read",
			"nova.write",
			"made-up",
		]);

		expect(result).toMatchObject({ success: false });
		expect(mocks.updateApiKey).not.toHaveBeenCalled();
	});

	it("requires both floor scopes (nova.read + nova.write)", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });

		const { editApiKeyScopes } = await import("../api-key-actions");
		const result = await editApiKeyScopes(KEY_ID_GENERIC, ["nova.read"]);

		expect(result).toMatchObject({ success: false });
		expect(mocks.updateApiKey).not.toHaveBeenCalled();
	});

	it("happy path updates via the plugin and revalidates", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.updateApiKey.mockResolvedValue({ success: true });

		const { editApiKeyScopes } = await import("../api-key-actions");
		const result = await editApiKeyScopes(KEY_ID_MINE, [
			"nova.read",
			"nova.write",
			"nova.hq.read",
		]);

		expect(result).toEqual({ success: true });
		expect(mocks.updateApiKey).toHaveBeenCalledWith({
			body: {
				keyId: KEY_ID_MINE,
				permissions: {
					scope: ["nova.read", "nova.write", "nova.hq.read"],
				},
				userId: "user-1",
			},
			/* No `headers` — same `SERVER_ONLY_PROPERTY` rationale as the
			 * mint test above. The update endpoint rejects `permissions`
			 * when `ctx.headers` is set; server-only mode is the right path. */
		});
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings");
	});

	it("treats plugin KEY_NOT_FOUND as 'not available' and emits the audit-log warning (covers missing + not-owned)", async () => {
		/* Same collapse as the revoke path: plugin's updateApiKey throws
		 * KEY_NOT_FOUND for both "no such row" and "row not owned by
		 * this user". Server Action surfaces a single non-leaking
		 * message rather than distinguishing the two cases. The
		 * `log.warn` recovers the audit signal that the wire response
		 * deliberately drops. */
		const { log } = await import("@/lib/logger");
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.updateApiKey.mockRejectedValue(
			new APIError("NOT_FOUND", { code: "KEY_NOT_FOUND" }),
		);

		const { editApiKeyScopes } = await import("../api-key-actions");
		const result = await editApiKeyScopes(KEY_ID_GONE, [
			"nova.read",
			"nova.write",
		]);

		expect(result).toMatchObject({
			success: false,
			error: expect.stringContaining("isn't available"),
		});
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("edit: key not available"),
			expect.objectContaining({
				userId: "user-1",
				keyId: KEY_ID_GONE,
			}),
		);
	});
});
