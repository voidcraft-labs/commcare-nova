import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCaseStorePool } = vi.hoisted(() => ({
	getCaseStorePool: vi.fn(),
}));

vi.mock("@/lib/case-store/postgres/connection", () => ({
	getCaseStorePool,
	POOL_MAX_PER_INSTANCE: 3,
}));

const { mediaObjectLockIdentity, withMediaObjectKeyLock } = await import(
	"../mediaObjectKeyLock"
);

function fakeClient(assetId = "asset-1") {
	const query = vi.fn(async (statement: string, _params?: unknown[]) => {
		if (statement.includes("pg_advisory_unlock")) {
			return { command: "SELECT", rowCount: 1, rows: [{ unlocked: true }] };
		}
		if (statement.includes('from "media_assets"')) {
			return {
				command: "SELECT",
				rowCount: 1,
				rows: [{ id: assetId }],
			};
		}
		return { command: "SELECT", rowCount: 1, rows: [{}] };
	});
	return {
		query,
		release: vi.fn(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("withMediaObjectKeyLock", () => {
	it("collapses cross-extension final objects to one Project/hash identity", () => {
		const hash = "a".repeat(64);
		expect(mediaObjectLockIdentity(`projects/project-1/${hash}.txt`)).toBe(
			`projects/project-1/${hash}`,
		);
		expect(mediaObjectLockIdentity(`projects/project-1/${hash}.md`)).toBe(
			`projects/project-1/${hash}`,
		);
		expect(
			mediaObjectLockIdentity(`projects/project-1/${hash}.extract.v2.md`),
		).toBe(`projects/project-1/${hash}`);
		expect(mediaObjectLockIdentity("pending/project-1/attempt.txt")).toBe(
			"pending/project-1/attempt.txt",
		);
	});

	it("runs metadata SQL on the same checked-out session as the advisory lock", async () => {
		const client = fakeClient("same-session-asset");
		const connect = vi.fn(async () => client);
		getCaseStorePool.mockResolvedValue({ connect, options: {} });

		const result = await withMediaObjectKeyLock(
			"projects/project-1/hash.png",
			async (lockedDb) =>
				lockedDb
					.selectFrom("media_assets")
					.select("id")
					.where("id", "=", "same-session-asset")
					.executeTakeFirst(),
		);

		expect(result).toEqual({ id: "same-session-asset" });
		expect(connect).toHaveBeenCalledOnce();
		expect(client.query).toHaveBeenCalledTimes(3);
		expect(client.query.mock.calls[0]?.[0]).toContain("pg_advisory_lock");
		expect(client.query.mock.calls[1]?.[0]).toContain('from "media_assets"');
		expect(client.query.mock.calls[2]?.[0]).toContain("pg_advisory_unlock");
		expect(client.release).toHaveBeenCalledOnce();
	});

	it("passes the same advisory identity for identical bytes with different extensions", async () => {
		const hash = "b".repeat(64);
		const clients = [fakeClient("txt"), fakeClient("markdown")];
		let nextClient = 0;
		getCaseStorePool.mockResolvedValue({
			connect: vi.fn(async () => clients[nextClient++]),
			options: {},
		});

		await Promise.all([
			withMediaObjectKeyLock(
				`projects/project-1/${hash}.txt`,
				async () => undefined,
			),
			withMediaObjectKeyLock(
				`projects/project-1/${hash}.md`,
				async () => undefined,
			),
		]);

		const lockIdentities = clients.map(
			(client) => client.query.mock.calls[0]?.[1]?.[0],
		);
		expect(lockIdentities).toEqual([
			`projects/project-1/${hash}`,
			`projects/project-1/${hash}`,
		]);
	});

	it("leaves one connection of the three-slot pool available", async () => {
		const clients = [fakeClient("a"), fakeClient("b"), fakeClient("c")];
		let nextClient = 0;
		const connect = vi.fn(async () => clients[nextClient++]);
		getCaseStorePool.mockResolvedValue({ connect, options: {} });
		let active = 0;
		let peak = 0;
		let signalTwo!: () => void;
		const twoEntered = new Promise<void>((resolve) => {
			signalTwo = resolve;
		});
		let releaseBodies!: () => void;
		const bodiesReleased = new Promise<void>((resolve) => {
			releaseBodies = resolve;
		});
		const calls = ["a", "b", "c"].map((key) =>
			withMediaObjectKeyLock(key, async () => {
				active++;
				peak = Math.max(peak, active);
				if (active === 2) signalTwo();
				await bodiesReleased;
				active--;
			}),
		);

		await twoEntered;
		expect(connect).toHaveBeenCalledTimes(2);
		releaseBodies();
		await Promise.all(calls);

		expect(peak).toBe(2);
		expect(connect).toHaveBeenCalledTimes(3);
		for (const client of clients) {
			expect(client.release).toHaveBeenCalledOnce();
		}
	});
});
