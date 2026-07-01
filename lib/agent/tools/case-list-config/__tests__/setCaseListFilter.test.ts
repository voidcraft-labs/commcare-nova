/**
 * Behavioral tests for `setCaseListFilter`.
 *
 * Drives the tool through `GenerationContext`. Coverage:
 *
 *   1. Effect on the doc — the supplied `Predicate` lands on the
 *      module's `caseListConfig.filter` slot.
 *   2. Set returns `{ message, kind }` with the predicate's
 *      discriminator surfaced structurally so the SA reads the kind
 *      without parsing prose.
 *   3. `null` clears the filter (key omitted on the persisted doc)
 *      and returns `{ message, kind: "cleared" }`.
 *   4. Idempotency — two identical set-then-set calls produce
 *      equivalent final state.
 *   5. Round-trip — recursive predicate operators (and / or / not /
 *      between / exists) survive without corruption.
 *   6. Module-not-found — out-of-range index returns an Elm-style
 *      `{ error }` mirroring the atomic-op family voice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	asUuid,
	type BlueprintDoc,
	type Module,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { and, eq, literal, matchAll, prop } from "@/lib/domain/predicate";
import { setCaseListFilterTool } from "../setCaseListFilter";
import { MOD_A, makeCaseListFixture, makeCaseListMcpFixture } from "./fixtures";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("setCaseListFilter", () => {
	it("sets the case list filter to the supplied predicate", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const filter: Predicate = eq(prop("patient", "status"), literal("active"));

		const result = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.filter).toEqual(filter);
	});

	it("surfaces the predicate kind in the structured result on a set", async () => {
		// Mirrors the atomic-op family's `{ message, uuid }` contract:
		// the SA reads the predicate's discriminator off `result.kind`
		// rather than parsing it back out of the prose message.
		const { doc, ctx } = makeCaseListFixture();
		const filter: Predicate = eq(prop("patient", "status"), literal("active"));

		const result = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			ctx,
			doc,
		);
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.kind).toBe("eq");
		expect(result.result.message).toContain("eq");
	});

	it("clears the filter when null is passed", async () => {
		// Seed a filter, then null-clear it.
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const seededDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: {
						columns: [],
						filter: matchAll(),
						searchInputs: [],
					},
				},
			},
		};

		const result = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter: null },
			ctx,
			seededDoc,
		);

		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.filter).toBeUndefined();
		// The schema treats absent as "no filter"; the persisted shape
		// must NOT carry an explicit `filter: undefined` key.
		expect(finalConfig && "filter" in finalConfig).toBe(false);
		// Structured success carries the literal `"cleared"` kind so
		// the SA branches on the outcome without parsing the message.
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.kind).toBe("cleared");
	});

	it("preserves columns and search inputs when setting filter", async () => {
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const seededColumn = plainColumn(
			asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
			"case_name",
			"Patient",
			{ sort: { direction: "asc", priority: 0 } },
		);
		const seededInput = simpleSearchInputDef(
			asUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
			"name_search",
			"Name",
			"text",
			"case_name",
		);
		const seededDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: {
						columns: [seededColumn],
						searchInputs: [seededInput],
					},
				},
			},
		};

		const filter = matchAll();
		const result = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			ctx,
			seededDoc,
		);

		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.filter).toEqual(filter);
		expect(finalConfig?.columns).toEqual([seededColumn]);
		expect(finalConfig?.searchInputs).toEqual([seededInput]);
	});

	it("is idempotent — two identical calls produce equivalent final state", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const filter = eq(prop("patient", "status"), literal("active"));

		const r1 = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			ctx,
			doc,
		);
		const r2 = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			ctx,
			r1.newDoc,
		);

		expect(r2.newDoc.modules[MOD_A]?.caseListConfig?.filter).toEqual(
			r1.newDoc.modules[MOD_A]?.caseListConfig?.filter,
		);
	});

	it("round-trips a recursive predicate (and/eq/literal/prop)", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const filter = and(
			eq(prop("patient", "status"), literal("active")),
			eq(prop("patient", "region"), literal("north")),
		);

		// Input must satisfy the tool's schema before the reducer
		// accepts it — recursive predicate operators (and / eq /
		// nested-term-lift) need to round-trip through the SA-boundary
		// schema, not just through the reducer.
		const parseResult = setCaseListFilterTool.inputSchema.safeParse({
			moduleIndex: 0,
			filter,
		});
		expect(parseResult.success).toBe(true);

		const result = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			ctx,
			doc,
		);

		expect(result.newDoc.modules[MOD_A]?.caseListConfig?.filter).toEqual(
			filter,
		);
	});

	it("returns an Elm-style error on out-of-range moduleIndex", async () => {
		const { doc, ctx } = makeCaseListFixture();
		const result = await setCaseListFilterTool.execute(
			{ moduleIndex: 99, filter: null },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		// Voice mirrors the atomic-op family — "Tried to <X>. Found
		// no <Y>. Look at <Z>."
		expect(result.result.error).toContain("Tried to set the case list filter");
		expect(result.result.error).toContain("module index 99");
		expect(result.result.error).toContain("Found no module");
	});

	it("initializes the caseListConfig when the module has none", async () => {
		// Module without an existing config — the tool must produce a
		// fully-populated config with the new filter + empty arrays for
		// the two array slots, rather than write `caseListConfig:
		// { filter }` and leave the schema-required arrays absent.
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const baseMod = baseDoc.modules[MOD_A];
		const docWithoutConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: { ...baseMod, caseListConfig: undefined } as Module,
			},
		};

		const filter: Predicate = eq(prop("patient", "status"), literal("active"));
		const result = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			ctx,
			docWithoutConfig,
		);

		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig).toBeDefined();
		expect(finalConfig?.filter).toEqual(filter);
		expect(finalConfig?.columns).toEqual([]);
		expect(finalConfig?.searchInputs).toEqual([]);
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		// Cross-surface parity sentinel — driving the same input
		// through both surfaces' `ToolExecutionContext` implementations
		// must produce structurally identical mutation batches. The
		// tool body is ctx-shape-agnostic by construction; this test
		// pins that contract so future ctx-aware logic added to the
		// tool surface gets caught.
		const { doc, ctx: chatCtx } = makeCaseListFixture();
		const { ctx: mcpCtx } = makeCaseListMcpFixture();
		const filter: Predicate = eq(prop("patient", "status"), literal("active"));

		const r1 = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			chatCtx,
			doc,
		);
		const r2 = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter },
			mcpCtx,
			doc,
		);

		expect(r1.mutations).toEqual(r2.mutations);
	});

	it("initializes the caseListConfig when filter=null on a configless module", async () => {
		// Edge case: `filter === null` on a module whose
		// `caseListConfig` is undefined still materializes the config —
		// the granular `setCaseListMeta` reducer runs
		// `ensureCaseListConfig`, seeding `columns`/`searchInputs` at
		// `[]` before applying the slot patch, so the resulting doc
		// carries every required array slot at empty. Pinned here
		// because a reader could reasonably expect a "no-op" when both
		// the existing config and the new filter are absent. Current
		// behavior is structurally fine (the schema's "if present, all
		// required arrays present" contract holds); this test seals it
		// against silent flips during future refactors.
		const { doc: baseDoc, ctx } = makeCaseListFixture();
		const baseMod = baseDoc.modules[MOD_A];
		const docWithoutConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: { ...baseMod, caseListConfig: undefined } as Module,
			},
		};

		const result = await setCaseListFilterTool.execute(
			{ moduleIndex: 0, filter: null },
			ctx,
			docWithoutConfig,
		);

		const finalConfig = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(finalConfig).toBeDefined();
		// Every required array slot present at empty.
		expect(finalConfig?.columns).toEqual([]);
		expect(finalConfig?.searchInputs).toEqual([]);
		// `filter` stays absent — `null` means "no filter," and the
		// schema treats absence as the canonical no-filter shape.
		expect(finalConfig?.filter).toBeUndefined();
	});
});
