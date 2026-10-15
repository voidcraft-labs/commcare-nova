import { describe, expect, it } from "vitest";
import {
	fieldKindCarriesValidation,
	fieldKindDeclaresKey,
	fieldKinds,
	fieldRegistry,
} from "../fields";

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

describe("which kinds carry a validation", () => {
	it("is exactly the kinds whose schema declares validate", () => {
		for (const kind of fieldKinds) {
			expect(fieldKindCarriesValidation(kind), kind).toBe(
				fieldKindDeclaresKey(kind, "validate"),
			);
		}
		expect(fieldKinds.filter(fieldKindCarriesValidation).sort()).toEqual(
			[
				"barcode",
				"date",
				"datetime",
				"decimal",
				"int",
				"multi_select",
				"secret",
				"single_select",
				"text",
				"time",
			].sort(),
		);
	});
});
