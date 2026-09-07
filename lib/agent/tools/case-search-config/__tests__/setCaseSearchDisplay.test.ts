/** Actual schema-to-workspace/reducer behavior over admitted documents.
 * The commit receipt is controlled; this suite does not model SQL or MCP. */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type BlueprintDoc,
	type CaseSearchConfig,
	isOrdinaryCaseSearchConfig,
	type OrdinaryCaseSearchConfig,
} from "@/lib/domain";
import { eq, literal, matchAll, prop, term } from "@/lib/domain/predicate";
import { setCaseSearchDisplayTool } from "../setCaseSearchDisplay";
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

describe("setCaseSearchDisplay", () => {
	it("refuses a case-property-reading button condition before execution", async () => {
		const h = makeCaseSearchFixture();
		await expect(
			h.runTool(setCaseSearchDisplayTool, {
				moduleUuid: MOD_A,
				searchScreenTitle: null,
				searchScreenSubtitle: null,
				searchButtonLabel: null,
				searchButtonDisplayCondition: eq(
					prop("patient", "external_id"),
					literal("abc"),
				),
			}),
		).rejects.toThrow("before a case is selected");
		expect(h.currentDoc()).toEqual(h.doc);
		expect(h.host.recordMutations).not.toHaveBeenCalled();
	});

	it("sets every display slot on the module's caseSearchConfig", async () => {
		const h = makeCaseSearchFixture();
		const buttonCondition = matchAll();

		const result = await h.runTool(setCaseSearchDisplayTool, {
			moduleUuid: MOD_A,
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "Type to filter",
			searchButtonLabel: "Search",
			searchButtonDisplayCondition: buttonCondition,
		});

		expect(result.kind).toBe("mutate");
		const config = h.currentDoc().modules[MOD_A]?.caseSearchConfig;
		const search = ordinary(config);
		expect(search.searchScreenTitle).toBe("Find a patient");
		expect(search.searchScreenSubtitle).toBe("Type to filter");
		expect(search.searchButtonLabel).toBe("Search");
		expect(search.searchButtonDisplayCondition).toEqual(buttonCondition);
	});

	it("surfaces displaySlotsSet in the structured result", async () => {
		// Mirrors the structured-success contract — `displaySlotsSet` is
		// the discriminator the SA reads to confirm which slots received
		// non-null values without parsing the prose message.
		const h = makeCaseSearchFixture();
		const result = await h.runTool(setCaseSearchDisplayTool, {
			moduleUuid: MOD_A,
			searchScreenTitle: "Search patients",
			searchScreenSubtitle: null,
			searchButtonLabel: "Go",
			searchButtonDisplayCondition: null,
		});

		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.displaySlotsSet).toEqual([
			"searchScreenTitle",
			"searchButtonLabel",
		]);
		expect(result.result.message).toContain("searchScreenTitle");
		expect(result.result.message).toContain("searchButtonLabel");
	});

	it("clears every display slot when all are null", async () => {
		// Seed a config with every display slot populated, then null
		// across the board. The persisted shape must omit each cleared
		// key rather than carry an explicit `key: undefined`.
		const baseDoc = makeCaseSearchDoc();
		const seededDoc: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseSearchConfig: {
						searchScreenTitle: "Old title",
						searchScreenSubtitle: "Old subtitle",
						searchButtonLabel: "Old search",
						searchButtonDisplayCondition: matchAll(),
					},
				},
			},
		};

		const h = makeCaseSearchFixture(seededDoc);
		const result = await h.runTool(setCaseSearchDisplayTool, {
			moduleUuid: MOD_A,
			searchScreenTitle: null,
			searchScreenSubtitle: null,
			searchButtonLabel: null,
			searchButtonDisplayCondition: null,
		});

		const config = h.currentDoc().modules[MOD_A]?.caseSearchConfig;
		expect(config).toBeUndefined();
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.displaySlotsSet).toEqual([]);
		expect(result.result.message).toContain("Cleared every");
	});

	it("preserves advanced cluster when setting display labels", async () => {
		// Cross-cluster preservation contract — display and advanced are
		// independent. Setting one cluster must NOT clobber any slot
		// owned by the other.
		const baseDoc = makeCaseSearchDoc();
		const seededOwners = term({ kind: "literal", value: "owner-x owner-y" });
		const seededDoc: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseSearchConfig: {
						excludedOwnerIds: seededOwners,
					},
				},
			},
		};

		const h = makeCaseSearchFixture(seededDoc);
		await h.runTool(setCaseSearchDisplayTool, {
			moduleUuid: MOD_A,
			searchScreenTitle: "Find patients",
			searchScreenSubtitle: null,
			searchButtonLabel: null,
			searchButtonDisplayCondition: null,
		});

		const config = h.currentDoc().modules[MOD_A]?.caseSearchConfig;
		const search = ordinary(config);
		expect(search.excludedOwnerIds).toEqual(seededOwners);
		// Display update landed.
		expect(search.searchScreenTitle).toBe("Find patients");
	});

	it("turns an owner-only config into explicit Search when action copy is set", async () => {
		const baseDoc = makeCaseSearchDoc();
		const owner = term({ kind: "literal", value: "owner-a" });
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
						excludedOwnerIds: owner,
					},
				},
			},
		};
		const h = makeCaseSearchFixture(ownerOnlyDoc);
		await h.runTool(setCaseSearchDisplayTool, {
			moduleUuid: MOD_A,
			searchScreenTitle: null,
			searchScreenSubtitle: null,
			searchButtonLabel: "Refresh cases",
			searchButtonDisplayCondition: null,
		});
		expect(h.currentDoc().modules[MOD_A]?.caseSearchConfig).toEqual({
			excludedOwnerIds: owner,
			searchButtonLabel: "Refresh cases",
		});
	});

	it("returns an Elm-style error for an unknown module UUID", async () => {
		const h = makeCaseSearchFixture();
		const result = await h.runTool(setCaseSearchDisplayTool, {
			moduleUuid: MISSING_MODULE,
			searchScreenTitle: null,
			searchScreenSubtitle: null,
			searchButtonLabel: null,
			searchButtonDisplayCondition: null,
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain(MISSING_MODULE);
		expect(result.result.error).toContain("No module with UUID");
	});

	it("initializes the caseSearchConfig with an empty rebuild when the module has none", async () => {
		// Fresh-module bootstrap — a display-only edit on a module
		// without a caseSearchConfig produces a config carrying only
		// the supplied display slot. Every cluster key is optional, so
		// the shape strict-parses cleanly.
		const baseDoc = makeCaseSearchDoc();
		const baseMod = baseDoc.modules[MOD_A];
		const docWithoutConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: { ...baseMod, caseSearchConfig: undefined },
			},
		};

		const h = makeCaseSearchFixture(docWithoutConfig);
		await h.runTool(setCaseSearchDisplayTool, {
			moduleUuid: MOD_A,
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: null,
			searchButtonLabel: null,
			searchButtonDisplayCondition: null,
		});

		const config = h.currentDoc().modules[MOD_A]?.caseSearchConfig;
		expect(ordinary(config).searchScreenTitle).toBe("Find a patient");
	});

	it("rejects unknown slot names at the SA boundary (strict input schema)", async () => {
		// The display body is `.strict()` — every slot name outside the
		// declared cluster parse-fails before the tool body runs. Pins
		// the regression class: an SA handing a slot name the cluster
		// doesn't carry hits the boundary, not a silent strip.
		const parseResult = setCaseSearchDisplayTool.inputSchema.safeParse({
			moduleUuid: MOD_A,
			searchScreenTitle: null,
			searchScreenSubtitle: null,
			searchButtonLabel: null,
			searchButtonDisplayCondition: null,
			unknownSlotA: "stray",
			unknownSlotB: "stray",
		});
		expect(parseResult.success).toBe(false);
	});
});
