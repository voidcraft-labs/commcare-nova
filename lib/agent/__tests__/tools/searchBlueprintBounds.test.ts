/**
 * `searchBlueprint` result bounding.
 *
 * The underlying query is unbounded by design — the builder's search
 * hook renders every match into a scrolling list for a person. The tool
 * boundary is where that stops being right: a short query against a
 * large app matches most of it, and both consumers lose. Measured on
 * production, a single-letter query against the largest app rendered
 * 531,339 characters — past what any tool result can carry to a model,
 * and roughly 130,000 tokens for the chat SA to read a haystack.
 *
 * What the cap has to get right is not the number but the honesty: a
 * capped result and a complete one must not look alike. An agent that
 * asks which forms write a case property and silently receives the
 * first fifty will edit those and leave the rest, having been given no
 * reason to doubt it saw them all.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { BlueprintDoc } from "@/lib/domain";

import { searchBlueprintTool } from "../../tools/searchBlueprint";

/**
 * An app with `moduleCount` modules whose names all share a token, so a
 * query for that token matches every one of them and the result count
 * is exactly known.
 */
function docWithModules(moduleCount: number): BlueprintDoc {
	const modules: BlueprintDoc["modules"] = {};
	const moduleOrder: BlueprintDoc["moduleOrder"] = [];
	for (let i = 0; i < moduleCount; i++) {
		const uuid = testUuid(
			`55555555-5555-5555-5555-${String(i).padStart(12, "0")}`,
		);
		modules[uuid] = {
			uuid,
			id: `households_${i}`,
			name: `Households ${i}`,
			caseType: "household",
		};
		moduleOrder.push(uuid);
	}
	return {
		appId: "a-search",
		appName: "Search Bounds",
		connectType: null,
		caseTypes: null,
		modules,
		forms: {},
		fields: {},
		moduleOrder,
		formOrder: Object.fromEntries(moduleOrder.map((u) => [u, []])),
		fieldOrder: {},
		fieldParent: {},
	};
}

async function search(doc: BlueprintDoc, query: string) {
	const out = await searchBlueprintTool.execute({ query }, {
		snapshot: { doc },
	} as never);
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

	it("caps a large match set and reports the true total", async () => {
		const data = await search(docWithModules(500), "Households");

		expect(data.results.length).toBeLessThan(500);
		expect(data.truncated).toBeDefined();
		/* The total is the number the caller acts on — "50 of 500" is
		 * what tells it the query was too broad. Reporting only that
		 * results were cut would leave it unable to judge by how much. */
		expect(data.truncated?.total).toBe(500);
		expect(data.truncated?.shown).toBe(data.results.length);
	});

	it("tells the caller how to narrow, not just that it was cut", async () => {
		const data = await search(docWithModules(500), "Households");
		const message = data.truncated?.message ?? "";
		/* An agent that is told only "truncated" has no next move and
		 * will most likely proceed on the partial set. The message has
		 * to name the alternatives. */
		expect(message).toContain("get_module");
		expect(message).toContain("500");
	});

	it("keeps a capped result small enough to deliver", async () => {
		/* The point of the cap. Uncapped, this shape is what produced
		 * half a megabyte in production. */
		const data = await search(docWithModules(500), "Households");
		expect(JSON.stringify(data).length).toBeLessThan(50_000);
	});
});
