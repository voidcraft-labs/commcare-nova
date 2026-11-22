import { describe, expect, it } from "vitest";
import {
	localSearchDefaults,
	type PreviewSearchCatalog,
	type PreviewSearchTarget,
	previewSearchPropertyMatchers,
	previewSearchValuesSchema,
	resolvePreviewSearchFacts,
	unconfirmedSearchValues,
} from "../searchSettings";

const europe = { kind: "destination", server: "eu", domain: "clinic" } as const;
const india = {
	kind: "destination",
	server: "india",
	domain: "clinic",
} as const;
const local = { kind: "local" } as const;
const localCatalog: PreviewSearchCatalog = {
	projectId: "A",
	profiles: [{ target: local, revision: "0", values: localSearchDefaults }],
};

describe("facts a worker's search may use", () => {
	it("plays local defaults only after choosing Local Preview, and never borrows them for a new HQ adoption", () => {
		expect(resolvePreviewSearchFacts(localCatalog)).toMatchObject(
			unconfirmedSearchValues,
		);
		expect(resolvePreviewSearchFacts(localCatalog, local)).toMatchObject(
			localSearchDefaults,
		);
		const adopted = {
			projectId: "A",
			profiles: [
				{ target: europe, revision: "0", values: unconfirmedSearchValues },
			],
		};
		expect(resolvePreviewSearchFacts(adopted)).toMatchObject({
			...unconfirmedSearchValues,
			projectSpace: "clinic",
		});
		expect(resolvePreviewSearchFacts(adopted, local)).toMatchObject({
			...unconfirmedSearchValues,
			projectSpace: undefined,
		});
	});
	it("matches destinations on both server and domain and only plays agreed facts until a selection", () => {
		const catalog: PreviewSearchCatalog = {
			projectId: "A",
			profiles: [
				{
					target: europe,
					revision: "1",
					values: {
						maximum: 500,
						timeZone: "Europe/Paris",
						propertyMatchers: { fuzzyProperties: [], ignoredText: [] },
					},
				},
				{
					target: india,
					revision: "1",
					values: {
						maximum: 1500,
						timeZone: "Asia/Kolkata",
						propertyMatchers: { fuzzyProperties: [], ignoredText: [] },
					},
				},
			],
		};
		expect(resolvePreviewSearchFacts(catalog)).toMatchObject({
			projectSpace: "clinic",
			maximum: null,
			timeZone: null,
			propertyMatchers: { fuzzyProperties: [], ignoredText: [] },
		});
		const selected = resolvePreviewSearchFacts(catalog, india);
		expect(selected).toMatchObject({
			projectSpace: "clinic",
			maximum: 1500,
			timeZone: "Asia/Kolkata",
		});
		expect(resolvePreviewSearchFacts(catalog, europe).revision).not.toBe(
			selected.revision,
		);
		expect(
			resolvePreviewSearchFacts({ ...catalog, projectId: "B" }, india).revision,
		).not.toBe(selected.revision);
		expect(
			resolvePreviewSearchFacts(
				{
					...catalog,
					profiles: catalog.profiles.map((p) => ({ ...p, revision: "2" })),
				},
				india,
			).revision,
		).not.toBe(selected.revision);
		const missing: PreviewSearchTarget = { ...india, domain: "another" };
		expect(resolvePreviewSearchFacts(catalog, missing)).toMatchObject(
			unconfirmedSearchValues,
		);
	});
	it("compares effective native matching on only the requested types and property", () => {
		const address = { caseType: "patient", property: "badge" };
		const rule = { ...address, fuzzy: false };
		const withRules = (
			matchers: PreviewSearchCatalog["profiles"][number]["values"]["propertyMatchers"],
		) => ({
			projectId: "A",
			profiles: [
				{ target: europe, revision: "1", values: localSearchDefaults },
				{
					target: india,
					revision: "3",
					values: { ...localSearchDefaults, propertyMatchers: matchers },
				},
			],
		});
		const exact = { fuzzy: false, ignoreLiterals: [] };
		const noop = resolvePreviewSearchFacts(
			withRules({ fuzzyProperties: [rule], ignoredText: [] }),
		);
		expect(previewSearchPropertyMatchers(noop, ["patient"], "badge")).toEqual(
			exact,
		);
		const different = resolvePreviewSearchFacts(
			withRules({
				fuzzyProperties: [{ ...rule, fuzzy: true }],
				ignoredText: [],
			}),
		);
		expect(
			previewSearchPropertyMatchers(different, ["patient"], "badge"),
		).toBeNull();
		expect(
			previewSearchPropertyMatchers(different, ["clinic"], "badge"),
		).toEqual(exact);
		expect(
			previewSearchPropertyMatchers(different, ["patient"], "name"),
		).toEqual(exact);
		expect(
			previewSearchPropertyMatchers(
				resolvePreviewSearchFacts(withRules(null)),
				["patient"],
				"badge",
			),
		).toBeNull();
	});
	it("preserves interleaved ignored text across types and compares its order across destinations", () => {
		const a = { caseType: "patient", property: "badge" };
		const b = { caseType: "doctor", property: "badge" };
		const ignoredText = [
			{ ...a, literal: "ab" },
			{ ...b, literal: "bc" },
			{ ...a, literal: "c" },
		];
		const config = { fuzzyProperties: [{ ...b, fuzzy: true }], ignoredText };
		const apply = (args: string[], value: string) =>
			args.reduce((text, literal) => text.replaceAll(literal, ""), value);
		const fact = (second: typeof config) =>
			resolvePreviewSearchFacts({
				projectId: "A",
				profiles: [
					{
						target: europe,
						revision: "1",
						values: { ...localSearchDefaults, propertyMatchers: config },
					},
					{
						target: india,
						revision: "2",
						values: { ...localSearchDefaults, propertyMatchers: second },
					},
				],
			});
		const combined = previewSearchPropertyMatchers(
			fact(config),
			["doctor", "patient"],
			"badge",
		);
		expect(combined).toEqual({
			fuzzy: true,
			ignoreLiterals: ["ab", "bc", "c"],
		});
		if (!combined) throw new Error("Expected the confirmed matcher.");
		expect(
			["abc", "bc"].map((v) => apply([...combined.ignoreLiterals], v)),
		).toEqual(["", ""]);
		const reordered = {
			...config,
			ignoredText: [ignoredText[0], ignoredText[2], ignoredText[1]],
		};
		expect(
			previewSearchPropertyMatchers(
				fact(reordered),
				["patient", "doctor"],
				"badge",
			),
		).toBeNull();
		expect(
			previewSearchPropertyMatchers(fact(reordered), ["patient"], "badge"),
		).toEqual({ fuzzy: false, ignoreLiterals: ["ab", "c"] });
	});
	it("rejects conflicting fuzzy settings, fixed offsets and unknown zones", () => {
		const row = { caseType: "patient", property: "external_id", fuzzy: true };
		expect(
			previewSearchValuesSchema.safeParse({
				...localSearchDefaults,
				propertyMatchers: {
					fuzzyProperties: [row, { ...row, fuzzy: false }],
					ignoredText: [],
				},
			}).success,
		).toBe(false);
		for (const zone of ["+08:00", "Unobserved/City"])
			expect(
				previewSearchValuesSchema.safeParse({
					...localSearchDefaults,
					timeZone: zone,
				}).success,
			).toBe(false);
	});
});
