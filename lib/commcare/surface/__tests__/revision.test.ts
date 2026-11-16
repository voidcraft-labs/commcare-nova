import { describe, expect, it } from "vitest";
import { isDeclaredSurfaceKey } from "../revision";
import { loadManifest } from "./loadManifest";

describe("isDeclaredSurfaceKey", () => {
	const manifest = loadManifest();

	it("is true for every key a checked-in inventory entry lists", () => {
		const keys = new Set(
			manifest.inventory.flatMap((entry) => entry.surfaceKeys),
		);
		expect(keys.size).toBeGreaterThan(0);
		for (const key of keys) expect(isDeclaredSurfaceKey(key)).toBe(true);
	});

	it("is true for every key a checked-in gate entry lists", () => {
		const keys = new Set(manifest.gates.flatMap((gate) => gate.surfaceKeys));
		expect(keys.size).toBeGreaterThan(0);
		for (const key of keys) expect(isDeclaredSurfaceKey(key)).toBe(true);
	});

	it("is false for an author's question id, in any shape a finding's name takes", () => {
		for (const name of [
			"household_size",
			"xform:household_size",
			"xform:data/household_size",
			"xform:model/instance/data/household_size",
			"Application.household_size",
			"schema:Application.household_size",
		]) {
			expect(isDeclaredSurfaceKey(name)).toBe(false);
		}
	});
});
