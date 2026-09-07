/** Real shared filter tool and workspace gate over admitted fixtures with a
 * controlled host. This proves document transitions, not query execution. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { and, eq, literal, matchAll, prop } from "@/lib/domain/predicate";
import { setCaseListFilterTool } from "../setCaseListFilter";
import { MOD_A, makeCaseListDoc, makeCaseListFixture } from "./fixtures";

describe("setCaseListFilter", () => {
	/** A fixture whose module carries a real (non-empty) case-list config — the
	 *  shape every production case module is born with (`caseListConfigWithName`).
	 *  `setCaseListFilter` EDITS an existing config; a config-less module is a
	 *  concurrent-removal signal, not a first-configure path (see the
	 *  config-removed test below). */
	function fixtureWithConfig() {
		return makeCaseListFixture();
	}

	it("sets the case list filter to the supplied predicate", async () => {
		const h = fixtureWithConfig();
		const filter: Predicate = eq(prop("patient", "status"), literal("open"));

		const result = await h.runTool(setCaseListFilterTool, {
			moduleUuid: MOD_A,
			filter,
		});

		expect(result.kind).toBe("mutate");
		const finalConfig = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.filter).toEqual(filter);
	});

	it("rejects a third value for the built-in case status", async () => {
		const h = fixtureWithConfig();
		const before = structuredClone(h.currentDoc());

		const result = await h.runTool(setCaseListFilterTool, {
			moduleUuid: MOD_A,
			filter: eq(prop("patient", "status"), literal("active")),
		});

		expect(result.mutations).toEqual([]);
		expect(h.currentDoc()).toEqual(before);
		if (!("error" in result.result)) throw new Error("expected rejection");
		expect(result.result.error).toMatch(
			/only be compared with 'open' or 'closed'/,
		);
	});

	it("persists Nova's canonical standard-property names", async () => {
		const h = fixtureWithConfig();
		const filter = eq(prop("patient", "case_name"), literal("Ada"));

		await h.runTool(setCaseListFilterTool, { moduleUuid: MOD_A, filter });

		expect(h.currentDoc().modules[MOD_A]?.caseListConfig?.filter).toEqual(
			eq(prop("patient", "case_name"), literal("Ada")),
		);
		// The canonical input is stored byte-for-byte; this tool owns no alias
		// or compatibility rewrite for standard property names.
		expect(filter).toEqual(eq(prop("patient", "case_name"), literal("Ada")));
	});

	it("surfaces the predicate kind in the structured result on a set", async () => {
		// Mirrors the atomic-op family's `{ message, uuid }` contract:
		// the SA reads the predicate's discriminator off `result.kind`
		// rather than parsing it back out of the prose message.
		const h = makeCaseListFixture();
		const filter: Predicate = eq(prop("patient", "status"), literal("open"));

		const result = await h.runTool(setCaseListFilterTool, {
			moduleUuid: MOD_A,
			filter,
		});
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.kind).toBe("eq");
		expect(result.result.message).toContain("eq");
	});

	it("clears the filter when null is passed", async () => {
		// Seed a filter, then null-clear it.
		const baseDoc = makeCaseListDoc();
		const seededDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: resolveCaseListConfig({
						columns: baseDoc.modules[MOD_A].caseListConfig?.columns ?? [],
						filter: matchAll(),
						searchInputs: [],
					}),
				},
			},
		};

		const h = makeCaseListFixture(seededDoc);
		const result = await h.runTool(setCaseListFilterTool, {
			moduleUuid: MOD_A,
			filter: null,
		});

		const finalConfig = h.currentDoc().modules[MOD_A]?.caseListConfig;
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

	it("keeps an intentional zero-input Search action when its availability rule is cleared", async () => {
		const baseDoc = makeCaseListDoc();
		const existingConfig = baseDoc.modules[MOD_A].caseListConfig;
		if (!existingConfig) throw new Error("fixture case list missing");
		const doc: BlueprintDoc = {
			...baseDoc,
			modules: {
				...baseDoc.modules,
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: {
						...existingConfig,
						filter: eq(prop("patient", "status"), literal("open")),
					},
					caseSearchConfig: {},
				},
			},
		};

		const h = makeCaseListFixture(doc);
		const result = await h.runTool(setCaseListFilterTool, {
			moduleUuid: MOD_A,
			filter: null,
		});

		expect(result.mutations.map((mutation) => mutation.kind)).toEqual([
			"setCaseListMeta",
		]);
		expect(
			h.currentDoc().modules[MOD_A].caseListConfig?.filter,
		).toBeUndefined();
		expect(h.currentDoc().modules[MOD_A].caseSearchConfig).toEqual({});
		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.result.kind).toBe("cleared");
	});

	it("preserves columns and search inputs when setting filter", async () => {
		const baseDoc = makeCaseListDoc();
		const seededColumn = plainColumn(
			testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
			"case_name",
			"Patient",
			{ sort: { direction: "asc", priority: 0 } },
		);
		const seededInput = simpleSearchInputDef(
			testUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
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
					caseListConfig: resolveCaseListConfig({
						columns: [seededColumn],
						searchInputs: [seededInput],
					}),
				},
			},
		};

		const filter = matchAll();
		const h = makeCaseListFixture(seededDoc);
		await h.runTool(setCaseListFilterTool, { moduleUuid: MOD_A, filter });

		const finalConfig = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(finalConfig?.filter).toEqual(filter);
		expect(finalConfig?.columns).toEqual([seededColumn]);
		expect(finalConfig?.searchInputs).toEqual([seededInput]);
	});

	it("is idempotent — two identical calls produce equivalent final state", async () => {
		const h = makeCaseListFixture();
		const filter = eq(prop("patient", "status"), literal("open"));

		await h.runTool(setCaseListFilterTool, { moduleUuid: MOD_A, filter });
		const afterFirst = structuredClone(h.currentDoc());
		await h.runTool(setCaseListFilterTool, { moduleUuid: MOD_A, filter });

		expect(h.currentDoc()).toEqual(afterFirst);
	});

	it("round-trips a recursive predicate (and/eq/literal/prop)", async () => {
		const h = fixtureWithConfig();
		const filter = and(
			eq(prop("patient", "status"), literal("open")),
			eq(prop("patient", "region"), literal("north")),
		);

		await h.runTool(setCaseListFilterTool, { moduleUuid: MOD_A, filter });

		expect(h.currentDoc().modules[MOD_A]?.caseListConfig?.filter).toEqual(
			filter,
		);
	});

	it("returns the canonical UUID-address error for an unknown module", async () => {
		const h = makeCaseListFixture();
		const result = await h.runTool(setCaseListFilterTool, {
			moduleUuid: testUuid("unknown-module"),
			filter: null,
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("No module with UUID");
	});
});
