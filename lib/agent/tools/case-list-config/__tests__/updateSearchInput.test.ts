/** Schema-admitted shared tool calls through the real workspace and reducer.
 * Controlled host receipts prove local state transitions, not SQL commits. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { ancestorPath, matchAll, relationStep } from "@/lib/domain/expression";
import { searchInputRequestKey } from "@/lib/domain/modules";
import { updateSearchInputTool } from "../updateSearchInput";
import { MOD_A, makeCaseListDoc, makeCaseListFixture } from "./fixtures";

const TARGET_UUID = testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const SIBLING_UUID = testUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

function fixtureWithInputs(): BlueprintDoc {
	const doc = makeCaseListDoc();
	const target = simpleSearchInputDef(
		TARGET_UUID,
		"name_search",
		"Name",
		"text",
		"case_name",
	);
	const sibling = simpleSearchInputDef(
		SIBLING_UUID,
		"phone_search",
		"Phone",
		"text",
		"phone",
	);
	return {
		...doc,
		modules: {
			[MOD_A]: {
				...doc.modules[MOD_A],
				caseListConfig: resolveCaseListConfig({
					columns: [
						plainColumn(
							testUuid("search-input-fixture-column"),
							"case_name",
							"Name",
						),
					],
					searchInputs: [target, sibling],
				}),
			},
		},
	};
}

describe("updateSearchInput", () => {
	it("replaces the search input in place and preserves the uuid", async () => {
		const h = makeCaseListFixture(fixtureWithInputs());

		await h.runTool(updateSearchInputTool, {
			moduleUuid: MOD_A,
			searchInputUuid: TARGET_UUID,
			searchInput: {
				kind: "advanced",
				name: "active_only",
				label: "Active only",
				type: "text",
				predicate: matchAll(),
			},
		});

		const inputs =
			h.currentDoc().modules[MOD_A]?.caseListConfig?.searchInputs ?? [];
		expect(inputs).toHaveLength(2);
		const updated = inputs[0];
		expect(updated?.uuid).toBe(TARGET_UUID);
		expect(updated?.kind).toBe("advanced");
		await h.runTool(updateSearchInputTool, {
			moduleUuid: MOD_A,
			searchInputUuid: TARGET_UUID,
			searchInput: {
				kind: "simple",
				name: "name_search",
				label: "Name",
				type: "text",
				property: "case_name",
			},
		});
		expect(
			h.currentDoc().modules[MOD_A]?.caseListConfig?.searchInputs[0],
		).toEqual(
			fixtureWithInputs().modules[MOD_A]?.caseListConfig?.searchInputs[0],
		);
	});

	it("keeps the direct parent wire key through a full shared tool replacement", async () => {
		const h = makeCaseListFixture(fixtureWithInputs());
		const searchInput = {
			kind: "simple" as const,
			name: "home_address",
			label: "Household address",
			type: "text" as const,
			property: "address",
			matching: "project-space" as const,
			via: ancestorPath(relationStep("parent")),
		};
		const replace = async (body: typeof searchInput) =>
			h.runTool(updateSearchInputTool, {
				moduleUuid: MOD_A,
				searchInputUuid: TARGET_UUID,
				searchInput: body,
			});
		await replace(searchInput);
		await replace({ ...searchInput, name: "renamed_address" });
		const saved =
			h.currentDoc().modules[MOD_A]?.caseListConfig?.searchInputs[0];
		expect(saved).toMatchObject({
			...searchInput,
			uuid: TARGET_UUID,
			name: "renamed_address",
		});
		expect(saved && searchInputRequestKey(saved)).toBe("parent/address");
		const refused = await replace({ ...searchInput, property: "case_name" });
		expect(refused.result).toHaveProperty("error");
		expect(
			h.currentDoc().modules[MOD_A]?.caseListConfig?.searchInputs[0],
		).toEqual(saved);
	});

	it("leaves sibling search inputs untouched", async () => {
		const doc = fixtureWithInputs();
		const sibling = doc.modules[MOD_A]?.caseListConfig?.searchInputs[1];
		const h = makeCaseListFixture(doc);

		await h.runTool(updateSearchInputTool, {
			moduleUuid: MOD_A,
			searchInputUuid: TARGET_UUID,
			searchInput: {
				kind: "simple",
				name: "renamed",
				label: "Renamed",
				type: "text",
				property: "case_name",
			},
		});

		const inputs =
			h.currentDoc().modules[MOD_A]?.caseListConfig?.searchInputs ?? [];
		expect(inputs[1]).toEqual(sibling);
	});

	it("returns the canonical UUID-address error for an unknown module", async () => {
		const h = makeCaseListFixture(fixtureWithInputs());
		const result = await h.runTool(updateSearchInputTool, {
			moduleUuid: testUuid("unknown-module"),
			searchInputUuid: TARGET_UUID,
			searchInput: {
				kind: "simple",
				name: "renamed",
				label: "Renamed",
				type: "text",
				property: "case_name",
			},
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("No module with UUID");
	});

	it("returns an Elm-style error when the search-input uuid is unknown", async () => {
		const h = makeCaseListFixture(fixtureWithInputs());
		const unknown = testUuid("dddddddd-dddd-dddd-dddd-dddddddddddd");
		const result = await h.runTool(updateSearchInputTool, {
			moduleUuid: MOD_A,
			searchInputUuid: unknown,
			searchInput: {
				kind: "simple",
				name: "renamed",
				label: "Renamed",
				type: "text",
				property: "case_name",
			},
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain(String(unknown));
		expect(result.result.error).toContain("Found no entry with that uuid");
	});
});
