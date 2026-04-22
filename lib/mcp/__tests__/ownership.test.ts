/**
 * requireOwnedApp unit tests.
 *
 * Covers the three paths a route handler has to care about:
 *   - App doesn't exist → `McpForbiddenError("not_found")`.
 *   - App exists but belongs to someone else → `McpForbiddenError("not_owner")`.
 *   - App belongs to the caller → resolves cleanly.
 *
 * `loadAppOwner` is mocked so no Firestore client ever spins up; the
 * hoisted `vi.mock` installs before `../ownership` resolves its import.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppOwner } from "@/lib/db/apps";
import { McpForbiddenError, requireOwnedApp } from "../ownership";

vi.mock("@/lib/db/apps", () => ({
	loadAppOwner: vi.fn(),
}));

beforeEach(() => {
	vi.mocked(loadAppOwner).mockReset();
});

describe("requireOwnedApp", () => {
	it("throws not_found when the app doesn't exist", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce(null);
		await expect(requireOwnedApp("u1", "missing")).rejects.toMatchObject({
			name: "McpForbiddenError",
			reason: "not_found",
		});
	});

	it("throws not_owner when the app belongs to someone else", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("other-user");
		await expect(requireOwnedApp("u1", "a1")).rejects.toMatchObject({
			name: "McpForbiddenError",
			reason: "not_owner",
		});
	});

	it("resolves cleanly when the caller owns the app", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		await expect(requireOwnedApp("u1", "a1")).resolves.toBeUndefined();
	});

	it("exports an McpForbiddenError class with a readable name", () => {
		/* Defensive: the error serializer and route-handler logger both
		 * branch on `instanceof McpForbiddenError`, and a silent rename
		 * here would skip both branches without a type error. */
		const e = new McpForbiddenError("not_found");
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe("McpForbiddenError");
		expect(e.reason).toBe("not_found");
	});
});
