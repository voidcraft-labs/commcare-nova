import { beforeEach, describe, expect, it, vi } from "vitest";

const { assertRuntimeStartupHealth } = vi.hoisted(() => ({
	assertRuntimeStartupHealth: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/app/(app)/build/[id]/[[...path]]/page", () => ({}));
vi.mock("@/lib/runtimeCapabilities/startupHealth", () => ({
	assertRuntimeStartupHealth,
}));

import WarmupPage, { dynamic } from "../page";

describe("WarmupPage", () => {
	beforeEach(() => {
		assertRuntimeStartupHealth.mockReset();
		assertRuntimeStartupHealth.mockResolvedValue();
	});

	it("renders only the opaque success marker after startup admission", async () => {
		expect(dynamic).toBe("force-dynamic");
		const result = await WarmupPage();
		expect(assertRuntimeStartupHealth).toHaveBeenCalledTimes(1);
		expect(result).toEqual(<p>warm</p>);
	});

	it("does not render success when startup admission fails", async () => {
		const error = new Error("Startup health check failed");
		assertRuntimeStartupHealth.mockRejectedValue(error);
		await expect(WarmupPage()).rejects.toBe(error);
	});
});
