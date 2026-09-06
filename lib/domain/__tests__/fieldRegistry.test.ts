import { describe, expect, it } from "vitest";
import { fieldKinds, fieldRegistry } from "../fields";

describe("field metadata consumed by pickers", () => {
	it("provides one named, drawable entry and distinct conversion targets per kind", () => {
		expect(Object.keys(fieldRegistry).sort()).toEqual([...fieldKinds].sort());
		for (const kind of fieldKinds) {
			const meta = fieldRegistry[kind];
			expect(meta.kind).toBe(kind);
			expect(meta.label.trim().length, kind).toBeGreaterThan(0);
			expect(meta.icon.body.trim(), kind).toMatch(/^</);
			expect(new Set(meta.convertTargets).size, kind).toBe(
				meta.convertTargets.length,
			);
			expect(meta.convertTargets, kind).not.toContain(kind);
			for (const target of meta.convertTargets)
				expect(Object.hasOwn(fieldRegistry, target)).toBe(true);
		}
	});
});
