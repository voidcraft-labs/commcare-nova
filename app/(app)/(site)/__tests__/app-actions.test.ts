import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommitReauthError } from "@/lib/db/commitGuard";

const mocks = vi.hoisted(() => {
	class MockAppAccessError extends Error {}
	class MockAppBusyError extends Error {}
	class MockCaseDataStrandedError extends Error {}
	class MockCrossProjectAppMoveBlockedError extends Error {
		readonly code = "cross_project_move_unavailable" as const;
	}
	class MockAppRunStateCorruptError extends Error {}
	class MockProjectMoveCompatibilityError extends Error {
		constructor(readonly code: "disabled" | "incompatible_receiver") {
			super(code);
		}
	}

	return {
		AppAccessError: MockAppAccessError,
		AppBusyError: MockAppBusyError,
		AppRunStateCorruptError: MockAppRunStateCorruptError,
		ProjectMoveCompatibilityError: MockProjectMoveCompatibilityError,
		readProjectMovesEnabled: vi.fn(),
		CaseDataStrandedError: MockCaseDataStrandedError,
		CrossProjectAppMoveBlockedError: MockCrossProjectAppMoveBlockedError,
		getSession: vi.fn(),
		moveAppToProject: vi.fn(),
		resolveAppAccess: vi.fn(),
		resolveAppScope: vi.fn(),
		restoreApp: vi.fn(),
		softDeleteApp: vi.fn(),
		revalidatePath: vi.fn(),
	};
});

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth-utils", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db/appAccess", () => ({
	AppAccessError: mocks.AppAccessError,
	resolveAppAccess: mocks.resolveAppAccess,
	resolveAppScope: mocks.resolveAppScope,
}));
vi.mock("@/lib/db/apps", () => ({
	restoreApp: mocks.restoreApp,
	softDeleteApp: mocks.softDeleteApp,
}));
vi.mock("@/lib/db/moveAppToProject", () => ({
	AppBusyError: mocks.AppBusyError,
	AppRunStateCorruptError: mocks.AppRunStateCorruptError,
	CaseDataStrandedError: mocks.CaseDataStrandedError,
	CrossProjectAppMoveBlockedError: mocks.CrossProjectAppMoveBlockedError,
	moveAppToProject: mocks.moveAppToProject,
}));
vi.mock("@/lib/db/projectMoveAdmission", () => ({
	ProjectMoveCompatibilityError: mocks.ProjectMoveCompatibilityError,
}));
vi.mock("@/lib/db/lookupActivation", () => ({
	readProjectMovesEnabled: mocks.readProjectMovesEnabled,
}));

import {
	deleteApp,
	moveApp,
	restoreApp as restoreAppAction,
} from "../app-actions";

describe("delete/restore authoritative admission", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
	});

	it("passes the authenticated actor to the locked delete writer", async () => {
		mocks.softDeleteApp.mockResolvedValue("2026-08-20T00:00:00.000Z");

		await expect(deleteApp("app-1")).resolves.toEqual({
			success: true,
			recoverableUntil: "2026-08-20T00:00:00.000Z",
		});
		expect(mocks.softDeleteApp).toHaveBeenCalledWith("app-1", "user-1");
		expect(mocks.resolveAppScope).not.toHaveBeenCalled();
	});

	it("keeps write-time delete revocation IDOR-opaque", async () => {
		mocks.softDeleteApp.mockRejectedValue(
			new CommitReauthError("permission denied"),
		);

		await expect(deleteApp("foreign-app")).resolves.toEqual({
			success: false,
			error: "App not found.",
		});
	});

	it("passes the authenticated actor to restore and maps its revocation", async () => {
		mocks.restoreApp.mockRejectedValue(
			new CommitReauthError("permission denied"),
		);

		await expect(restoreAppAction("app-1")).resolves.toEqual({
			success: false,
			error: "App not found.",
		});
		expect(mocks.restoreApp).toHaveBeenCalledWith("app-1", "user-1");
	});
});

describe("moveApp temporary Project policy", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
		mocks.resolveAppAccess.mockResolvedValue({
			projectId: "project-source",
			role: "owner",
			actorUserId: "user-1",
		});
		mocks.moveAppToProject.mockResolvedValue(undefined);
		mocks.readProjectMovesEnabled.mockResolvedValue(true);
	});

	it("moves the app", async () => {
		await expect(moveApp("app-1", "project-target")).resolves.toEqual({
			success: true,
			kind: "moved",
		});
		expect(mocks.moveAppToProject).toHaveBeenCalledWith({
			appId: "app-1",
			fromProjectId: "project-source",
			toProjectId: "project-target",
			actorUserId: "user-1",
		});
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/");
	});

	it("keeps source denials opaque instead of revealing the move policy", async () => {
		mocks.resolveAppAccess.mockRejectedValue(
			new mocks.AppAccessError("not found"),
		);

		await expect(moveApp("foreign-app", "project-target")).resolves.toEqual({
			success: false,
			code: "not_found",
			error: "App not found.",
		});
		expect(mocks.moveAppToProject).not.toHaveBeenCalled();
	});

	it("retains exact same-Project case-data recovery", async () => {
		await expect(moveApp("app-1", "project-source")).resolves.toEqual({
			success: true,
			kind: "same_project_recovered",
		});
		expect(mocks.moveAppToProject).toHaveBeenCalledWith({
			appId: "app-1",
			fromProjectId: "project-source",
			toProjectId: "project-source",
			actorUserId: "user-1",
		});
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/");
	});
});
