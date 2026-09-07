import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RUN_MINUTES } from "@/lib/db/constants";
import { log } from "@/lib/logger";
import { makeTestContext } from "./fixtures";

const { refreshEditLease, refreshBuildLiveness } = vi.hoisted(() => ({
	refreshEditLease: vi.fn(),
	refreshBuildLiveness: vi.fn(),
}));
vi.mock("@/lib/db/apps", async (original) => ({
	...(await original<typeof import("@/lib/db/apps")>()),
	refreshEditLease,
	refreshBuildLiveness,
}));
const INTERVAL = (MAX_RUN_MINUTES / 3) * 60_000;
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("run heartbeat ownership", () => {
	it.each([false, true])(
		"joins active database refresh on stop (edit=%s) and rejects late beats",
		async (editLease) => {
			vi.useFakeTimers();
			const refreshing = Promise.withResolvers<boolean>();
			const refresh = editLease ? refreshEditLease : refreshBuildLiveness;
			refresh.mockReturnValue(refreshing.promise);
			const { ctx } = makeTestContext({ editLease });
			ctx.startRunLeaseHeartbeat();
			let stopped = false;
			let stopping: Promise<void> | undefined;
			try {
				await vi.advanceTimersByTimeAsync(INTERVAL);
				expect(refresh).toHaveBeenCalledOnce();
				// A slow refresh does not create concurrent work at the next cadence.
				await vi.advanceTimersByTimeAsync(INTERVAL);
				expect(refresh).toHaveBeenCalledOnce();
				stopping = ctx.stopRunLeaseHeartbeat().then(() => {
					stopped = true;
				});
				await Promise.resolve();
				expect(stopped).toBe(false);
				expect(vi.getTimerCount()).toBe(0);
				ctx.handleAgentStep({}, "late step", "model");
				refreshing.resolve(true);
				await stopping;
				expect(stopped).toBe(true);
				await vi.advanceTimersByTimeAsync(INTERVAL * 2);
				ctx.handleAgentStep({}, "late step", "model");
				expect(refresh).toHaveBeenCalledOnce();
			} finally {
				refreshing.resolve(true);
				await stopping;
				await ctx.stopRunLeaseHeartbeat();
			}
		},
	);

	it("observes a failed in-flight refresh before stop returns", async () => {
		vi.useFakeTimers();
		const refreshing = Promise.withResolvers<boolean>();
		refreshBuildLiveness.mockReturnValue(refreshing.promise);
		const { ctx } = makeTestContext();
		let stopping: Promise<void> | undefined;
		try {
			ctx.startRunLeaseHeartbeat();
			await vi.advanceTimersByTimeAsync(INTERVAL);
			stopping = ctx.stopRunLeaseHeartbeat();
			const failure = new Error("Database disconnected");
			refreshing.reject(failure);
			await stopping;
			expect(log.error).toHaveBeenCalledWith(
				"[generation] run-lease heartbeat failed",
				failure,
				{ appId: "test-app" },
			);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			refreshing.resolve(true);
			await stopping;
			await ctx.stopRunLeaseHeartbeat();
		}
	});
});
