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
			// `doc(id)` forwards the requested id to `authUserGet`, so a test can
			// branch the snapshot per user (banned target vs active admin) AND
			// assert which id the revocation read actually queried — without this
			// the gate could read the wrong id and every test would still pass.
			doc: (id: string) => ({
				get: () => authUserGet(id),
				set: vi.fn(async () => undefined),
			}),
		}),
	}),
}));

import { requireAdmin, requireSession } from "../auth-utils";

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
		// `exists`/no-`banned` keeps the live `isUserActive` check (now run by
		// `getSessionSafe`, via `requireSession`) seeing an active user, so the
		// test still exercises the fresh-role admin gate rather than tripping the
		// revocation lock.
		authUserGet.mockResolvedValue({
			exists: true,
			data: () => ({ role: "admin" }),
		});

		const session = await requireAdmin(REQ);

		expect(session.user.id).toBe("u1");
		expect(signOut).not.toHaveBeenCalled();
	});

	it("rejects a demoted admin even while the cached session still says admin", async () => {
		// Cached session role is stale ("admin"); the fresh auth_users read is
		// the current truth ("user"). The gate authorizes on the fresh read,
		// so it 403s instead of honoring the cache for up to five minutes.
		getSession.mockResolvedValue(sessionWithRole("admin"));
		authUserGet.mockResolvedValue({
			exists: true,
			data: () => ({ role: "user" }),
		});

		await expect(requireAdmin(REQ)).rejects.toMatchObject({ status: 403 });
		// Live revocation: a mid-session demotion signs the session out so the
		// stale cookie can't keep returning a session.
		expect(signOut).toHaveBeenCalledTimes(1);
	});

	it("403s a never-admin caller WITHOUT signing them out", async () => {
		getSession.mockResolvedValue(sessionWithRole("user"));
		authUserGet.mockResolvedValue({
			exists: true,
			data: () => ({ role: "user" }),
		});

		await expect(requireAdmin(REQ)).rejects.toMatchObject({ status: 403 });
		// A regular user poking an admin endpoint just gets the 403 — there's
		// no privilege to revoke, so we don't log them out.
		expect(signOut).not.toHaveBeenCalled();
	});
});

describe("requireSession revocation lock", () => {
	// The cookie cache can return a still-valid-looking session for up to 5
	// minutes after a ban/deletion; the live `isUserActive` read closes that
	// gap on the authenticated work surface.
	it("401s a banned user even while the cached cookie still resolves a session", async () => {
		getSession.mockResolvedValue(sessionWithRole("user"));
		// banned, no `banExpires` → `isUserActive` is false.
		authUserGet.mockResolvedValue({
			exists: true,
			data: () => ({ banned: true }),
		});
		await expect(requireSession(REQ)).rejects.toMatchObject({ status: 401 });
	});

	it("401s a deleted user (auth_users doc gone)", async () => {
		getSession.mockResolvedValue(sessionWithRole("user"));
		authUserGet.mockResolvedValue({ exists: false });
		await expect(requireSession(REQ)).rejects.toMatchObject({ status: 401 });
	});

	it("allows the request through (fail-OPEN) when the user-status read throws", async () => {
		getSession.mockResolvedValue(sessionWithRole("user"));
		authUserGet.mockRejectedValue(new Error("firestore down"));
		// A transient Firestore error must NOT mass-sign-out the user base —
		// a definitive banned/deleted denies, but an unreadable status allows.
		const session = await requireSession(REQ);
		expect(session.user.id).toBe("u1");
	});

	it("allows an active (non-banned) user through", async () => {
		getSession.mockResolvedValue(sessionWithRole("user"));
		authUserGet.mockResolvedValue({ exists: true, data: () => ({}) });
		const session = await requireSession(REQ);
		expect(session.user.id).toBe("u1");
	});

	it("gates on the acting admin, not the target, during impersonation", async () => {
		// `session.user` is the impersonated target; `impersonatedBy` is the
		// acting admin. The revocation check must read the ADMIN's status so an
		// admin can still investigate a banned account.
		getSession.mockResolvedValue({
			user: { id: "banned-target", role: "user" },
			session: { impersonatedBy: "admin-1" },
		});
		// Branch per id: the target is BANNED, the admin is active. If the gate
		// read the target's id (the regression) this would 401; succeeding proves
		// it read the admin's.
		authUserGet.mockImplementation(async (id: string) =>
			id === "admin-1"
				? { exists: true, data: () => ({}) }
				: { exists: true, data: () => ({ banned: true }) },
		);
		const session = await requireSession(REQ);
		expect(session.user.id).toBe("banned-target");
		expect(authUserGet).toHaveBeenCalledWith("admin-1");
		expect(authUserGet).not.toHaveBeenCalledWith("banned-target");
	});
});
