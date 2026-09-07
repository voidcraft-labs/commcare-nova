import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import {
	ALL_ICON_SLUGS,
	builtinIconPublicPath,
	builtinIconRef,
	builtinIconRefSchema,
	builtinIconsForSlot,
	FORM_ICON_SLUGS,
	formIconRefSchema,
	ICON_CATALOG,
	iconCatalogEntry,
	isBuiltinIconRef,
	MODULE_ICON_SLUGS,
	moduleIconRefSchema,
	parseBuiltinIconSlug,
} from "../builtinIcons";

// The media bridge suite verifies every shipped PNG's actual hash and byte size.
// This suite owns catalog identity, family admission and picker projection.
describe("built-in icon identities", () => {
	it("keeps the complete catalog unique, labelled and addressable", () => {
		const slugs = ICON_CATALOG.map((entry) => entry.slug);
		expect(ALL_ICON_SLUGS).toEqual(slugs);
		expect(new Set(slugs).size).toBe(slugs.length);
		for (const entry of ICON_CATALOG) {
			expect(entry.label.trim().length).toBeGreaterThan(0);
			expect(iconCatalogEntry(entry.slug)).toBe(entry);
			const ref = builtinIconRef(entry.slug);
			expect(ref).toBe(`nova-icon:${entry.slug}`);
			expect(builtinIconRefSchema.parse(ref)).toBe(ref);
			expect(isBuiltinIconRef(ref)).toBe(true);
			expect(parseBuiltinIconSlug(ref)).toBe(entry.slug);
			expect(builtinIconPublicPath(entry.slug)).toBe(
				`/nova-icons/${entry.slug}.png`,
			);
		}
		expect(iconCatalogEntry("missing")).toBeUndefined();
		expect(iconCatalogEntry("__proto__")).toBeUndefined();
	});

	it("admits each icon only in its declared family and shares the one fallback", () => {
		expect(
			ICON_CATALOG.filter((entry) => entry.kind === "fallback").map(
				(entry) => entry.slug,
			),
		).toEqual(["default"]);
		expect(iconCatalogEntry("household")?.kind).toBe("module");
		expect(iconCatalogEntry("register")?.kind).toBe("form");
		for (const [slot, schema, slugs] of [
			["module", moduleIconRefSchema, MODULE_ICON_SLUGS],
			["form", formIconRefSchema, FORM_ICON_SLUGS],
		] as const) {
			const offered = builtinIconsForSlot(slot);
			expect(offered.map((entry) => entry.slug)).toEqual(slugs);
			for (const entry of ICON_CATALOG) {
				const allowed = entry.kind === slot || entry.kind === "fallback";
				expect(
					schema.safeParse(builtinIconRef(entry.slug)).success,
					`${slot}/${entry.slug}`,
				).toBe(allowed);
				expect(offered.includes(entry), `${slot}/${entry.slug}`).toBe(allowed);
			}
			const uploaded = testMediaAssetId("uploaded-icon");
			expect(schema.parse(uploaded)).toBe(uploaded);
			expect(isBuiltinIconRef(uploaded)).toBe(false);
			expect(parseBuiltinIconSlug(uploaded)).toBeNull();
		}
	});

	it.each([
		"",
		"nova-icon:missing",
		"nova-icon:",
		"NOVA-ICON:household",
		"nova-icon:Household",
		" nova-icon:household",
		"nova-icon:household/../register",
		"nova-icon:household.png",
	])("rejects %s rather than interpreting only its prefix", (value) => {
		expect(isBuiltinIconRef(value)).toBe(false);
		expect(parseBuiltinIconSlug(value)).toBeNull();
		for (const schema of [
			builtinIconRefSchema,
			moduleIconRefSchema,
			formIconRefSchema,
		])
			expect(schema.safeParse(value).success).toBe(false);
	});
});
