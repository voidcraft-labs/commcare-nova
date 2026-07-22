import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommitReauthError } from "@/lib/db/commitGuard";

const mocks = vi.hoisted(() => {
	class MockAppAccessError extends Error {}
	return {
		AppAccessError: MockAppAccessError,
		createApp: vi.fn(),
		getSession: vi.fn(),
		resolveProjectAccess: vi.fn(),
		revalidatePath: vi.fn(),
	};
});

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth-utils", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db/appAccess", () => ({
	AppAccessError: mocks.AppAccessError,
	resolveProjectAccess: mocks.resolveProjectAccess,
}));
vi.mock("@/lib/db/apps", () => ({ createApp: mocks.createApp }));

import { createBlankApp } from "../actions";

describe("createBlankApp Project binding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
		mocks.resolveProjectAccess.mockResolvedValue({
			projectId: "project-seeded-by-build-new",
			role: "editor",
			actorUserId: "user-1",
		});
		mocks.createApp.mockResolvedValue("app-1");
	});

	it("creates in the server-rendered Project even after another tab changes the active Project", async () => {
		await expect(
			createBlankApp("project-seeded-by-build-new"),
		).resolves.toEqual({ success: true, appId: "app-1" });

		expect(mocks.resolveProjectAccess).toHaveBeenCalledWith(
			"user-1",
			"project-seeded-by-build-new",
			"edit",
		);
		expect(mocks.createApp).toHaveBeenCalledWith(
			"user-1",
			"project-seeded-by-build-new",
			expect.any(String),
			expect.objectContaining({ status: "complete" }),
		);
	});

	it("fails closed when the actor cannot edit the captured Project", async () => {
		mocks.resolveProjectAccess.mockRejectedValue(
			new mocks.AppAccessError("not a member"),
		);

		await expect(
			createBlankApp("project-seeded-by-build-new"),
		).resolves.toEqual({
			success: false,
			error: "You don't have permission to create apps in this Project.",
		});
		expect(mocks.createApp).not.toHaveBeenCalled();
	});

	it("maps a transaction-time access change without claiming creation succeeded", async () => {
		mocks.createApp.mockRejectedValue(
			new CommitReauthError("Project access changed"),
		);

		await expect(
			createBlankApp("project-seeded-by-build-new"),
		).resolves.toEqual({
			success: false,
			error: "You don't have permission to create apps in this Project.",
		});
	});
});
