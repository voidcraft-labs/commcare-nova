import { beforeEach, describe, expect, it, vi } from "vitest";

const { refundStaleGenerationMock, getAppDb } = vi.hoisted(() => ({
	refundStaleGenerationMock: vi.fn(),
	getAppDb: vi.fn(() => {
		throw new Error("Unexpected database access");
	}),
}));
vi.mock("../credits", () => ({
	refundStaleGeneration: refundStaleGenerationMock,
}));
vi.mock("../pg", async (importOriginal) => ({
	...(await importOriginal<typeof import("../pg")>()),
	getAppDb,
}));
const HOLDER_NONCE = "00000000-0000-4000-8000-000000000001";

describe("reapStaleGenerating", () => {
	beforeEach(() => {
		refundStaleGenerationMock.mockReset();
	});

	it("delegates the reap (refund + flip, one atomic txn) to refundStaleGeneration", async () => {
		refundStaleGenerationMock.mockResolvedValue(undefined);
		const { reapStaleGenerating } = await import("../apps");

		await reapStaleGenerating("app-1", {
			mode: "build",
			runId: "run-1",
			nonce: HOLDER_NONCE,
		});

		expect(refundStaleGenerationMock).toHaveBeenCalledWith("app-1", {
			mode: "build",
			runId: "run-1",
			nonce: HOLDER_NONCE,
		});
	});

	it("SWALLOWS a transient throw — the row is untouched, so the next scan retries", async () => {
		refundStaleGenerationMock.mockRejectedValue(new Error("db down"));
		const { reapStaleGenerating } = await import("../apps");

		// A throw must not escape (fire-and-forget at the call sites).
		await expect(
			reapStaleGenerating("app-1", {
				mode: "build",
				runId: "run-1",
				nonce: HOLDER_NONCE,
			}),
		).resolves.toBeUndefined();
	});
});

it("returns no apps without opening the database for an empty membership set", async () => {
	const { listAppsAcrossProjects } = await import("../apps");
	expect(
		await listAppsAcrossProjects([], { limit: 50, sort: "updated_desc" }),
	).toEqual({ apps: [] });
	expect(getAppDb).not.toHaveBeenCalled();
});
