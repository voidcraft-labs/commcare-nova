import { describe, expect, it, vi } from "vitest";
import { createProjectScopeResetRegistry } from "@/lib/collab/projectScopeReset";

describe("project-scope reset registry", () => {
	it("fans out newer epochs once and supports unsubscribe", () => {
		const registry = createProjectScopeResetRegistry();
		const first = vi.fn();
		const second = vi.fn();
		const unsubscribe = registry.subscribe(first);
		registry.subscribe(second);

		registry.reset(1);
		registry.reset(1);
		unsubscribe();
		registry.reset(2);

		expect(first).toHaveBeenCalledTimes(1);
		expect(first).toHaveBeenCalledWith(1);
		expect(second.mock.calls).toEqual([[1], [2]]);
	});

	it("calls every cache then fails closed when any reset fails", () => {
		const registry = createProjectScopeResetRegistry();
		const survivor = vi.fn();
		registry.subscribe(() => {
			throw new Error("cache reset failed");
		});
		registry.subscribe(survivor);

		expect(() => registry.reset(1)).toThrow(AggregateError);

		expect(survivor).toHaveBeenCalledWith(1);
		expect(registry.isCurrent(1)).toBe(true);
	});

	it("rejects late async work captured under an older epoch", () => {
		const registry = createProjectScopeResetRegistry();
		registry.reset(1);
		const capturedEpoch = 1;
		registry.reset(2);

		expect(registry.isCurrent(capturedEpoch)).toBe(false);
		expect(registry.isCurrent(2)).toBe(true);
	});
});
