import { describe, expect, it, vi } from "vitest";
import { createRecoverableLazyModule } from "@/components/builder/inspector/lazyInspectorBodies";

describe("recoverable Builder editor imports", () => {
	it("publishes a failed import and lets the mounted consumer retry it", async () => {
		const loaded = { component: "ready" } as const;
		const importer = vi
			.fn<() => Promise<typeof loaded>>()
			.mockRejectedValueOnce(new Error("transient chunk failure"))
			.mockResolvedValueOnce(loaded);
		const cache = createRecoverableLazyModule(importer);
		const statuses: string[] = [];
		const unsubscribe = cache.subscribe(() => {
			statuses.push(cache.getSnapshot().status);
		});

		expect(cache.getSnapshot()).toEqual({ status: "idle" });
		await expect(cache.load()).rejects.toThrow("transient chunk failure");
		expect(cache.getSnapshot()).toEqual({ status: "error" });

		const retry = cache.load();
		expect(cache.getSnapshot()).toEqual({ status: "loading" });
		await expect(retry).resolves.toBe(loaded);
		expect(cache.getSnapshot()).toEqual({ status: "ready", module: loaded });
		expect(statuses).toEqual(["loading", "error", "loading", "ready"]);
		expect(importer).toHaveBeenCalledTimes(2);

		unsubscribe();
	});
});
