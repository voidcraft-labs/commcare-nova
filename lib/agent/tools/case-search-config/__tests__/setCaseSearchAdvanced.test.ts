/**
 * Behavioral tests for `setCaseSearchAdvanced`.
 *
 * Drives the tool through `GenerationContext`. Coverage:
 *
 *   1. Effect on the doc — the supplied advanced cluster lands on the
 *      module's `caseSearchConfig`.
 *   2. `null` clears `excludedOwnerIds` (key omitted on the
 *      persisted doc; cleared with no key collision).
 *   3. Display cluster (search-screen labels) survives the patch.
 *   4. Module-not-found surfaces an Elm-style error.
 *   5. Cross-surface parity — chat + MCP contexts produce
 *      structurally identical mutation batches.
 *   6. Initializes the caseSearchConfig when the module has none.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BlueprintDoc,
	caseSearchConfigSchema,
	type Module,
} from "@/lib/domain";
import { matchAll, term } from "@/lib/domain/predicate";
import { setCaseSearchAdvancedTool } from "../setCaseSearchAdvanced";
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

describe("setCaseSearchAdvanced", () => {
	it("sets the advanced cluster to the supplied values", async () => {
		const { doc, ctx } = makeCaseSearchFixture();
		const excluded = term({ kind: "literal", value: "owner-a owner-b" });

		const result = await setCaseSearchAdvancedTool.execute(
			{
				moduleIndex: 0,
				excludedOwnerIds: excluded,
			},
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config?.excludedOwnerIds).toEqual(excluded);
		// Schema-strict round-trip — `caseSearchConfigSchema` is `.strict()`,
		// so the persisted config's key set must be exactly the schema's
		// declared slots. Catches the shape drift the observable-shape
		// assertions above don't (an unknown key leaking onto the layer,
		// or a known key landing as `undefined` instead of absent).
		expect(caseSearchConfigSchema.safeParse(config).success).toBe(true);
	});

	it("surfaces the slot the SA set on the success result", async () => {
		// Both surfaces — the structured `advancedSlotsSet` array AND
		// the prose message — derive from `ADVANCED_SLOT_NAMES` via the
		// shared `slotsSetByInput` projection, so the SA can confirm
		// the tool ran without re-reading the config.
		const { doc, ctx } = makeCaseSearchFixture();
		const result = await setCaseSearchAdvancedTool.execute(
			{
				moduleIndex: 0,
				excludedOwnerIds: term({ kind: "literal", value: "owner-a" }),
			},
			ctx,
			doc,
		);
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
		const { doc: baseDoc, ctx } = makeCaseSearchFixture();
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

		const result = await setCaseSearchAdvancedTool.execute(
			{
				moduleIndex: 0,
				excludedOwnerIds: null,
			},
			ctx,
			seededDoc,
		);

		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config?.excludedOwnerIds).toBeUndefined();
		expect(config && "excludedOwnerIds" in config).toBe(false);
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
		const { doc: baseDoc, ctx } = makeCaseSearchFixture();
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

		const result = await setCaseSearchAdvancedTool.execute(
			{
				moduleIndex: 0,
				excludedOwnerIds: term({ kind: "literal", value: "owner-x" }),
			},
			ctx,
			seededDoc,
		);

		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config?.searchScreenTitle).toBe("Find a patient");
		expect(config?.searchScreenSubtitle).toBe("Type to filter");
		expect(config?.searchButtonLabel).toBe("Search");
		expect(config?.searchButtonDisplayCondition).toEqual(matchAll());
		// Advanced cluster updated.
		expect(config?.excludedOwnerIds).toBeDefined();
	});

	it("returns an Elm-style error on out-of-range moduleIndex", async () => {
		const { doc, ctx } = makeCaseSearchFixture();
		const result = await setCaseSearchAdvancedTool.execute(
			{
				moduleIndex: 99,
				excludedOwnerIds: null,
			},
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain(
			"Tried to set the case-search advanced cluster",
		);
		expect(result.result.error).toContain("module index 99");
		expect(result.result.error).toContain("Found no module");
	});

	it("initializes the caseSearchConfig when the module has none", async () => {
		const { doc: baseDoc, ctx } = makeCaseSearchFixture();
		const baseMod = baseDoc.modules[MOD_A];
		const docWithoutConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: { ...baseMod, caseSearchConfig: undefined } as Module,
			},
		};

		const result = await setCaseSearchAdvancedTool.execute(
			{
				moduleIndex: 0,
				excludedOwnerIds: term({ kind: "literal", value: "owner-a" }),
			},
			ctx,
			docWithoutConfig,
		);

		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config).toBeDefined();
		expect(config?.excludedOwnerIds).toBeDefined();
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		// The tool body is ctx-shape-agnostic — chat and MCP contexts
		// route through the same `recordMutations` interface and emit
		// structurally identical mutation batches for the same input.
		const { doc, ctx: chatCtx } = makeCaseSearchFixture();
		const { ctx: mcpCtx } = makeCaseSearchMcpFixture();
		const input = {
			moduleIndex: 0,
			excludedOwnerIds: term({ kind: "literal", value: "owner-x" }),
		};

		const r1 = await setCaseSearchAdvancedTool.execute(input, chatCtx, doc);
		const r2 = await setCaseSearchAdvancedTool.execute(input, mcpCtx, doc);

		expect(r1.mutations).toEqual(r2.mutations);
	});
});
