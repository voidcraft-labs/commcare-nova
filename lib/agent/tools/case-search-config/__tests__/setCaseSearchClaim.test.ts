/**
 * Behavioral tests for `setCaseSearchClaim`.
 *
 * Drives the tool through `GenerationContext`. Coverage:
 *
 *   1. Effect on the doc — the supplied claim cluster lands on the
 *      module's `caseSearchConfig`.
 *   2. Structured success carries the `claimConditionKind`
 *      discriminator.
 *   3. `null` clears `claimCondition` / `blacklistedOwnerIds` (keys
 *      omitted on the persisted doc).
 *   4. Display cluster (search-screen labels) survives the patch.
 *   5. Module-not-found surfaces an Elm-style error.
 *   6. Cross-surface parity — chat + MCP contexts produce
 *      structurally identical mutation batches.
 *   7. Initializes the caseSearchConfig when the module has none.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BlueprintDoc,
	caseSearchConfigSchema,
	type Module,
} from "@/lib/domain";
import { eq, literal, matchAll, prop, term } from "@/lib/domain/predicate";
import { setCaseSearchClaimTool } from "../setCaseSearchClaim";
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

describe("setCaseSearchClaim", () => {
	it("sets the claim cluster to the supplied values", async () => {
		const { doc, ctx } = makeCaseSearchFixture();
		const claimCondition = eq(prop("patient", "status"), literal("active"));

		const result = await setCaseSearchClaimTool.execute(
			{
				moduleIndex: 0,
				claimCondition,
				blacklistedOwnerIds: term({
					kind: "literal",
					value: "owner-a owner-b",
				}),
			},
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config?.claimCondition).toEqual(claimCondition);
		expect(config?.blacklistedOwnerIds).toBeDefined();
		// Schema-strict round-trip — `caseSearchConfigSchema` is `.strict()`
		// so any unknown key sneaking out of the strip-and-rebuild logic, or
		// a key that landed as `undefined` rather than absent, surfaces here.
		// Catches drift the observable-shape assertions above wouldn't.
		expect(caseSearchConfigSchema.safeParse(config).success).toBe(true);
	});

	it("surfaces the predicate kind in the structured result", async () => {
		// Mirrors `setCaseListFilter`'s structured-success contract — the
		// SA reads the discriminator off the result rather than parsing
		// it back out of the prose message.
		const { doc, ctx } = makeCaseSearchFixture();
		const result = await setCaseSearchClaimTool.execute(
			{
				moduleIndex: 0,
				claimCondition: matchAll(),
				blacklistedOwnerIds: null,
			},
			ctx,
			doc,
		);
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.claimConditionKind).toBe("match-all");
		expect(result.result.message).toContain("match-all");
	});

	it("clears optional slots when null is passed", async () => {
		// Seed a config with both slots populated, then null-clear them.
		// The persisted shape must omit the cleared keys rather than
		// carry `key: undefined` — same convention as
		// `setCaseListFilter`'s null-clear test.
		const { doc: baseDoc, ctx } = makeCaseSearchFixture();
		const seededDoc: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseSearchConfig: {
						claimCondition: matchAll(),
						blacklistedOwnerIds: term({
							kind: "literal",
							value: "owner-a",
						}),
					},
				},
			},
		};

		const result = await setCaseSearchClaimTool.execute(
			{
				moduleIndex: 0,
				claimCondition: null,
				blacklistedOwnerIds: null,
			},
			ctx,
			seededDoc,
		);

		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config?.claimCondition).toBeUndefined();
		expect(config?.blacklistedOwnerIds).toBeUndefined();
		expect(config && "claimCondition" in config).toBe(false);
		expect(config && "blacklistedOwnerIds" in config).toBe(false);
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.claimConditionKind).toBe("cleared");
	});

	it("preserves display cluster when setting claim", async () => {
		// Cross-cluster preservation contract — claim and display are
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

		const result = await setCaseSearchClaimTool.execute(
			{
				moduleIndex: 0,
				claimCondition: eq(prop("patient", "status"), literal("active")),
				blacklistedOwnerIds: null,
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
		// Claim cluster updated.
		expect(config?.claimCondition?.kind).toBe("eq");
	});

	it("returns an Elm-style error on out-of-range moduleIndex", async () => {
		const { doc, ctx } = makeCaseSearchFixture();
		const result = await setCaseSearchClaimTool.execute(
			{
				moduleIndex: 99,
				claimCondition: null,
				blacklistedOwnerIds: null,
			},
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("Tried to set the case-search claim");
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

		const result = await setCaseSearchClaimTool.execute(
			{
				moduleIndex: 0,
				claimCondition: matchAll(),
				blacklistedOwnerIds: null,
			},
			ctx,
			docWithoutConfig,
		);

		const config = result.newDoc.modules[MOD_A]?.caseSearchConfig;
		expect(config).toBeDefined();
		expect(config?.claimCondition?.kind).toBe("match-all");
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
			claimCondition: eq(prop("patient", "status"), literal("active")),
			blacklistedOwnerIds: null,
		};

		const r1 = await setCaseSearchClaimTool.execute(input, chatCtx, doc);
		const r2 = await setCaseSearchClaimTool.execute(input, mcpCtx, doc);

		expect(r1.mutations).toEqual(r2.mutations);
	});
});
