/** Actual schema-to-workspace/reducer behavior over admitted documents.
 * The commit receipt is controlled; this suite does not model SQL or MCP. */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type BlueprintDoc,
	type CaseSearchConfig,
	isOrdinaryCaseSearchConfig,
	isOwnerOnlyCaseSearchConfig,
	type OrdinaryCaseSearchConfig,
	type OwnerOnlyCaseSearchConfig,
} from "@/lib/domain";
import { matchAll, prop, term } from "@/lib/domain/predicate";
import { setCaseSearchAdvancedTool } from "../setCaseSearchAdvanced";
import { MOD_A, makeCaseSearchDoc, makeCaseSearchFixture } from "./fixtures";

const MISSING_MODULE = testUuid("missing-case-search-module");

function ordinary(
	config: CaseSearchConfig | undefined,
): OrdinaryCaseSearchConfig {
	if (!isOrdinaryCaseSearchConfig(config)) {
		throw new Error("expected ordinary Search config");
	}
	return config;
}

function ownerOnly(
	config: CaseSearchConfig | undefined,
): OwnerOnlyCaseSearchConfig {
	if (!isOwnerOnlyCaseSearchConfig(config)) {
		throw new Error("expected owner-only Search config");
	}
	return config;
}

describe("setCaseSearchAdvanced", () => {
	it("rejects case-property reads at actual tool-input admission", async () => {
		const h = makeCaseSearchFixture();
		await expect(
			h.runTool(setCaseSearchAdvancedTool, {
				moduleUuid: MOD_A,
				excludedOwnerIds: term(prop("patient", "external_id")),
				searchFirst: null,
			}),
		).rejects.toThrow("before a case is selected");
		expect(h.currentDoc()).toEqual(h.doc);
		expect(h.host.recordMutations).not.toHaveBeenCalled();
	});

	it("sets the advanced cluster to the supplied values", async () => {
		const h = makeCaseSearchFixture();
		const excluded = term({ kind: "literal", value: "owner-a owner-b" });

		const result = await h.runTool(setCaseSearchAdvancedTool, {
			moduleUuid: MOD_A,
			excludedOwnerIds: excluded,
			searchFirst: null,
		});

		expect(result.kind).toBe("mutate");
		const config = h.currentDoc().modules[MOD_A]?.caseSearchConfig;
		expect(config?.excludedOwnerIds).toEqual(excluded);
	});

	it("surfaces the slot the SA set on the success result", async () => {
		// Both surfaces — the structured `advancedSlotsSet` array AND
		// the prose message — derive from `ADVANCED_SLOT_NAMES` via the
		// shared `slotsSetByInput` projection, so the SA can confirm
		// the tool ran without re-reading the config.
		const h = makeCaseSearchFixture();
		const result = await h.runTool(setCaseSearchAdvancedTool, {
			moduleUuid: MOD_A,
			excludedOwnerIds: term({ kind: "literal", value: "owner-a" }),
			searchFirst: null,
		});
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.advancedSlotsSet).toEqual(["excludedOwnerIds"]);
		expect(result.result.message).toContain("excludedOwnerIds");
	});

	it("clears the excluded owner ids slot when null is passed", async () => {
		// Seed a config with the slot populated, then null-clear it.
		// The persisted shape must omit the cleared key rather than carry
		// `key: undefined` — same convention as `setCaseListFilter`'s
		// null-clear test.
		const baseDoc = makeCaseSearchDoc();
		const seededDoc: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseSearchConfig: {
						excludedOwnerIds: term({
							kind: "literal",
							value: "owner-a",
						}),
					},
				},
			},
		};

		const h = makeCaseSearchFixture(seededDoc);
		const result = await h.runTool(setCaseSearchAdvancedTool, {
			moduleUuid: MOD_A,
			excludedOwnerIds: null,
			searchFirst: null,
		});

		const config = h.currentDoc().modules[MOD_A]?.caseSearchConfig;
		expect(config).toBeUndefined();
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		// Wholesale-clear shape — empty `advancedSlotsSet` array AND a
		// "Cleared every …" prose branch. Both surfaces drop in lockstep
		// off the same `slotsSetByInput` projection.
		expect(result.result.advancedSlotsSet).toEqual([]);
		expect(result.result.message).toContain("Cleared every");
	});

	it("preserves display cluster when setting advanced", async () => {
		// Cross-cluster preservation contract — advanced and display are
		// independent. Setting one cluster must NOT clobber any slot
		// owned by the other.
		const baseDoc = makeCaseSearchDoc();
		const seededDoc: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseSearchConfig: {
						searchScreenTitle: "Find a patient",
						searchScreenSubtitle: "Type to filter",
						searchButtonLabel: "Search",
						searchButtonDisplayCondition: matchAll(),
					},
				},
			},
		};

		const h = makeCaseSearchFixture(seededDoc);
		await h.runTool(setCaseSearchAdvancedTool, {
			moduleUuid: MOD_A,
			excludedOwnerIds: term({ kind: "literal", value: "owner-x" }),
			searchFirst: null,
		});

		const config = h.currentDoc().modules[MOD_A]?.caseSearchConfig;
		const search = ordinary(config);
		expect(search.searchScreenTitle).toBe("Find a patient");
		expect(search.searchScreenSubtitle).toBe("Type to filter");
		expect(search.searchButtonLabel).toBe("Search");
		expect(search.searchButtonDisplayCondition).toEqual(matchAll());
		// Advanced cluster updated.
		expect(search.excludedOwnerIds).toBeDefined();
	});

	it("returns an Elm-style error for an unknown module UUID", async () => {
		const h = makeCaseSearchFixture();
		const result = await h.runTool(setCaseSearchAdvancedTool, {
			moduleUuid: MISSING_MODULE,
			excludedOwnerIds: null,
			searchFirst: null,
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain(MISSING_MODULE);
		expect(result.result.error).toContain("No module with UUID");
	});

	it("initializes the caseSearchConfig when the module has none", async () => {
		const baseDoc = makeCaseSearchDoc();
		const baseMod = baseDoc.modules[MOD_A];
		const docWithoutConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: { ...baseMod, caseSearchConfig: undefined },
			},
		};

		const h = makeCaseSearchFixture(docWithoutConfig);
		await h.runTool(setCaseSearchAdvancedTool, {
			moduleUuid: MOD_A,
			excludedOwnerIds: term({ kind: "literal", value: "owner-a" }),
			searchFirst: null,
		});

		const config = h.currentDoc().modules[MOD_A]?.caseSearchConfig;
		expect(ordinary(config).excludedOwnerIds).toBeDefined();
	});

	it("marks a fresh owner-only rule as not authoring Search", async () => {
		const baseDoc = makeCaseSearchDoc();
		const mod = baseDoc.modules[MOD_A];
		if (mod?.caseListConfig === undefined) {
			throw new Error("fixture must carry a case-list config");
		}
		const ownerOnlyDoc: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...mod,
					caseListConfig: {
						...mod.caseListConfig,
						searchInputs: [],
					},
					caseSearchConfig: undefined,
				},
			},
		};
		const h = makeCaseSearchFixture(ownerOnlyDoc);
		await h.runTool(setCaseSearchAdvancedTool, {
			moduleUuid: MOD_A,
			excludedOwnerIds: term({ kind: "literal", value: "owner-a" }),
			searchFirst: null,
		});
		expect(
			ownerOnly(h.currentDoc().modules[MOD_A]?.caseSearchConfig)
				.searchActionEnabled,
		).toBe(false);
	});

	it("deletes the owner-only config when its owner rule is cleared", async () => {
		const baseDoc = makeCaseSearchDoc();
		const mod = baseDoc.modules[MOD_A];
		if (mod?.caseListConfig === undefined) {
			throw new Error("fixture must carry a case-list config");
		}
		const ownerOnlyDoc: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...mod,
					caseListConfig: {
						...mod.caseListConfig,
						searchInputs: [],
					},
					caseSearchConfig: {
						searchActionEnabled: false,
						excludedOwnerIds: term({ kind: "literal", value: "owner-a" }),
					},
				},
			},
		};
		const h = makeCaseSearchFixture(ownerOnlyDoc);
		const result = await h.runTool(setCaseSearchAdvancedTool, {
			moduleUuid: MOD_A,
			excludedOwnerIds: null,
			searchFirst: null,
		});
		expect(h.currentDoc().modules[MOD_A]?.caseSearchConfig).toBeUndefined();
		expect(result.mutations).toEqual([
			{
				kind: "updateModule",
				uuid: MOD_A,
				patch: {},
				caseSearchConfigPatch: { excludedOwnerIds: null },
			},
			{
				kind: "updateModule",
				uuid: MOD_A,
				patch: {},
				caseSearchConfigOperation: "remove-if-no-authored-settings",
			},
		]);
	});

	it("turns Search first on and off, keeping the owner rule", async () => {
		const h = makeCaseSearchFixture();
		const on = await h.runTool(setCaseSearchAdvancedTool, {
			moduleUuid: MOD_A,
			excludedOwnerIds: term({ kind: "literal", value: "owner-a" }),
			searchFirst: true,
		});
		if ("error" in on.result) {
			throw new Error(`unexpected error: ${on.result.error}`);
		}
		expect(on.result.advancedSlotsSet).toEqual([
			"excludedOwnerIds",
			"searchFirst",
		]);
		const after = ordinary(h.currentDoc().modules[MOD_A]?.caseSearchConfig);
		expect(after.searchFirst).toBe(true);
		expect(after.excludedOwnerIds).toEqual(
			term({ kind: "literal", value: "owner-a" }),
		);

		const off = await h.runTool(setCaseSearchAdvancedTool, {
			moduleUuid: MOD_A,
			excludedOwnerIds: term({ kind: "literal", value: "owner-a" }),
			searchFirst: null,
		});
		if ("error" in off.result) {
			throw new Error(`unexpected error: ${off.result.error}`);
		}
		expect(off.result.advancedSlotsSet).toEqual(["excludedOwnerIds"]);
		expect(
			ordinary(h.currentDoc().modules[MOD_A]?.caseSearchConfig).searchFirst,
		).toBeUndefined();
	});

	it("refuses Search first on a module that only limits available cases", async () => {
		const baseDoc = makeCaseSearchDoc();
		const mod = baseDoc.modules[MOD_A];
		if (mod?.caseListConfig === undefined) {
			throw new Error("fixture must carry a case-list config");
		}
		const ownerOnlyDoc: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...mod,
					caseListConfig: {
						...mod.caseListConfig,
						searchInputs: [],
					},
					caseSearchConfig: {
						searchActionEnabled: false,
						excludedOwnerIds: term({ kind: "literal", value: "owner-a" }),
					},
				},
			},
		};
		const h = makeCaseSearchFixture(ownerOnlyDoc);
		const result = await h.runTool(setCaseSearchAdvancedTool, {
			moduleUuid: MOD_A,
			excludedOwnerIds: term({ kind: "literal", value: "owner-a" }),
			searchFirst: true,
		});
		if (!("error" in result.result)) {
			throw new Error("expected a refusal");
		}
		expect(result.result.error).toContain("Add a search input first");
		expect(result.mutations).toEqual([]);
		expect(
			ownerOnly(h.currentDoc().modules[MOD_A]?.caseSearchConfig)
				.searchActionEnabled,
		).toBe(false);

		// Clearing the owner rule in the same call leaves no config at all, so
		// a `searchFirst` riding along would vanish while the result named it
		// as set. The refusal covers that shape too.
		const clearing = await h.runTool(setCaseSearchAdvancedTool, {
			moduleUuid: MOD_A,
			excludedOwnerIds: null,
			searchFirst: true,
		});
		if (!("error" in clearing.result)) {
			throw new Error("expected a refusal");
		}
		expect(clearing.result.error).toContain("Add a search input first");
		expect(clearing.mutations).toEqual([]);
		expect(
			ownerOnly(h.currentDoc().modules[MOD_A]?.caseSearchConfig)
				.searchActionEnabled,
		).toBe(false);
	});
});
