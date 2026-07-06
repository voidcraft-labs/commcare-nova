/**
 * requireOwnedApp unit tests.
 *
 * `requireOwnedApp` now wraps the membership resolver `resolveAppScope`; these
 * tests verify it maps the resolver's outcomes onto the two-value MCP taxonomy:
 *   - resolver throws `AppAccessError("not_found")` → `McpAccessError("not_found")`.
 *   - resolver throws any other `AppAccessError` (non-member / under-privileged)
 *     → `McpAccessError("not_owner")` (which the wire collapses to `not_found`).
 *   - resolver resolves → `requireOwnedApp` resolves cleanly.
 *
 * `resolveAppScope` is mocked (the real `AppAccessError` is kept so the
 * instanceof mapping holds) so no Firestore/Postgres client ever spins up.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { McpAccessError, requireOwnedApp } from "../ownership";

vi.mock("@/lib/db/appAccess", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/appAccess")>()),
	resolveAppScope: vi.fn(),
}));

beforeEach(() => {
	vi.mocked(resolveAppScope).mockReset();
});

describe("requireOwnedApp", () => {
	it("throws not_found when the app doesn't exist", async () => {
		vi.mocked(resolveAppScope).mockRejectedValueOnce(
			new AppAccessError("not_found"),
		);
		await expect(requireOwnedApp("u1", "missing")).rejects.toMatchObject({
			name: "McpAccessError",
			reason: "not_found",
		});
	});

	it("throws not_owner when the caller isn't a member", async () => {
		vi.mocked(resolveAppScope).mockRejectedValueOnce(
			new AppAccessError("not_member"),
		);
		await expect(requireOwnedApp("u1", "a1")).rejects.toMatchObject({
			name: "McpAccessError",
			reason: "not_owner",
		});
	});

	it("throws not_owner when the caller's role is under-privileged", async () => {
		vi.mocked(resolveAppScope).mockRejectedValueOnce(
			new AppAccessError("insufficient_role"),
		);
		await expect(requireOwnedApp("u1", "a1", "delete")).rejects.toMatchObject({
			name: "McpAccessError",
			reason: "not_owner",
		});
	});

	it("resolves cleanly when the caller has the capability", async () => {
		vi.mocked(resolveAppScope).mockResolvedValueOnce({
			projectId: "proj-1",
			role: "owner",
			actorUserId: "u1",
		});
		await expect(requireOwnedApp("u1", "a1")).resolves.toBeUndefined();
	});

	it("exports an McpAccessError class with a readable name", () => {
		/* Defensive: the error serializer and route-handler logger both
		 * branch on `instanceof McpAccessError`, and a silent rename
		 * here would skip both branches without a type error. */
		const e = new McpAccessError("not_found");
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe("McpAccessError");
		expect(e.reason).toBe("not_found");
	});
});
