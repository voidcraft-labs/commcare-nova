/**
 * Tests for `requireAdmin` — the admin API gate.
 *
 * Security property under test: authorization reads the role FRESH from
 * `auth_users`, not the cached `session.user.role`, so an admin demotion
 * takes effect on the next API call rather than lingering for the
 * 5-minute session-cookie cache window. `getAuth` + `getDb` are mocked
 * because this exercises our own authorization control flow (cached vs
 * fresh role, live revocation), not an external contract.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const signOut = vi.fn(async () => undefined);
const authUserGet = vi.fn();

vi.mock("@/lib/auth", () => ({
	getAuth: () => ({ api: { getSession, signOut } }),
}));
vi.mock("@/lib/db/firestore", () => ({
	getDb: () => ({
		collection: () => ({
			// One doc ref serves both the fresh role read (`get`) and the
			// fire-and-forget activity bump in `touchUser` (`set`).
			doc: () => ({ get: authUserGet, set: vi.fn(async () => undefined) }),
		}),
	}),
}));

import { requireAdmin } from "../auth-utils";

// `requireSession` only reads `req.headers` (forwarded to the mocked auth);
// a bare object is enough.
const REQ = { headers: {} } as unknown as Request;

function sessionWithRole(role: string) {
	return { user: { id: "u1", role }, session: {} };
}

beforeEach(() => {
	getSession.mockReset();
	signOut.mockReset();
	authUserGet.mockReset();
});

describe("requireAdmin", () => {
	it("authorizes when auth_users reads admin (the fresh read, not the cache)", async () => {
		getSession.mockResolvedValue(sessionWithRole("admin"));
		authUserGet.mockResolvedValue({ data: () => ({ role: "admin" }) });

		const session = await requireAdmin(REQ);

		expect(session.user.id).toBe("u1");
		expect(signOut).not.toHaveBeenCalled();
	});

	it("rejects a demoted admin even while the cached session still says admin", async () => {
		// Cached session role is stale ("admin"); the fresh auth_users read is
		// the current truth ("user"). The gate authorizes on the fresh read,
		// so it 403s instead of honoring the cache for up to five minutes.
		getSession.mockResolvedValue(sessionWithRole("admin"));
		authUserGet.mockResolvedValue({ data: () => ({ role: "user" }) });

		await expect(requireAdmin(REQ)).rejects.toMatchObject({ status: 403 });
		// Live revocation: a mid-session demotion signs the session out so the
		// stale cookie can't keep returning a session.
		expect(signOut).toHaveBeenCalledTimes(1);
	});

	it("403s a never-admin caller WITHOUT signing them out", async () => {
		getSession.mockResolvedValue(sessionWithRole("user"));
		authUserGet.mockResolvedValue({ data: () => ({ role: "user" }) });

		await expect(requireAdmin(REQ)).rejects.toMatchObject({ status: 403 });
		// A regular user poking an admin endpoint just gets the 403 — there's
		// no privilege to revoke, so we don't log them out.
		expect(signOut).not.toHaveBeenCalled();
	});
});
