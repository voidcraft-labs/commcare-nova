/** Search result count limits and explicit withheld-match reporting. */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { searchBlueprintTool } from "../../tools/searchBlueprint";
import { expectAdmittedDoc } from "../admittedFixture";
import { makeToolWorkspaceHarness } from "../fixtures";

/**
 * An app with `moduleCount` modules whose names all share a token, so a
 * query for that token matches every one of them and the result count
 * is exactly known.
 */
function docWithModules(moduleCount: number): BlueprintDoc {
	return expectAdmittedDoc(
		buildDoc({
			appName: "Search Bounds",
			modules: Array.from({ length: moduleCount }, (_, index) => ({
				name: `Households ${index}`,
				forms: [
					{
						name: "Intake",
						type: "survey" as const,
						fields: [f({ id: "note", kind: "text", label: "Note" })],
					},
				],
			})),
		}),
	);
}

async function search(doc: BlueprintDoc, query: string) {
	const harness = makeToolWorkspaceHarness(doc);
	const out = await harness.runTool(searchBlueprintTool, { query });
	expect(harness.recordMutations).not.toHaveBeenCalled();
	return out.data;
}

describe("searchBlueprint result bounding", () => {
	it("returns every match, and no truncation marker, when the set is small", async () => {
		/* The marker's absence is load-bearing: it is what tells a caller
		 * it is holding the complete set. If it appeared on every result
		 * it would carry no information. */
		const data = await search(docWithModules(3), "Households");
		expect(data.results).toHaveLength(3);
		expect(data.truncated).toBeUndefined();
	});

	it("returns exactly the cap without falsely claiming withheld matches", async () => {
		const data = await search(docWithModules(50), "Households");
		expect(data.results).toHaveLength(50);
		expect(data.truncated).toBeUndefined();
	});

	it("caps a large match set and reports the true total", async () => {
		const data = await search(docWithModules(51), "Households");

		expect(data.results).toHaveLength(50);
		expect(data.truncated).toBeDefined();
		/* The total is the number the caller acts on — "50 of 500" is
		 * what tells it the query was too broad. Reporting only that
		 * results were cut would leave it unable to judge by how much. */
		expect(data.truncated?.total).toBe(51);
		expect(data.truncated?.shown).toBe(data.results.length);
	});

	it("tells the caller how to narrow, not just that it was cut", async () => {
		const data = await search(docWithModules(51), "Households");
		const message = data.truncated?.message ?? "";
		/* An agent that is told only "truncated" has no next move and
		 * will most likely proceed on the partial set. The message has
		 * to name the alternatives. */
		expect(message).toContain("get_module");
		expect(message).toContain("51");
	});

	it("keeps this bounded-name sample below its output budget", async () => {
		/* This is a sample budget, not a universal byte cap for arbitrary labels. */
		const data = await search(docWithModules(51), "Households");
		expect(JSON.stringify(data).length).toBeLessThan(50_000);
	});
});
