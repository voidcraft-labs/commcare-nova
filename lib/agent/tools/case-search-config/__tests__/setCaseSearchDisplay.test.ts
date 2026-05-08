/**
 * Behavioral tests for `setCaseSearchDisplay`.
 *
 * Drives the tool through `GenerationContext`. Coverage:
 *
 *   1. Effect on the doc — supplied display labels land on the
 *      module's `caseSearchConfig`.
 *   2. Structured success carries the `displaySlotsSet` discriminator.
 *   3. `null` clears any display slot (key omitted on the persisted
 *      doc).
 *   4. Claim cluster (claim condition, dontClaimAlreadyOwned,
 *      blacklisted owners) survives the patch byte-identically.
 *   5. Module-not-found surfaces an Elm-style error.
 *   6. Cross-surface parity — chat + MCP contexts produce
 *      structurally identical mutation batches.
 *   7. Initializes the caseSearchConfig with `dontClaimAlreadyOwned:
 *      false` when the module has none.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BlueprintDoc,
	caseSearchConfigSchema,
	type Module,
} from "@/lib/domain";
import { eq, literal, matchAll, prop, term } from "@/lib/domain/predicate";
import { setCaseSearchDisplayTool } from "../setCaseSearchDisplay";
import {
	MOD_A,
	makeCaseSearchFixture,
	makeCaseSearchMcpFixture,
} from "./fixtures";

vi.mock("@/lib/db/apps", () => ({
	updateApp: vi.fn(() => Promise.resolve()),
	updateAppForRun: vi.fn(() => Promise.resolve()),
	completeApp: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("setCaseSearchDisplay", () => {
	it("sets every display slot on the module's caseSearchConfig", async () => {
		const { doc, ctx } = makeCaseSearchFixture();
		const buttonCondition = matchAll();

		const result = await setCaseSearchDisplayTool.execute(
			{
				moduleIndex: 0,
				searchScreenTitle: "Find a patient",
				searchScreenSubtitle: "Type to filter",
				emptyListText: "No matches",
				searchButtonLabel: "Search",
				searchAgainButtonLabel: "Search again",
				searchButtonDisplayCondition: buttonCondition,
			},
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config?.searchScreenTitle).toBe("Find a patient");
		expect(config?.searchScreenSubtitle).toBe("Type to filter");
		expect(config?.emptyListText).toBe("No matches");
		expect(config?.searchButtonLabel).toBe("Search");
		expect(config?.searchAgainButtonLabel).toBe("Search again");
		expect(config?.searchButtonDisplayCondition).toEqual(buttonCondition);
		// Schema-strict round-trip — `caseSearchConfigSchema` is `.strict()`
		// so any unknown key sneaking out of the strip-and-rebuild logic, or
		// a key that landed as `undefined` rather than absent, surfaces here.
		// Catches drift the observable-shape assertions above wouldn't.
		expect(caseSearchConfigSchema.safeParse(config).success).toBe(true);
	});

	it("surfaces displaySlotsSet in the structured result", async () => {
		// Mirrors the structured-success contract — `displaySlotsSet` is
		// the discriminator the SA reads to confirm which slots received
		// non-null values without parsing the prose message.
		const { doc, ctx } = makeCaseSearchFixture();
		const result = await setCaseSearchDisplayTool.execute(
			{
				moduleIndex: 0,
				searchScreenTitle: "Search patients",
				searchScreenSubtitle: null,
				emptyListText: null,
				searchButtonLabel: "Go",
				searchAgainButtonLabel: null,
				searchButtonDisplayCondition: null,
			},
			ctx,
			doc,
		);

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
		const { doc: baseDoc, ctx } = makeCaseSearchFixture();
		const seededDoc: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseSearchConfig: {
						dontClaimAlreadyOwned: false,
						searchScreenTitle: "Old title",
						searchScreenSubtitle: "Old subtitle",
						emptyListText: "Old empty",
						searchButtonLabel: "Old search",
						searchAgainButtonLabel: "Old again",
						searchButtonDisplayCondition: matchAll(),
					},
				},
			},
		};

		const result = await setCaseSearchDisplayTool.execute(
			{
				moduleIndex: 0,
				searchScreenTitle: null,
				searchScreenSubtitle: null,
				emptyListText: null,
				searchButtonLabel: null,
				searchAgainButtonLabel: null,
				searchButtonDisplayCondition: null,
			},
			ctx,
			seededDoc,
		);

		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config?.searchScreenTitle).toBeUndefined();
		expect(config?.searchScreenSubtitle).toBeUndefined();
		expect(config?.emptyListText).toBeUndefined();
		expect(config?.searchButtonLabel).toBeUndefined();
		expect(config?.searchAgainButtonLabel).toBeUndefined();
		expect(config?.searchButtonDisplayCondition).toBeUndefined();
		// None of the cleared keys remain on the object.
		if (!config) throw new Error("expected config");
		expect("searchScreenTitle" in config).toBe(false);
		expect("searchButtonDisplayCondition" in config).toBe(false);
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.displaySlotsSet).toEqual([]);
		expect(result.result.message).toContain("Cleared every");
	});

	it("preserves claim cluster when setting display labels", async () => {
		// Cross-cluster preservation contract — display and claim are
		// independent. Setting one cluster must NOT clobber any slot
		// owned by the other.
		const { doc: baseDoc, ctx } = makeCaseSearchFixture();
		const seededClaim = eq(prop("patient", "status"), literal("active"));
		const seededOwners = term({ kind: "literal", value: "owner-x owner-y" });
		const seededDoc: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseSearchConfig: {
						claimCondition: seededClaim,
						dontClaimAlreadyOwned: true,
						blacklistedOwnerIds: seededOwners,
					},
				},
			},
		};

		const result = await setCaseSearchDisplayTool.execute(
			{
				moduleIndex: 0,
				searchScreenTitle: "Find patients",
				searchScreenSubtitle: null,
				emptyListText: null,
				searchButtonLabel: null,
				searchAgainButtonLabel: null,
				searchButtonDisplayCondition: null,
			},
			ctx,
			seededDoc,
		);

		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config?.claimCondition).toEqual(seededClaim);
		expect(config?.dontClaimAlreadyOwned).toBe(true);
		expect(config?.blacklistedOwnerIds).toEqual(seededOwners);
		// Display update landed.
		expect(config?.searchScreenTitle).toBe("Find patients");
	});

	it("returns an Elm-style error on out-of-range moduleIndex", async () => {
		const { doc, ctx } = makeCaseSearchFixture();
		const result = await setCaseSearchDisplayTool.execute(
			{
				moduleIndex: 99,
				searchScreenTitle: null,
				searchScreenSubtitle: null,
				emptyListText: null,
				searchButtonLabel: null,
				searchAgainButtonLabel: null,
				searchButtonDisplayCondition: null,
			},
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain(
			"Tried to set the case-search display",
		);
		expect(result.result.error).toContain("module index 99");
		expect(result.result.error).toContain("Found no module");
	});

	it("initializes the caseSearchConfig with default dontClaimAlreadyOwned when the module has none", async () => {
		// Bootstrap default — the schema requires `dontClaimAlreadyOwned`
		// whenever the config is present, so a display-only edit on a
		// fresh module must seed `false` so the resulting config still
		// validates against `caseSearchConfigSchema`.
		const { doc: baseDoc, ctx } = makeCaseSearchFixture();
		const baseMod = baseDoc.modules[MOD_A];
		const docWithoutConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: { ...baseMod, caseSearchConfig: undefined } as Module,
			},
		};

		const result = await setCaseSearchDisplayTool.execute(
			{
				moduleIndex: 0,
				searchScreenTitle: "Find a patient",
				searchScreenSubtitle: null,
				emptyListText: null,
				searchButtonLabel: null,
				searchAgainButtonLabel: null,
				searchButtonDisplayCondition: null,
			},
			ctx,
			docWithoutConfig,
		);

		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config).toBeDefined();
		expect(config?.dontClaimAlreadyOwned).toBe(false);
		expect(config?.searchScreenTitle).toBe("Find a patient");
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		// Cross-surface parity sentinel. The tool body is ctx-shape-
		// agnostic by construction; this test pins the contract so
		// future ctx-aware logic added to the tool surface would get
		// caught.
		const { doc, ctx: chatCtx } = makeCaseSearchFixture();
		const { ctx: mcpCtx } = makeCaseSearchMcpFixture();
		const input = {
			moduleIndex: 0,
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: null,
			emptyListText: null,
			searchButtonLabel: "Go",
			searchAgainButtonLabel: null,
			searchButtonDisplayCondition: null,
		};

		const r1 = await setCaseSearchDisplayTool.execute(input, chatCtx, doc);
		const r2 = await setCaseSearchDisplayTool.execute(input, mcpCtx, doc);

		expect(r1.mutations).toEqual(r2.mutations);
	});
});
