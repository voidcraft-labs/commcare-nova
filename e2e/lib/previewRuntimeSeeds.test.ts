import { describe, expect, it } from "vitest";
import { distanceValueSeed } from "@/components/builder/shared/distanceDraft";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema, moduleOpensOnSearch } from "@/lib/domain";
import {
	type Expression,
	ifExpr,
	input,
	isBlank,
	literal,
	prop,
	term,
	whenInput,
	within,
} from "@/lib/domain/expression";
import { columnsReadHere } from "@/lib/preview/engine/viewerLocation";
import { formReadsSearchResults } from "@/lib/preview/engine/xpathInstances";
import {
	buildFormRefusedBlueprint,
	buildHereColumnBlueprint,
	buildSearchChoiceBlueprint,
	buildSearchClaimBlueprint,
	buildSearchResultsBlueprint,
	HERE_COLUMN_SEED,
	SEARCH_CHOICE_SEED,
	SEARCH_CLAIM_SEED,
	SEARCH_RESULTS_SEED,
} from "./previewRuntimeSeeds";

const APP_ID = "5f3c1d2e-8a4b-4c6d-9e0f-1a2b3c4d5e6f";

describe("Preview runtime smoke seeds", () => {
	it.each([
		["form-refused", buildFormRefusedBlueprint],
		["here-column", buildHereColumnBlueprint],
		["search-claim", buildSearchClaimBlueprint],
		["search-results", buildSearchResultsBlueprint],
		["search-choice", buildSearchChoiceBlueprint],
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

	it("has its form read what the search found, so it opens only after a search", () => {
		const doc = buildSearchResultsBlueprint(APP_ID);
		const module = doc.modules[SEARCH_RESULTS_SEED.moduleUuid];
		if (module === undefined) throw new Error("module missing");
		expect(moduleOpensOnSearch(module)).toBe(true);
		const [formUuid] = doc.formOrder[SEARCH_RESULTS_SEED.moduleUuid] ?? [];
		if (formUuid === undefined) throw new Error("form missing");
		expect(formReadsSearchResults(doc, formUuid)).toBe(true);
	});
});

describe("the search-choice journey's authored end state", () => {
	it("is a condition the validator admits", () => {
		const { radius, area, caseType, moduleUuid, startRadiusKm } =
			SEARCH_CHOICE_SEED;
		const doc = buildSearchChoiceBlueprint(APP_ID);
		const near = (distance: number | Expression) =>
			within(
				prop(caseType, "home"),
				term(literal("0 0")),
				distance,
				"kilometers",
			);
		const config = doc.modules[moduleUuid]?.caseListConfig;
		const radiusInput = config?.searchInputs?.[0];
		if (radiusInput === undefined || radiusInput.kind !== "advanced")
			throw new Error("Radius input missing");
		radiusInput.predicate = whenInput(
			input(radius.uuid),
			ifExpr(
				isBlank(term(input(area.uuid))),
				near(startRadiusKm),
				near(
					distanceValueSeed(
						[
							{ uuid: radius.uuid, name: radius.name, data_type: "text" },
							{ uuid: area.uuid, name: area.name, data_type: "text" },
						],
						startRadiusKm,
					),
				),
			),
		);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});
});
