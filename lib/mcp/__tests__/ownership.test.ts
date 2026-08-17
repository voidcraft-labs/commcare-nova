/**
 * requireOwnedApp / requireProjectAccess unit tests.
 *
 * `requireOwnedApp` wraps the membership resolver `resolveAppScope`; these
 * tests verify it maps the resolver's outcomes onto the two-value MCP taxonomy:
 *   - resolver throws `AppAccessError("not_found")` → `McpAccessError("not_found")`.
 *   - resolver throws any other `AppAccessError` (non-member / under-privileged)
 *     → `McpAccessError("not_owner")` (which the wire collapses to `not_found`).
 *   - resolver resolves → `requireOwnedApp` resolves cleanly.
 *
 * `requireProjectAccess` is the Project twin with one deliberate asymmetry:
 * `insufficient_role` does NOT collapse to not-found — a member legitimately
 * knows the Project exists, so it becomes a `ProjectPermissionError` carrying
 * the call site's op-specific copy. The two non-member reasons still collapse,
 * flavored `resource: "project"` so the wire text reads "Project not found.".
 *
 * The resolvers are mocked (the real `AppAccessError` is kept so the
 * instanceof mapping holds) so no Postgres client ever spins up.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	AppAccessError,
	resolveAppScope,
	resolveProjectAccess,
} from "@/lib/db/appAccess";
import {
	McpAccessError,
	requireOwnedApp,
	requireProjectAccess,
} from "../ownership";

vi.mock("@/lib/db/appAccess", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/appAccess")>()),
	resolveAppScope: vi.fn(),
	resolveProjectAccess: vi.fn(),
}));

beforeEach(() => {
	vi.mocked(resolveAppScope).mockReset();
	vi.mocked(resolveProjectAccess).mockReset();
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
		/* Pre-existing call sites default the resource flavor to "app". */
		expect(e.resource).toBe("app");
	});
});

describe("requireProjectAccess", () => {
	const COPY = "Your role in this Project can't invite members.";

	it("throws the Project-flavored not_found when the Project doesn't exist", async () => {
		vi.mocked(resolveProjectAccess).mockRejectedValueOnce(
			new AppAccessError("not_found"),
		);
		await expect(
			requireProjectAccess("u1", "missing", "edit", COPY),
		).rejects.toMatchObject({
			name: "McpAccessError",
			reason: "not_found",
			resource: "project",
		});
	});

	it("collapses a non-member to the Project-flavored not_owner", async () => {
		vi.mocked(resolveProjectAccess).mockRejectedValueOnce(
			new AppAccessError("not_member"),
		);
		await expect(
			requireProjectAccess("u1", "proj-foreign", "edit", COPY),
		).rejects.toMatchObject({
			name: "McpAccessError",
			reason: "not_owner",
			resource: "project",
		});
	});

	it("maps insufficient_role to ProjectPermissionError with the caller's copy", async () => {
		/* The deliberate asymmetry: a MEMBER whose role falls short gets an
		 * explicit permission message, never the not-found collapse — they
		 * legitimately know the Project exists. */
		vi.mocked(resolveProjectAccess).mockRejectedValueOnce(
			new AppAccessError("insufficient_role"),
		);
		await expect(
			requireProjectAccess("u1", "proj-shared", "edit", COPY),
		).rejects.toMatchObject({
			name: "ProjectPermissionError",
			message: COPY,
		});
	});

	it("falls back to the generic role message when the call site passes none", async () => {
		/* Call sites whose capability every role holds (or whose denial copy
		 * lives in the manage layer) omit the 4th argument; the shared
		 * fallback must still name a way forward. */
		vi.mocked(resolveProjectAccess).mockRejectedValueOnce(
			new AppAccessError("insufficient_role"),
		);
		await expect(
			requireProjectAccess("u1", "proj-shared", "edit"),
		).rejects.toMatchObject({
			name: "ProjectPermissionError",
			message:
				"Your role in this Project doesn't allow this action. Ask a Project admin or owner to do it, or to raise your role.",
		});
	});

	it("returns the resolved access so the role can ride into response text", async () => {
		vi.mocked(resolveProjectAccess).mockResolvedValueOnce({
			projectId: "proj-shared",
			role: "editor",
			actorUserId: "u1",
		});
		await expect(
			requireProjectAccess("u1", "proj-shared", "edit", COPY),
		).resolves.toEqual({
			projectId: "proj-shared",
			role: "editor",
			actorUserId: "u1",
		});
	});
});
