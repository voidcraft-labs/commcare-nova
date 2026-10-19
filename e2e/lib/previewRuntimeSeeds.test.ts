import { describe, expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema, moduleOpensOnSearch } from "@/lib/domain";
import { columnsReadHere } from "@/lib/preview/engine/viewerLocation";
import {
	buildFormRefusedBlueprint,
	buildHereColumnBlueprint,
	buildSearchClaimBlueprint,
	HERE_COLUMN_SEED,
	SEARCH_CLAIM_SEED,
} from "./previewRuntimeSeeds";

const APP_ID = "5f3c1d2e-8a4b-4c6d-9e0f-1a2b3c4d5e6f";

describe("Preview runtime smoke seeds", () => {
	it.each([
		["form-refused", buildFormRefusedBlueprint],
		["here-column", buildHereColumnBlueprint],
		["search-claim", buildSearchClaimBlueprint],
	])("%s is a persistable app with no validator findings", (_name, build) => {
		const doc = build(APP_ID);
		const persistable = toPersistableDoc(doc);
		expect(blueprintDocSchema.parse(persistable)).toEqual(persistable);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("puts here() on Results, so the list watches the viewer's position", () => {
		const doc = buildHereColumnBlueprint(APP_ID);
		expect(
			columnsReadHere(
				doc.modules[HERE_COLUMN_SEED.moduleUuid]?.caseListConfig,
				"list",
			),
		).toBe(true);
	});

	it("opens the claim module on Search", () => {
		const module =
			buildSearchClaimBlueprint(APP_ID).modules[SEARCH_CLAIM_SEED.moduleUuid];
		if (module === undefined) throw new Error("module missing");
		expect(moduleOpensOnSearch(module)).toBe(true);
	});
});
