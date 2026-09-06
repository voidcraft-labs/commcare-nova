import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_CAPABILITIES } from "@/lib/runtimeCapabilities";
import {
	RUNTIME_BUILD_ID_ENV_KEY,
	RUNTIME_CAPABILITY_ENV_KEYS,
} from "@/lib/runtimeCapabilities/core.mts";
import { runtimeCapabilityEnvironment } from "@/lib/runtimeCapabilities/server";
import {
	assertRuntimeStartupHealth,
	checkStartupDatabaseConnectivity,
	STARTUP_DATABASE_QUERY_TIMEOUT_MS,
	StartupHealthCheckError,
} from "@/lib/runtimeCapabilities/startupHealth";

const BUILD_ID = "99ae1f72-048b-4515-8652-1f3caa669b99";

function productionEnvironment(): Record<string, string> {
	return {
		NODE_ENV: "production",
		...runtimeCapabilityEnvironment(RUNTIME_CAPABILITIES),
		[RUNTIME_BUILD_ID_ENV_KEY]: BUILD_ID,
	};
}

async function expectOpaqueFailure(operation: Promise<void>): Promise<void> {
	let error: unknown;
	try {
		await operation;
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(StartupHealthCheckError);
	expect(error).toMatchObject({
		name: "StartupHealthCheckError",
		message: "Startup health check failed",
	});
	if (!(error instanceof StartupHealthCheckError)) throw error;
	expect(error.cause).toBeUndefined();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("candidate startup health", () => {
	it("accepts the exact baked declaration and checks the database once", async () => {
		const checkDatabase = vi.fn(async () => {});
		await assertRuntimeStartupHealth({
			environment: productionEnvironment(),
			checkDatabase,
			readBakedBuildId: async () => BUILD_ID,
		});
		expect(checkDatabase).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(Object.values(RUNTIME_CAPABILITY_ENV_KEYS))(
		"fails closed before DB access when %s differs from the checked-in manifest",
		async (key) => {
			const environment = productionEnvironment();
			environment[key] = `${environment[key]}-drift`;
			const checkDatabase = vi.fn(async () => {});
			const readBakedBuildId = vi.fn(async () => BUILD_ID);
			await expectOpaqueFailure(
				assertRuntimeStartupHealth({
					environment,
					checkDatabase,
					readBakedBuildId,
				}),
			);
			expect(readBakedBuildId).not.toHaveBeenCalled();
			expect(checkDatabase).not.toHaveBeenCalled();
		},
	);

	it.each([undefined, "", "build-123", BUILD_ID.toUpperCase()])(
		"rejects malformed build identity %j before DB access",
		async (buildId) => {
			const environment: Record<string, string | undefined> =
				productionEnvironment();
			environment[RUNTIME_BUILD_ID_ENV_KEY] = buildId;
			const checkDatabase = vi.fn(async () => {});
			const readBakedBuildId = vi.fn(async () => BUILD_ID);
			await expectOpaqueFailure(
				assertRuntimeStartupHealth({
					environment,
					checkDatabase,
					readBakedBuildId,
				}),
			);
			expect(readBakedBuildId).not.toHaveBeenCalled();
			expect(checkDatabase).not.toHaveBeenCalled();
		},
	);

	it("does not let mutable NODE_ENV bypass an absent image declaration", async () => {
		const checkDatabase = vi.fn(async () => {});
		const readBakedBuildId = vi.fn(async () => BUILD_ID);
		await expectOpaqueFailure(
			assertRuntimeStartupHealth({
				environment: { NODE_ENV: "development" },
				checkDatabase,
				readBakedBuildId,
			}),
		);
		expect(checkDatabase).not.toHaveBeenCalled();
		expect(readBakedBuildId).not.toHaveBeenCalled();
	});

	it("rejects a mutable env build ID that differs from the baked image", async () => {
		const checkDatabase = vi.fn(async () => {});
		await expectOpaqueFailure(
			assertRuntimeStartupHealth({
				environment: productionEnvironment(),
				checkDatabase,
				readBakedBuildId: async () => "22a9ca50-3dbb-4012-a363-fd5517d4f13c",
			}),
		);
		expect(checkDatabase).not.toHaveBeenCalled();
	});

	it("fails opaquely when the immutable image identity cannot be read", async () => {
		const checkDatabase = vi.fn(async () => {});
		await expectOpaqueFailure(
			assertRuntimeStartupHealth({
				environment: productionEnvironment(),
				checkDatabase,
				readBakedBuildId: async () => {
					throw new Error("ENOENT /app/.nova-build-id secret-path-detail");
				},
			}),
		);
		expect(checkDatabase).not.toHaveBeenCalled();
	});

	it("collapses database errors without leaking their details", async () => {
		await expectOpaqueFailure(
			assertRuntimeStartupHealth({
				environment: productionEnvironment(),
				readBakedBuildId: async () => BUILD_ID,
				checkDatabase: async () => {
					throw new Error("password authentication failed for secret-user");
				},
			}),
		);
	});

	it("fails at the configured database deadline and observes a late database completion", async () => {
		let resolveDatabase!: () => void;
		const databaseResult = new Promise<void>((resolve) => {
			resolveDatabase = resolve;
		});
		let settled = false;
		const failure = expectOpaqueFailure(
			assertRuntimeStartupHealth({
				environment: productionEnvironment(),
				checkDatabase: () => databaseResult,
				databaseDeadlineMs: 25,
				readBakedBuildId: async () => BUILD_ID,
			}),
		).then(() => {
			settled = true;
		});
		try {
			await vi.advanceTimersByTimeAsync(24);
			expect(settled).toBe(false);
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(1);
			await failure;
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			resolveDatabase();
			await databaseResult;
			await failure;
		}
	});

	it("uses one bounded read-only connectivity query", async () => {
		const query = vi.fn(async () => ({ rows: [{ ok: 1 }] }));
		await checkStartupDatabaseConnectivity(query);
		expect(query).toHaveBeenCalledExactlyOnceWith({
			text: "SELECT 1::integer AS ok",
			query_timeout: STARTUP_DATABASE_QUERY_TIMEOUT_MS,
		});
	});

	it.each([
		{ rows: [] },
		{ rows: [{ ok: 0 }] },
		{ rows: [{ ok: 1 }, { ok: 1 }] },
	])("rejects unexpected connectivity rows $rows", async ({ rows }) => {
		await expect(
			checkStartupDatabaseConnectivity(async () => ({ rows })),
		).rejects.toThrow("database connectivity check returned an invalid result");
	});
});
