/** Schema-admitted shared tool calls through the real workspace and reducer.
 * Controlled host receipts prove local state transitions, not SQL commits. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, plainColumn } from "@/lib/domain";
import { literal, matchAll, term } from "@/lib/domain/predicate";
import { addSearchInputsTool } from "../addSearchInputs";
import { MOD_A, makeCaseListDoc, makeCaseListFixture } from "./fixtures";

const RESULTS_COLUMN = plainColumn(
	testUuid("add-search-inputs-results-column"),
	"case_name",
	"Name",
);

function withCaseList(doc: BlueprintDoc): BlueprintDoc {
	return {
		...doc,
		modules: {
			...doc.modules,
			[MOD_A]: {
				...doc.modules[MOD_A],
				caseListConfig: resolveCaseListConfig({
					columns: [RESULTS_COLUMN],
					searchInputs: [],
				}),
			},
		},
	};
}

describe("addSearchInputs", () => {
	it("appends a simple-arm search input with a freshly minted uuid", async () => {
		const h = makeCaseListFixture(withCaseList(makeCaseListDoc()));
		await h.runTool(addSearchInputsTool, {
			moduleUuid: MOD_A,
			searchInputs: [
				{
					kind: "simple",
					name: "name_search",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			],
		});

		const inputs =
			h.currentDoc().modules[MOD_A]?.caseListConfig?.searchInputs ?? [];
		expect(inputs).toHaveLength(1);
		const input = inputs[0];
		expect(input?.kind).toBe("simple");
		expect(input?.uuid).toBeTruthy();
		if (input?.kind === "simple") {
			expect(input.property).toBe("case_name");
		}
	});

	it("adds multiple inputs in one call, in order, in one host batch", async () => {
		const h = makeCaseListFixture(withCaseList(makeCaseListDoc()));
		const result = await h.runTool(addSearchInputsTool, {
			moduleUuid: MOD_A,
			searchInputs: [
				{
					kind: "simple",
					name: "name_search",
					label: "Name",
					type: "text",
					property: "case_name",
				},
				{
					kind: "advanced",
					name: "active_only",
					label: "Active only",
					type: "text",
					predicate: matchAll(),
				},
			],
		});

		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		// First search authoring also creates the one empty chrome config that
		// makes the search surface real on export, followed by one granular add
		// per input.
		expect(result.mutations.map((mutation) => mutation.kind)).toEqual([
			"updateModule",
			"addSearchInput",
			"addSearchInput",
		]);
		expect(result.mutations[0]).toMatchObject({
			caseSearchConfigOperation: "enable",
			patch: {},
		});
		const inputs =
			h.currentDoc().modules[MOD_A]?.caseListConfig?.searchInputs ?? [];
		expect(inputs.map((i) => i.kind)).toEqual(["simple", "advanced"]);
		expect(h.currentDoc().modules[MOD_A]?.caseSearchConfig).toEqual({});
		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.result.uuids).toEqual(inputs.map((i) => i.uuid));
	});

	it("appends an advanced-arm search input with a freshly minted uuid", async () => {
		const h = makeCaseListFixture(withCaseList(makeCaseListDoc()));
		const predicate = matchAll();
		await h.runTool(addSearchInputsTool, {
			moduleUuid: MOD_A,
			searchInputs: [
				{
					kind: "advanced",
					name: "active_only",
					label: "Active only",
					type: "text",
					predicate,
				},
			],
		});

		const inputs =
			h.currentDoc().modules[MOD_A]?.caseListConfig?.searchInputs ?? [];
		expect(inputs).toHaveLength(1);
		const input = inputs[0];
		expect(input?.kind).toBe("advanced");
		if (input?.kind === "advanced") {
			expect(input.predicate).toEqual(predicate);
		}
	});

	it("surfaces each new uuid in the structured result", async () => {
		const h = makeCaseListFixture(withCaseList(makeCaseListDoc()));
		const result = await h.runTool(addSearchInputsTool, {
			moduleUuid: MOD_A,
			searchInputs: [
				{
					kind: "simple",
					name: "name_search",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			],
		});
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		const newInput =
			h.currentDoc().modules[MOD_A]?.caseListConfig?.searchInputs[0];
		expect(result.result.uuids[0]).toBe(newInput?.uuid);
		expect(result.result.message).toContain("Name");
	});

	it("preserves columns and filter when adding a search input", async () => {
		const baseDoc = makeCaseListDoc();
		const seededColumn = plainColumn(
			testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
			"case_name",
			"Patient",
		);
		const seededFilter = matchAll();
		const docWithConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: resolveCaseListConfig({
						columns: [seededColumn],
						searchInputs: [],
						filter: seededFilter,
					}),
				},
			},
		};

		const h = makeCaseListFixture(docWithConfig);
		await h.runTool(addSearchInputsTool, {
			moduleUuid: MOD_A,
			searchInputs: [
				{
					kind: "simple",
					name: "name_search",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			],
		});

		const final = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(final?.columns).toEqual([seededColumn]);
		expect(final?.filter).toEqual(seededFilter);
	});

	it("enables Search while preserving a fresh owner-only availability rule", async () => {
		const owner = term(literal("owner-a"));
		const caseListDoc = withCaseList(makeCaseListDoc());
		const ownerOnlyDoc: BlueprintDoc = {
			...caseListDoc,
			modules: {
				[MOD_A]: {
					...caseListDoc.modules[MOD_A],
					caseSearchConfig: {
						searchActionEnabled: false,
						excludedOwnerIds: owner,
					},
				},
			},
		};
		const h = makeCaseListFixture(ownerOnlyDoc);
		const result = await h.runTool(addSearchInputsTool, {
			moduleUuid: MOD_A,
			searchInputs: [
				{
					kind: "simple",
					name: "name_search",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			],
		});
		expect(result.mutations[0]).toMatchObject({
			kind: "updateModule",
			caseSearchConfigOperation: "enable",
		});
		expect(h.currentDoc().modules[MOD_A]?.caseSearchConfig).toEqual({
			excludedOwnerIds: owner,
		});
	});

	it("returns the canonical UUID-address error for an unknown module", async () => {
		const h = makeCaseListFixture();
		const result = await h.runTool(addSearchInputsTool, {
			moduleUuid: testUuid("unknown-module"),
			searchInputs: [
				{
					kind: "simple",
					name: "name_search",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			],
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("No module with UUID");
	});
});
