import { afterEach, describe, expect, it, vi } from "vitest";
import { withExclusiveCaptureCleanupWorker } from "../captureCleanupLease";

const { getCaseStorePoolMock } = vi.hoisted(() => ({
	getCaseStorePoolMock: vi.fn(),
}));

vi.mock("@/lib/case-store/postgres/connection", () => ({
	getCaseStorePool: getCaseStorePoolMock,
}));

afterEach(() => {
	vi.clearAllMocks();
});

describe("withExclusiveCaptureCleanupWorker", () => {
	it("runs maintenance while holding one session lock and releases it afterward", async () => {
		const query = vi
			.fn()
			.mockResolvedValueOnce({ rows: [{ acquired: true }] })
			.mockResolvedValueOnce({ rows: [{ unlocked: true }] });
		const release = vi.fn();
		getCaseStorePoolMock.mockResolvedValue({
			connect: vi.fn().mockResolvedValue({ query, release }),
		});
		const maintenance = vi.fn().mockResolvedValue("complete");

		await expect(
			withExclusiveCaptureCleanupWorker(maintenance),
		).resolves.toEqual({ kind: "ran", value: "complete" });
		expect(maintenance).toHaveBeenCalledTimes(1);
		expect(query.mock.calls[0]?.[0]).toContain("pg_try_advisory_lock");
		expect(query.mock.calls[1]?.[0]).toContain("pg_advisory_unlock");
		expect(release).toHaveBeenCalledWith();
	});

	it("does not run a second worker when the session lock is already held", async () => {
		const query = vi.fn().mockResolvedValue({ rows: [{ acquired: false }] });
		const release = vi.fn();
		getCaseStorePoolMock.mockResolvedValue({
			connect: vi.fn().mockResolvedValue({ query, release }),
		});
		const maintenance = vi.fn();

		await expect(
			withExclusiveCaptureCleanupWorker(maintenance),
		).resolves.toEqual({ kind: "already-running" });
		expect(maintenance).not.toHaveBeenCalled();
		expect(query).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledWith(true);
	});

	it("treats a role connection-limit rejection as a saturated losing dispatch", async () => {
		const saturated = Object.assign(
			new Error("too many connections for role"),
			{
				code: "53300",
			},
		);
		getCaseStorePoolMock.mockResolvedValue({
			connect: vi.fn().mockRejectedValue(saturated),
		});
		const maintenance = vi.fn();

		await expect(
			withExclusiveCaptureCleanupWorker(maintenance),
		).resolves.toEqual({ kind: "saturated" });
		expect(maintenance).not.toHaveBeenCalled();
	});

	it("admits one graceful loser and fails further overlapping contenders closed", async () => {
		let releaseMaintenance: (() => void) | undefined;
		const maintenanceHold = new Promise<void>((resolve) => {
			releaseMaintenance = resolve;
		});
		let markMaintenanceStarted: (() => void) | undefined;
		const maintenanceStarted = new Promise<void>((resolve) => {
			markMaintenanceStarted = resolve;
		});

		const ownerQuery = vi
			.fn()
			.mockResolvedValueOnce({ rows: [{ acquired: true }] })
			.mockResolvedValueOnce({ rows: [{ unlocked: true }] });
		const loserQuery = vi
			.fn()
			.mockResolvedValueOnce({ rows: [{ acquired: false }] });
		const ownerRelease = vi.fn();
		const workRelease = vi.fn();
		const loserRelease = vi.fn();
		const saturated = Object.assign(
			new Error("too many connections for role"),
			{
				code: "53300",
			},
		);
		const connect = vi
			.fn()
			.mockResolvedValueOnce({ query: ownerQuery, release: ownerRelease })
			.mockResolvedValueOnce({ query: vi.fn(), release: workRelease })
			.mockResolvedValueOnce({ query: loserQuery, release: loserRelease })
			.mockRejectedValueOnce(saturated);
		getCaseStorePoolMock.mockResolvedValue({ connect });

		const owner = withExclusiveCaptureCleanupWorker(async () => {
			markMaintenanceStarted?.();
			await maintenanceHold;
			return "complete";
		});
		await maintenanceStarted;

		await expect(withExclusiveCaptureCleanupWorker(vi.fn())).resolves.toEqual({
			kind: "already-running",
		});
		await expect(withExclusiveCaptureCleanupWorker(vi.fn())).resolves.toEqual({
			kind: "saturated",
		});

		releaseMaintenance?.();
		await expect(owner).resolves.toEqual({ kind: "ran", value: "complete" });
		expect(ownerRelease).toHaveBeenCalledWith();
		expect(workRelease).toHaveBeenCalledWith();
		expect(loserRelease).toHaveBeenCalledWith(true);
	});

	it("prewarms the owner's work connection after concurrent losing probes exit", async () => {
		let resolveAllInitialConnections: (() => void) | undefined;
		const allInitialConnections = new Promise<void>((resolve) => {
			resolveAllInitialConnections = resolve;
		});
		let resolveFirstReserveAttempt: (() => void) | undefined;
		const firstReserveAttempt = new Promise<void>((resolve) => {
			resolveFirstReserveAttempt = resolve;
		});
		let resolveLosersClosed: (() => void) | undefined;
		const losersClosed = new Promise<void>((resolve) => {
			resolveLosersClosed = resolve;
		});

		let loserCloseCount = 0;
		const ownerRelease = vi.fn();
		const ownerQuery = vi.fn(async (text: string) => {
			if (text.includes("pg_try_advisory_lock")) {
				await allInitialConnections;
				return { rows: [{ acquired: true }] };
			}
			return { rows: [{ unlocked: true }] };
		});
		const loserClient = () => ({
			query: vi.fn(async () => {
				await firstReserveAttempt;
				return { rows: [{ acquired: false }] };
			}),
			release: vi.fn((destroy?: boolean) => {
				expect(destroy).toBe(true);
				loserCloseCount += 1;
				if (loserCloseCount === 2) resolveLosersClosed?.();
			}),
		});
		const loserOne = loserClient();
		const loserTwo = loserClient();
		const workRelease = vi.fn();
		const saturated = Object.assign(new Error("role cap reached"), {
			code: "53300",
		});
		let connectCall = 0;
		const connect = vi.fn(async () => {
			connectCall += 1;
			if (connectCall === 1) {
				return { query: ownerQuery, release: ownerRelease };
			}
			if (connectCall === 2) return loserOne;
			if (connectCall === 3) {
				resolveAllInitialConnections?.();
				return loserTwo;
			}
			if (connectCall === 4) {
				resolveFirstReserveAttempt?.();
				throw saturated;
			}
			return { query: vi.fn(), release: workRelease };
		});
		getCaseStorePoolMock.mockResolvedValue({ connect });
		const maintenance = vi.fn().mockResolvedValue("complete");
		const options = {
			workConnectionTimeoutMs: 1_000,
			now: () => 0,
			sleep: async () => {
				await losersClosed;
			},
		};

		const owner = withExclusiveCaptureCleanupWorker(maintenance, options);
		const loserOneResult = withExclusiveCaptureCleanupWorker(vi.fn(), options);
		const loserTwoResult = withExclusiveCaptureCleanupWorker(vi.fn(), options);

		await expect(
			Promise.all([loserOneResult, loserTwoResult]),
		).resolves.toEqual([
			{ kind: "already-running" },
			{ kind: "already-running" },
		]);
		await expect(owner).resolves.toEqual({
			kind: "ran",
			value: "complete",
		});
		expect(maintenance).toHaveBeenCalledTimes(1);
		expect(connect).toHaveBeenCalledTimes(5);
		expect(workRelease).toHaveBeenCalledWith();
	});

	it("unlocks and fails hard when the owner cannot reserve a work connection", async () => {
		const ownerQuery = vi
			.fn()
			.mockResolvedValueOnce({ rows: [{ acquired: true }] })
			.mockResolvedValueOnce({ rows: [{ unlocked: true }] });
		const ownerRelease = vi.fn();
		const saturated = Object.assign(new Error("role cap remains full"), {
			code: "53300",
		});
		const connect = vi
			.fn()
			.mockResolvedValueOnce({ query: ownerQuery, release: ownerRelease })
			.mockRejectedValue(saturated);
		getCaseStorePoolMock.mockResolvedValue({ connect });
		const maintenance = vi.fn();
		let clock = 0;

		await expect(
			withExclusiveCaptureCleanupWorker(maintenance, {
				workConnectionTimeoutMs: 200,
				workConnectionRetryMs: 100,
				now: () => clock,
				sleep: async (milliseconds) => {
					clock += milliseconds;
				},
			}),
		).rejects.toMatchObject({ code: "53300" });
		expect(maintenance).not.toHaveBeenCalled();
		expect(ownerQuery.mock.calls[1]?.[0]).toContain("pg_advisory_unlock");
		expect(ownerRelease).toHaveBeenCalledWith();
	});

	it("unlocks the owner session when maintenance fails", async () => {
		const query = vi
			.fn()
			.mockResolvedValueOnce({ rows: [{ acquired: true }] })
			.mockResolvedValueOnce({ rows: [{ unlocked: true }] });
		const release = vi.fn();
		getCaseStorePoolMock.mockResolvedValue({
			connect: vi.fn().mockResolvedValue({ query, release }),
		});

		await expect(
			withExclusiveCaptureCleanupWorker(async () => {
				throw new Error("maintenance failed");
			}),
		).rejects.toThrow("maintenance failed");
		expect(query.mock.calls[1]?.[0]).toContain("pg_advisory_unlock");
		expect(release).toHaveBeenCalledWith();
	});

	it("unlocks and fails when the active owner's work connection hits its role limit", async () => {
		const query = vi
			.fn()
			.mockResolvedValueOnce({ rows: [{ acquired: true }] })
			.mockResolvedValueOnce({ rows: [{ unlocked: true }] });
		const release = vi.fn();
		getCaseStorePoolMock.mockResolvedValue({
			connect: vi.fn().mockResolvedValue({ query, release }),
		});

		await expect(
			withExclusiveCaptureCleanupWorker(async () => {
				throw Object.assign(new Error("too many connections for role"), {
					code: "53300",
				});
			}),
		).rejects.toMatchObject({ code: "53300" });
		expect(query.mock.calls[1]?.[0]).toContain("pg_advisory_unlock");
		expect(release).toHaveBeenCalledWith();
	});

	it("destroys a session that cannot prove its advisory lock was released", async () => {
		const query = vi
			.fn()
			.mockResolvedValueOnce({ rows: [{ acquired: true }] })
			.mockResolvedValueOnce({ rows: [{ unlocked: false }] });
		const release = vi.fn();
		getCaseStorePoolMock.mockResolvedValue({
			connect: vi.fn().mockResolvedValue({ query, release }),
		});

		await expect(
			withExclusiveCaptureCleanupWorker(async () => "complete"),
		).rejects.toThrow("was not held");
		expect(release).toHaveBeenCalledWith(expect.any(Error));
	});
});
