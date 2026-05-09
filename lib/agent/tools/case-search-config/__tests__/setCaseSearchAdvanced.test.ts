/**
 * Behavioral tests for `setCaseSearchAdvanced`.
 *
 * Drives the tool through `GenerationContext`. Coverage:
 *
 *   1. Effect on the doc — the supplied advanced cluster lands on the
 *      module's `caseSearchConfig`.
 *   2. `null` clears `blacklistedOwnerIds` (key omitted on the
 *      persisted doc).
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
		const blacklist = term({ kind: "literal", value: "owner-a owner-b" });

		const result = await setCaseSearchAdvancedTool.execute(
			{
				moduleIndex: 0,
				blacklistedOwnerIds: blacklist,
			},
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config?.blacklistedOwnerIds).toEqual(blacklist);
		// Schema-strict round-trip — `caseSearchConfigSchema` is `.strict()`
		// so any unknown key sneaking out of the strip-and-rebuild logic, or
		// a key that landed as `undefined` rather than absent, surfaces here.
		// Catches drift the observable-shape assertions above wouldn't.
		expect(caseSearchConfigSchema.safeParse(config).success).toBe(true);
	});

	it("returns a confirmation message that names the slot operation", async () => {
		// Single-slot wholesale tool — there's no `kind` discriminator on
		// the success result (the prose message is the only signal). Pin
		// that the message names the blacklist slot so the SA can confirm
		// the tool ran without re-reading the config.
		const { doc, ctx } = makeCaseSearchFixture();
		const result = await setCaseSearchAdvancedTool.execute(
			{
				moduleIndex: 0,
				blacklistedOwnerIds: term({ kind: "literal", value: "owner-a" }),
			},
			ctx,
			doc,
		);
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.message).toContain("blacklisted owner ids");
	});

	it("clears the blacklisted owner ids slot when null is passed", async () => {
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
						blacklistedOwnerIds: term({
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
				blacklistedOwnerIds: null,
			},
			ctx,
			seededDoc,
		);

		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config?.blacklistedOwnerIds).toBeUndefined();
		expect(config && "blacklistedOwnerIds" in config).toBe(false);
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.message).toContain("cleared");
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
						emptyListText: "No matches",
						searchButtonLabel: "Search",
						searchAgainButtonLabel: "Search again",
						searchButtonDisplayCondition: matchAll(),
					},
				},
			},
		};

		const result = await setCaseSearchAdvancedTool.execute(
			{
				moduleIndex: 0,
				blacklistedOwnerIds: term({ kind: "literal", value: "owner-x" }),
			},
			ctx,
			seededDoc,
		);

		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config?.searchScreenTitle).toBe("Find a patient");
		expect(config?.searchScreenSubtitle).toBe("Type to filter");
		expect(config?.emptyListText).toBe("No matches");
		expect(config?.searchButtonLabel).toBe("Search");
		expect(config?.searchAgainButtonLabel).toBe("Search again");
		expect(config?.searchButtonDisplayCondition).toEqual(matchAll());
		// Advanced cluster updated.
		expect(config?.blacklistedOwnerIds).toBeDefined();
	});

	it("returns an Elm-style error on out-of-range moduleIndex", async () => {
		const { doc, ctx } = makeCaseSearchFixture();
		const result = await setCaseSearchAdvancedTool.execute(
			{
				moduleIndex: 99,
				blacklistedOwnerIds: null,
			},
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain(
			"Tried to set the case-search advanced",
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
				blacklistedOwnerIds: term({ kind: "literal", value: "owner-a" }),
			},
			ctx,
			docWithoutConfig,
		);

		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config).toBeDefined();
		expect(config?.blacklistedOwnerIds).toBeDefined();
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
			blacklistedOwnerIds: term({ kind: "literal", value: "owner-x" }),
		};

		const r1 = await setCaseSearchAdvancedTool.execute(input, chatCtx, doc);
		const r2 = await setCaseSearchAdvancedTool.execute(input, mcpCtx, doc);

		expect(r1.mutations).toEqual(r2.mutations);
	});
});
