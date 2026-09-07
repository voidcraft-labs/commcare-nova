/** Cached session projections are controlled; live user authority is read from migrated Postgres. */
import { beforeEach, expect, it, vi } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

const { getSession, signOut } = vi.hoisted(() => ({
	getSession: vi.fn(),
	signOut: vi.fn(async () => undefined),
}));
vi.mock("@/lib/auth", async () => ({
	...(await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth")),
	getAuth: async () => ({ api: { getSession, signOut } }),
}));

import { requireAdmin, requireSession } from "@/lib/auth-utils";

const database = setupAppStateTestDb("auth_live_gate_", {
	authSchema: "migrated",
});
const request = new Request("http://localhost/api/admin");
function cached(role: string, id = "actor") {
	return { user: { id, role }, session: {} };
}
beforeEach(async () => {
	getSession.mockReset();
	signOut.mockReset();
	await database.seedProjectMember("actor", "project", "owner");
});
async function role(value: string) {
	await database
		.pool()
		.query("UPDATE auth_user SET role = $1 WHERE id = $2", [value, "actor"]);
}

it("honors promotion and immediate demotion against a conflicting cached role", async () => {
	getSession.mockResolvedValue(cached("user"));
	await role("admin");
	expect((await requireAdmin(request)).user.id).toBe("actor");
	expect(signOut).not.toHaveBeenCalled();
	getSession.mockResolvedValue(cached("admin"));
	await role("user");
	await expect(requireAdmin(request)).rejects.toMatchObject({ status: 403 });
	expect(signOut).toHaveBeenCalledOnce();
});

it("denies a never-admin without signing out and preserves denial when revocation fails", async () => {
	getSession.mockResolvedValue(cached("user"));
	await role("user");
	await expect(requireAdmin(request)).rejects.toMatchObject({ status: 403 });
	expect(signOut).not.toHaveBeenCalled();
	getSession.mockResolvedValue(cached("admin"));
	signOut.mockRejectedValueOnce(new Error("session delete unavailable"));
	await expect(requireAdmin(request)).rejects.toMatchObject({ status: 403 });
	expect(signOut).toHaveBeenCalledOnce();
});

it("a live ban overrides the cached session until its actual expiry", async () => {
	getSession.mockResolvedValue(cached("user"));
	expect((await requireSession(request)).user.id).toBe("actor");
	await database
		.pool()
		.query(
			'UPDATE auth_user SET banned = true, "banExpires" = NULL WHERE id = $1',
			["actor"],
		);
	await expect(requireSession(request)).rejects.toMatchObject({ status: 401 });
	await database
		.pool()
		.query('UPDATE auth_user SET "banExpires" = $1 WHERE id = $2', [
			new Date(Date.now() - 1000),
			"actor",
		]);
	expect((await requireSession(request)).user.id).toBe("actor");
});

it("a missing live user cannot authenticate through the cached session", async () => {
	getSession.mockResolvedValue(cached("user", "removed-user"));
	await expect(requireSession(request)).rejects.toMatchObject({ status: 401 });
});

it("a failed live read follows the explicit fail-open availability policy", async () => {
	getSession.mockResolvedValue(cached("user"));
	await database
		.pool()
		.query("ALTER TABLE auth_user RENAME TO auth_user_unavailable");
	try {
		expect((await requireSession(request)).user.id).toBe("actor");
	} finally {
		await database
			.pool()
			.query("ALTER TABLE auth_user_unavailable RENAME TO auth_user");
	}
});

it("impersonation reads the acting admin ban and never grants chained admin authority", async () => {
	await database.seedProjectMember("target", "project", "viewer");
	await role("admin");
	await database
		.pool()
		.query("UPDATE auth_user SET banned = true WHERE id = $1", ["target"]);
	getSession.mockResolvedValue({
		user: { id: "target", role: "admin" },
		session: { impersonatedBy: "actor" },
	});
	expect((await requireSession(request)).user.id).toBe("target");
	await expect(requireAdmin(request)).rejects.toMatchObject({
		status: 403,
		message: "Admin access denied during impersonation",
	});
	await database
		.pool()
		.query("UPDATE auth_user SET banned = true WHERE id = $1", ["actor"]);
	await expect(requireSession(request)).rejects.toMatchObject({ status: 401 });
});

it("owns the activity update until PostgreSQL releases its row lock", async () => {
	getSession.mockResolvedValue(cached("user"));
	const result = await whileBlocked(
		database,
		(pg) =>
			pg.query("SELECT id FROM auth_user WHERE id = $1 FOR UPDATE", ["actor"]),
		() => requireSession(request),
		async (settled) => {
			expect(settled).toBe(false);
		},
	);
	expect(result.user.id).toBe("actor");
	const rows = await database
		.pool()
		.query('SELECT "lastActiveAt" FROM auth_user WHERE id = $1', ["actor"]);
	expect(rows.rows[0].lastActiveAt).toBeInstanceOf(Date);
});
