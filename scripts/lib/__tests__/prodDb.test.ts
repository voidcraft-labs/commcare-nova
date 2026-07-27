import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { targetProdDb } from "../prodDb";

const { execFileSyncMock } = vi.hoisted(() => ({
	execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFileSync: execFileSyncMock,
}));

const ENV_KEYS = [
	"NOVA_DB_LOCAL_URL",
	"NOVA_DB_WORKLOAD",
	"NOVA_DB_IP_TYPE",
	"NOVA_DB_NAME",
	"NOVA_DB_INSTANCE_CONNECTION_NAME",
	"NOVA_DB_USER",
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
	for (const key of ENV_KEYS) {
		originalEnv.set(key, process.env[key]);
		delete process.env[key];
	}
	execFileSyncMock.mockReset();
	execFileSyncMock.mockReturnValue("operator@dimagi.com\n");
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = originalEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	originalEnv.clear();
});

describe("targetProdDb", () => {
	it("forces one-off production callers onto the explicit pool-one operator workload", () => {
		process.env.NOVA_DB_LOCAL_URL =
			"postgres://nova:nova@localhost:5432/nova_cases";
		process.env.NOVA_DB_WORKLOAD = "service";

		targetProdDb();

		expect(process.env.NOVA_DB_LOCAL_URL).toBeUndefined();
		expect(process.env.NOVA_DB_WORKLOAD).toBe("operator");
		expect(process.env.NOVA_DB_IP_TYPE).toBe("PUBLIC");
		expect(process.env.NOVA_DB_NAME).toBe("nova_cases");
		expect(process.env.NOVA_DB_INSTANCE_CONNECTION_NAME).toBe(
			"commcare-nova:us-central1:nova-cases",
		);
		expect(process.env.NOVA_DB_USER).toBe("operator@dimagi.com");
		expect(execFileSyncMock).toHaveBeenCalledWith(
			"gcloud",
			["config", "get-value", "account"],
			expect.objectContaining({ encoding: "utf8" }),
		);
	});
});
