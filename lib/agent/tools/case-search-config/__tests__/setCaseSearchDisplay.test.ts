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
 *   4. Advanced cluster (excluded owners) survives the patch
 *      byte-identically.
 *   5. Module-not-found surfaces an Elm-style error.
 *   6. Cross-surface parity — chat + MCP contexts produce
 *      structurally identical mutation batches.
 *   7. Initializes the caseSearchConfig with an empty rebuild when
 *      the module has none.
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
	completeApp: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("setCaseSearchDisplay", () => {
	it("refuses a case-property-reading button condition at the gate", async () => {
		// The condition evaluates before any case is selected — a
		// property read has no row to read, so the commit gate rejects
		// the batch and nothing persists. (The tool-input schema rejects
		// the same shape at parse for framework-validated callers; the
		// gate covers direct execute calls.)
		const { doc, ctx } = makeCaseSearchFixture();
		const result = await setCaseSearchDisplayTool.execute(
			{
				moduleIndex: 0,
				searchScreenTitle: null,
				searchScreenSubtitle: null,
				searchButtonLabel: null,
				searchButtonDisplayCondition: eq(
					prop("patient", "external-id"),
					literal("abc"),
				),
			},
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		expect(result.newDoc).toBe(doc);
		expect(result.result).toMatchObject({
			error: expect.stringContaining("before any case is selected"),
		});
	});

	it("sets every display slot on the module's caseSearchConfig", async () => {
		const { doc, ctx } = makeCaseSearchFixture();
		const buttonCondition = matchAll();

		const result = await setCaseSearchDisplayTool.execute(
			{
				moduleIndex: 0,
				searchScreenTitle: "Find a patient",
				searchScreenSubtitle: "Type to filter",
				searchButtonLabel: "Search",
				searchButtonDisplayCondition: buttonCondition,
			},
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config?.searchScreenTitle).toBe("Find a patient");
		expect(config?.searchScreenSubtitle).toBe("Type to filter");
		expect(config?.searchButtonLabel).toBe("Search");
		expect(config?.searchButtonDisplayCondition).toEqual(buttonCondition);
		// Schema-strict round-trip — `caseSearchConfigSchema` is `.strict()`,
		// so the persisted config's key set must be exactly the schema's
		// declared slots. Catches the shape drift the observable-shape
		// assertions above don't (an unknown key leaking onto the layer,
		// or a known key landing as `undefined` instead of absent).
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
				searchButtonLabel: "Go",
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
						searchScreenTitle: "Old title",
						searchScreenSubtitle: "Old subtitle",
						searchButtonLabel: "Old search",
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
				searchButtonLabel: null,
				searchButtonDisplayCondition: null,
			},
			ctx,
			seededDoc,
		);

		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config?.searchScreenTitle).toBeUndefined();
		expect(config?.searchScreenSubtitle).toBeUndefined();
		expect(config?.searchButtonLabel).toBeUndefined();
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

	it("preserves advanced cluster when setting display labels", async () => {
		// Cross-cluster preservation contract — display and advanced are
		// independent. Setting one cluster must NOT clobber any slot
		// owned by the other.
		const { doc: baseDoc, ctx } = makeCaseSearchFixture();
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

		const result = await setCaseSearchDisplayTool.execute(
			{
				moduleIndex: 0,
				searchScreenTitle: "Find patients",
				searchScreenSubtitle: null,
				searchButtonLabel: null,
				searchButtonDisplayCondition: null,
			},
			ctx,
			seededDoc,
		);

		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config?.excludedOwnerIds).toEqual(seededOwners);
		// Display update landed.
		expect(config?.searchScreenTitle).toBe("Find patients");
	});

	it("turns an owner-only config into explicit Search when action copy is set", async () => {
		const { doc: baseDoc, ctx } = makeCaseSearchFixture();
		const owner = term({ kind: "literal", value: "owner-a" });
		const ownerOnlyDoc: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: { columns: [], searchInputs: [] },
					caseSearchConfig: {
						searchActionEnabled: false,
						excludedOwnerIds: owner,
					},
				},
			},
		};
		const result = await setCaseSearchDisplayTool.execute(
			{
				moduleIndex: 0,
				searchScreenTitle: null,
				searchScreenSubtitle: null,
				searchButtonLabel: "Refresh cases",
				searchButtonDisplayCondition: null,
			},
			ctx,
			ownerOnlyDoc,
		);
		expect(result.newDoc.modules[MOD_A]?.caseSearchConfig).toEqual({
			excludedOwnerIds: owner,
			searchButtonLabel: "Refresh cases",
		});
	});

	it("returns an Elm-style error on out-of-range moduleIndex", async () => {
		const { doc, ctx } = makeCaseSearchFixture();
		const result = await setCaseSearchDisplayTool.execute(
			{
				moduleIndex: 99,
				searchScreenTitle: null,
				searchScreenSubtitle: null,
				searchButtonLabel: null,
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
			"Tried to set the case-search display cluster",
		);
		expect(result.result.error).toContain("module index 99");
		expect(result.result.error).toContain("Found no module");
	});

	it("initializes the caseSearchConfig with an empty rebuild when the module has none", async () => {
		// Fresh-module bootstrap — a display-only edit on a module
		// without a caseSearchConfig produces a config carrying only
		// the supplied display slot. Every cluster key is optional, so
		// the shape strict-parses cleanly.
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
				searchButtonLabel: null,
				searchButtonDisplayCondition: null,
			},
			ctx,
			docWithoutConfig,
		);

		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config).toBeDefined();
		expect(config?.searchScreenTitle).toBe("Find a patient");
		// Schema-strict round-trip — every cluster key is optional, so
		// a config carrying only one display slot still validates.
		expect(caseSearchConfigSchema.safeParse(config).success).toBe(true);
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		// The tool body is ctx-shape-agnostic — chat and MCP contexts
		// route through the same `recordMutations` interface and emit
		// structurally identical mutation batches for the same input.
		const { doc, ctx: chatCtx } = makeCaseSearchFixture();
		const { ctx: mcpCtx } = makeCaseSearchMcpFixture();
		const input = {
			moduleIndex: 0,
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: null,
			searchButtonLabel: "Go",
			searchButtonDisplayCondition: null,
		};

		const r1 = await setCaseSearchDisplayTool.execute(input, chatCtx, doc);
		const r2 = await setCaseSearchDisplayTool.execute(input, mcpCtx, doc);

		expect(r1.mutations).toEqual(r2.mutations);
	});

	it("rejects unknown slot names at the SA boundary (strict input schema)", async () => {
		// The display body is `.strict()` — every slot name outside the
		// declared cluster parse-fails before the tool body runs. Pins
		// the regression class: an SA handing a slot name the cluster
		// doesn't carry hits the boundary, not a silent strip.
		const parseResult = setCaseSearchDisplayTool.inputSchema.safeParse({
			moduleIndex: 0,
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
