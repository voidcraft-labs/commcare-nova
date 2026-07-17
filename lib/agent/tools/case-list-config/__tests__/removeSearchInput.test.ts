/**
 * Behavioral tests for `removeSearchInput`.
 *
 * Coverage:
 *
 *   1. Effect on the doc — drops the targeted entry; siblings stay.
 *   2. Returns the removed uuid + remaining count.
 *   3. Module-not-found / search-input-uuid-not-found surface
 *      Elm-style errors.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { asUuid, type BlueprintDoc, simpleSearchInputDef } from "@/lib/domain";
import { removeSearchInputTool } from "../removeSearchInput";
import { MOD_A, makeCaseListFixture } from "./fixtures";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

const TARGET_UUID = asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const SIBLING_UUID = asUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

function fixtureWithInputs(): BlueprintDoc {
	const { doc } = makeCaseListFixture();
	return {
		...doc,
		modules: {
			[MOD_A]: {
				...doc.modules[MOD_A],
				caseListConfig: {
					columns: [],
					searchInputs: [
						simpleSearchInputDef(
							TARGET_UUID,
							"target",
							"Target",
							"text",
							"case_name",
						),
						simpleSearchInputDef(
							SIBLING_UUID,
							"sibling",
							"Sibling",
							"text",
							"phone",
						),
					],
				},
			},
		},
	};
}

describe("removeSearchInput", () => {
	it("removes the targeted search input and leaves siblings intact", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithInputs();
		const result = await removeSearchInputTool.execute(
			{ moduleIndex: 0, searchInputUuid: TARGET_UUID },
			ctx,
			doc,
		);

		const inputs =
			result.newDoc.modules[MOD_A]?.caseListConfig?.searchInputs ?? [];
		expect(inputs).toHaveLength(1);
		expect(inputs[0]?.uuid).toBe(SIBLING_UUID);
	});

	it("returns the removed uuid and remaining count", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithInputs();
		const result = await removeSearchInputTool.execute(
			{ moduleIndex: 0, searchInputUuid: TARGET_UUID },
			ctx,
			doc,
		);
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.uuid).toBe(TARGET_UUID);
		expect(result.result.remaining).toBe(1);
	});

	it("removes empty search chrome when the final input was the only search surface", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithInputs();
		const onlyInput = doc.modules[MOD_A].caseListConfig?.searchInputs[0];
		if (onlyInput === undefined) throw new Error("fixture input missing");
		const withOne = {
			...doc,
			modules: {
				...doc.modules,
				[MOD_A]: {
					...doc.modules[MOD_A],
					caseSearchConfig: {},
					caseListConfig: {
						...(doc.modules[MOD_A].caseListConfig ?? {
							columns: [],
							searchInputs: [],
						}),
						searchInputs: [onlyInput],
					},
				},
			},
		} satisfies BlueprintDoc;
		const result = await removeSearchInputTool.execute(
			{ moduleIndex: 0, searchInputUuid: TARGET_UUID },
			ctx,
			withOne,
		);

		expect(result.newDoc.modules[MOD_A].caseSearchConfig).toBeUndefined();
		expect(result.mutations.map((mutation) => mutation.kind)).toEqual([
			"removeSearchInput",
			"setCaseSearchMarker",
		]);
	});

	it("keeps the final input and custom screen settings when removal would orphan them", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithInputs();
		const onlyInput = doc.modules[MOD_A].caseListConfig?.searchInputs[0];
		if (onlyInput === undefined) throw new Error("fixture input missing");
		const customized = {
			...doc,
			modules: {
				...doc.modules,
				[MOD_A]: {
					...doc.modules[MOD_A],
					caseSearchConfig: { searchScreenTitle: "Find a patient" },
					caseListConfig: {
						...(doc.modules[MOD_A].caseListConfig ?? {
							columns: [],
							searchInputs: [],
						}),
						searchInputs: [onlyInput],
					},
				},
			},
		} satisfies BlueprintDoc;

		const result = await removeSearchInputTool.execute(
			{ moduleIndex: 0, searchInputUuid: TARGET_UUID },
			ctx,
			customized,
		);

		expect(result.mutations).toEqual([]);
		expect(result.newDoc.modules[MOD_A].caseSearchConfig).toEqual({
			searchScreenTitle: "Find a patient",
		});
		expect(
			result.newDoc.modules[MOD_A].caseListConfig?.searchInputs,
		).toHaveLength(1);
		if (!("error" in result.result)) throw new Error("expected rejection");
		expect(result.result.error).toMatch(
			/neither available-case rules nor search fields/i,
		);
	});

	it("returns an Elm-style error on out-of-range moduleIndex", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithInputs();
		const result = await removeSearchInputTool.execute(
			{ moduleIndex: 99, searchInputUuid: TARGET_UUID },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("Tried to remove");
		expect(result.result.error).toContain("module index 99");
	});

	it("returns an Elm-style error when the search-input uuid is unknown", async () => {
		const { ctx } = makeCaseListFixture();
		const doc = fixtureWithInputs();
		const unknown = asUuid("dddddddd-dddd-dddd-dddd-dddddddddddd");
		const result = await removeSearchInputTool.execute(
			{ moduleIndex: 0, searchInputUuid: unknown },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain(String(unknown));
		expect(result.result.error).toContain("Found no entry with that uuid");
	});
});
