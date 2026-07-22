import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	commitAppProjectMove: vi.fn(),
	copyAssetsIntoProject: vi.fn(),
	loadApp: vi.fn(),
	retenantAppCases: vi.fn(),
}));

vi.mock("@/lib/case-store", () => ({
	retenantAppCases: mocks.retenantAppCases,
}));
vi.mock("@/lib/media/moveMedia", () => ({
	copyAssetsIntoProject: mocks.copyAssetsIntoProject,
}));
vi.mock("../apps", () => ({
	commitAppProjectMove: mocks.commitAppProjectMove,
	loadApp: mocks.loadApp,
}));

import {
	CrossProjectAppMoveBlockedError,
	moveAppToProject,
} from "../moveAppToProject";

const baseArgs = {
	appId: "app-1",
	fromProjectId: "project-a",
	toProjectId: "project-a",
	actorUserId: "user-1",
};

describe("moveAppToProject temporary Project policy", () => {
	beforeEach(() => {
		mocks.loadApp.mockResolvedValue({
			project_id: "project-a",
			status: "complete",
			deleted_at: null,
		});
		mocks.retenantAppCases.mockResolvedValue(undefined);
	});

	it("blocks a true cross-Project request before any storage work", async () => {
		const request = moveAppToProject({
			...baseArgs,
			toProjectId: "project-b",
		});

		await expect(request).rejects.toMatchObject({
			name: CrossProjectAppMoveBlockedError.name,
			code: "cross_project_move_unavailable",
		});
		expect(mocks.loadApp).not.toHaveBeenCalled();
		expect(mocks.copyAssetsIntoProject).not.toHaveBeenCalled();
		expect(mocks.commitAppProjectMove).not.toHaveBeenCalled();
		expect(mocks.retenantAppCases).not.toHaveBeenCalled();
	});

	it("reconciles case rows for an exact same-Project call without copying resources", async () => {
		await moveAppToProject(baseArgs);

		expect(mocks.loadApp).toHaveBeenCalledWith("app-1");
		expect(mocks.retenantAppCases).toHaveBeenCalledWith({
			appId: "app-1",
			toProjectId: "project-a",
		});
		expect(mocks.copyAssetsIntoProject).not.toHaveBeenCalled();
		expect(mocks.commitAppProjectMove).not.toHaveBeenCalled();
	});
});
