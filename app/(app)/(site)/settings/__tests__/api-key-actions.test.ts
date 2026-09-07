import { editApiKeyScopes, mintApiKey, revokeApiKey } from "../api-key-actions";
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

	function reset() {
		getSession.mockReset();
		countUserApiKeys.mockReset();
		isUserActive.mockReset();
		/* Default to active: banned-user tests opt in by overriding. */
		isUserActive.mockResolvedValue(true);
		createApiKey.mockReset();
		deleteApiKey.mockReset();
		updateApiKey.mockReset();
		revalidatePath.mockReset();
		headers.mockReset();
		headers.mockImplementation(async () => new Headers());
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
		reset,
	};
});

vi.mock("@/lib/auth-utils", async () => {
	/* `callerIpFromHeaders` is a pure helper: re-export the real
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
	/* `toISOString` / `toISOStringOrNull` are pure helpers: re-export
	 * the real implementations rather than mocking, so the date
	 * conversion is exercised end-to-end against the `Date` values
	 * Postgres returns. */
	const actual =
		await vi.importActual<typeof import("@/lib/db/api-keys")>(
			"@/lib/db/api-keys",
		);
	return {
		countUserApiKeys: mocks.countUserApiKeys,
		isUserActive: mocks.isUserActive,
		PER_USER_KEY_LIMIT: actual.PER_USER_KEY_LIMIT,
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

vi.mock("next/cache", () => ({
	revalidatePath: mocks.revalidatePath,
}));

vi.mock("next/headers", () => ({
	headers: mocks.headers,
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
		 * that gap: same pattern as `requireAdminAccess`'s direct
		 * Postgres read. Mirrors the MCP route's `isUserActive`
		 * lookup so the two surfaces agree on "user can act." */
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.isUserActive.mockResolvedValue(false);
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
		/* Critically, `headers` is NOT passed: the plugin's create
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
		const result = await revokeApiKey(KEY_ID_GENERIC);

		expect(result).toMatchObject({ success: false });
		expect(mocks.deleteApiKey).not.toHaveBeenCalled();
	});

	it("rejects empty / non-string keyId", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		const result = await revokeApiKey("   ");

		expect(result).toMatchObject({ success: false });
		expect(mocks.deleteApiKey).not.toHaveBeenCalled();
	});

	it("refuses when the session user is banned (cookie-cache TOCTOU)", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.isUserActive.mockResolvedValue(false);
		const result = await revokeApiKey(KEY_ID_MINE);

		expect(result).toMatchObject({ success: false });
		expect(mocks.deleteApiKey).not.toHaveBeenCalled();
	});

	it("rejects keyIds that don't match Better Auth's generateId shape", async () => {
		/* `isValidKeyId` matches `^[a-zA-Z0-9]{32}$` exactly: the
		 * literal output of `@better-auth/core/utils/id::generateId`.
		 * Lock the tighter contract in: anything else (HTML, control
		 * chars, slashes, off-length, non-alphanumeric chars) is
		 * rejected before reaching the plugin or audit logs. */
		mocks.getSession.mockResolvedValue({ user: sessionUser });

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
		 * Server Action collapses both into success: same UX outcome
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
		const result = await revokeApiKey(KEY_ID_MINE);

		expect(result).toMatchObject({ success: false });
	});
});

// ── editApiKeyScopes ────────────────────────────────────────────────

describe("editApiKeyScopes", () => {
	it("refuses without a session", async () => {
		mocks.getSession.mockResolvedValue(null);
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
		const result = await editApiKeyScopes(KEY_ID_MINE, [
			"nova.read",
			"nova.write",
		]);

		expect(result).toMatchObject({ success: false });
		expect(mocks.updateApiKey).not.toHaveBeenCalled();
	});

	it("rejects unknown scope strings", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });
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
		const result = await editApiKeyScopes(KEY_ID_GENERIC, ["nova.read"]);

		expect(result).toMatchObject({ success: false });
		expect(mocks.updateApiKey).not.toHaveBeenCalled();
	});

	it("happy path updates via the plugin and revalidates", async () => {
		mocks.getSession.mockResolvedValue({ user: sessionUser });
		mocks.updateApiKey.mockResolvedValue({ success: true });
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
			/* No `headers`: same `SERVER_ONLY_PROPERTY` rationale as the
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

it("malformed Server Action scopes resolve a refusal without throwing", async () => {
	mocks.getSession.mockResolvedValue({ user: sessionUser });
	const result = await editApiKeyScopes(
		KEY_ID_MINE,
		{} as unknown as readonly string[],
	);
	expect(result).toMatchObject({ success: false });
	expect(mocks.updateApiKey).not.toHaveBeenCalled();
});
