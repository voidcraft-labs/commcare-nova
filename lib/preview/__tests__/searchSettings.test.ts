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
						propertyMatchers: [],
					},
				},
				{
					target: india,
					revision: "1",
					values: {
						maximum: 1500,
						timeZone: "Asia/Kolkata",
						propertyMatchers: [],
					},
				},
			],
		};
		expect(resolvePreviewSearchFacts(catalog)).toMatchObject({
			projectSpace: "clinic",
			maximum: null,
			timeZone: null,
			propertyMatchers: [],
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
	it("isolates destination disagreements to the request property and types they affect", () => {
		const rule = {
			caseType: "person",
			property: "name",
			fuzzy: true,
			ignoreLiterals: [],
		};
		const facts = resolvePreviewSearchFacts({
			projectId: "A",
			profiles: [
				{
					target: europe,
					revision: "1",
					values: { ...localSearchDefaults, propertyMatchers: [rule] },
				},
				{ target: india, revision: "3", values: localSearchDefaults },
			],
		});
		expect(previewSearchPropertyMatchers(facts, ["person"], "name")).toBeNull();
		expect(previewSearchPropertyMatchers(facts, ["clinic"], "name")).toEqual(
			[],
		);
		expect(
			previewSearchPropertyMatchers(facts, ["person"], "registration"),
		).toEqual([]);
	});
	it("distinguishes exact matching from unobserved rules and rejects competing rules, fixed offsets and unknown zones", () => {
		const row = {
			caseType: "patient",
			property: "external_id",
			fuzzy: false,
			ignoreLiterals: [".", "["],
		};
		expect(
			previewSearchValuesSchema.parse({
				...localSearchDefaults,
				propertyMatchers: [row],
			}).propertyMatchers,
		).toEqual([row]);
		expect(
			previewSearchValuesSchema.safeParse({
				...localSearchDefaults,
				propertyMatchers: [row, row],
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
