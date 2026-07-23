import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	commitAppProjectMove: vi.fn(),
	copyAssetsIntoProject: vi.fn(),
	normalizeReapableRunForProjectMove: vi.fn(),
	prepareAppProjectMove: vi.fn(),
	repairAppCaseTenancy: vi.fn(),
}));

vi.mock("@/lib/media/moveMedia", () => ({
	copyAssetsIntoProject: mocks.copyAssetsIntoProject,
}));
vi.mock("../apps", () => ({
	commitAppProjectMove: mocks.commitAppProjectMove,
	normalizeReapableRunForProjectMove: mocks.normalizeReapableRunForProjectMove,
	prepareAppProjectMove: mocks.prepareAppProjectMove,
	repairAppCaseTenancy: mocks.repairAppCaseTenancy,
}));

import {
	AppBusyError,
	CrossProjectAppMoveBlockedError,
	moveAppToProject,
	moveAppToProjectWhenEnabled,
} from "../moveAppToProject";

const sameProjectArgs = {
	appId: "app-1",
	fromProjectId: "project-a",
	toProjectId: "project-a",
	actorUserId: "user-1",
};
const crossProjectArgs = {
	...sameProjectArgs,
	toProjectId: "project-b",
};

describe("moveAppToProject production policy", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.repairAppCaseTenancy.mockResolvedValue({
			projectId: "project-a",
			moved: 0,
		});
	});

	it("blocks a true cross-Project request before any storage work", async () => {
		await expect(moveAppToProject(crossProjectArgs)).rejects.toMatchObject({
			name: CrossProjectAppMoveBlockedError.name,
			code: "cross_project_move_unavailable",
		});
		expect(mocks.prepareAppProjectMove).not.toHaveBeenCalled();
		expect(mocks.copyAssetsIntoProject).not.toHaveBeenCalled();
		expect(mocks.commitAppProjectMove).not.toHaveBeenCalled();
		expect(mocks.repairAppCaseTenancy).not.toHaveBeenCalled();
	});

	it("routes exact same-Project recovery through the app-locked repair", async () => {
		await moveAppToProject(sameProjectArgs);

		expect(mocks.repairAppCaseTenancy).toHaveBeenCalledWith("app-1", "user-1");
		expect(mocks.copyAssetsIntoProject).not.toHaveBeenCalled();
		expect(mocks.commitAppProjectMove).not.toHaveBeenCalled();
	});
});

describe("dormant move orchestration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.copyAssetsIntoProject.mockResolvedValue(
			new Map([["source", "destination"]]),
		);
		mocks.commitAppProjectMove.mockResolvedValue({ kind: "moved" });
		mocks.normalizeReapableRunForProjectMove.mockResolvedValue("reaped");
	});

	it("normalizes a reapable holder before copying, then retries admission", async () => {
		const identity = {
			mode: "build" as const,
			runId: "stale-run",
			nonce: "stale-nonce",
		};
		mocks.prepareAppProjectMove
			.mockResolvedValueOnce({ kind: "reapable", identity })
			.mockResolvedValueOnce({
				kind: "ready",
				requiredAssetIds: ["source"],
				historicalAssetIds: ["history"],
			});

		await moveAppToProjectWhenEnabled(crossProjectArgs);

		expect(mocks.normalizeReapableRunForProjectMove).toHaveBeenCalledWith(
			"app-1",
			identity,
		);
		expect(mocks.copyAssetsIntoProject).toHaveBeenCalledOnce();
		expect(mocks.commitAppProjectMove).toHaveBeenCalledWith(
			"app-1",
			expect.objectContaining({
				attemptedRealIds: new Set(["source", "history"]),
			}),
		);
	});

	it("propagates a reaper failure and never treats it as release", async () => {
		mocks.prepareAppProjectMove.mockResolvedValue({
			kind: "reapable",
			identity: { mode: "edit", runId: "edit-1", nonce: "nonce-1" },
		});
		mocks.normalizeReapableRunForProjectMove.mockRejectedValue(
			new Error("credit database unavailable"),
		);

		await expect(moveAppToProjectWhenEnabled(crossProjectArgs)).rejects.toThrow(
			"credit database unavailable",
		);
		expect(mocks.copyAssetsIntoProject).not.toHaveBeenCalled();
	});

	it("reports busy when a claim wins between reap and retry", async () => {
		mocks.prepareAppProjectMove
			.mockResolvedValueOnce({
				kind: "reapable",
				identity: { mode: "build", runId: "old", nonce: "old-nonce" },
			})
			.mockResolvedValueOnce({ kind: "busy" });

		await expect(
			moveAppToProjectWhenEnabled(crossProjectArgs),
		).rejects.toBeInstanceOf(AppBusyError);
		expect(mocks.copyAssetsIntoProject).not.toHaveBeenCalled();
	});
});
