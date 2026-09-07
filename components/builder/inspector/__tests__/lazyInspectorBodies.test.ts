import { describe, expect, it } from "vitest";
import {
	createRecoverableLazyModule,
	getLazyModuleServerSnapshot,
} from "../lazyInspectorBodies";

describe("recoverable Builder import owner", () => {
	it("publishes rejection and shares one retry request through readiness", async () => {
		const loaded = { component: "ready" };
		let attempts = 0;
		const cache = createRecoverableLazyModule(async () => {
			attempts++;
			if (attempts === 1) throw new Error("chunk failure");
			return loaded;
		});
		const statuses: string[] = [];
		const unsubscribe = cache.subscribe(() =>
			statuses.push(cache.getSnapshot().status),
		);
		try {
			expect(cache.getSnapshot()).toStrictEqual({ status: "idle" });
			const first = cache.load();
			const sharedFirst = cache.load();
			await Promise.all([
				expect(first).rejects.toThrow("chunk failure"),
				expect(sharedFirst).rejects.toThrow("chunk failure"),
			]);
			expect(sharedFirst).toBe(first);
			expect(cache.getSnapshot()).toStrictEqual({ status: "error" });
			const retry = cache.load();
			const sharedRetry = cache.load();
			await Promise.all([
				expect(retry).resolves.toBe(loaded),
				expect(sharedRetry).resolves.toBe(loaded),
			]);
			expect(sharedRetry).toBe(retry);
			expect(cache.getSnapshot()).toStrictEqual({
				status: "ready",
				module: loaded,
			});
			await expect(cache.load()).resolves.toBe(loaded);
			expect(attempts).toBe(2);
			expect(statuses).toStrictEqual(["loading", "error", "loading", "ready"]);
		} finally {
			unsubscribe();
		}
	});
	it("keeps snapshots referentially stable and stops notifying an unsubscribed consumer", async () => {
		let resolve!: (value: string) => void;
		const request = new Promise<string>((done) => {
			resolve = done;
		});
		const cache = createRecoverableLazyModule(() => request);
		let notifications = 0;
		const unsubscribe = cache.subscribe(() => notifications++);
		const idle = cache.getSnapshot();
		expect(cache.getSnapshot()).toBe(idle);
		const loading = cache.load();
		try {
			const snapshot = cache.getSnapshot();
			expect(cache.getSnapshot()).toBe(snapshot);
			expect(snapshot).not.toBe(idle);
		} finally {
			unsubscribe();
			resolve("module");
			await loading;
		}
		expect(notifications).toBe(1);
		expect(cache.getSnapshot()).toStrictEqual({
			status: "ready",
			module: "module",
		});
		expect(getLazyModuleServerSnapshot()).toBe(getLazyModuleServerSnapshot());
		expect(getLazyModuleServerSnapshot()).toStrictEqual({ status: "idle" });
	});
});
