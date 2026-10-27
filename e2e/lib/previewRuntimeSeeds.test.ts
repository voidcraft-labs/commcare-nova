import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { distanceValueSeed } from "@/components/builder/shared/distanceDraft";
import { makeAssetRecord } from "@/lib/commcare/validator/rules/media/__tests__/fixtures";
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
import { caseTypeToJsonSchema } from "@/lib/domain/expression/jsonSchema";
import { collectRealAssetRefs } from "@/lib/domain/mediaRefs";
import { declaredPlatforms } from "@/lib/domain/platforms";
import { columnsReadHere } from "@/lib/preview/engine/viewerLocation";
import { formReadsSearchResults } from "@/lib/preview/engine/xpathInstances";
import {
	buildFormRefusedBlueprint,
	buildHereColumnBlueprint,
	buildPreviewAndroidMediaBlueprint,
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

	it("holds the Android audio's reference in an app that runs only on Android, admitted by its AMR row", () => {
		const assetId = testMediaAssetId("preview-android-media");
		const doc = buildPreviewAndroidMediaBlueprint(APP_ID, assetId);
		const persistable = toPersistableDoc(doc);
		expect(blueprintDocSchema.parse(persistable)).toEqual(persistable);
		expect(declaredPlatforms(doc)).toEqual(["android"]);
		expect(collectRealAssetRefs(doc)).toEqual([assetId]);
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
				mediaAssets: new Map([
					[
						assetId,
						makeAssetRecord("preview-android-media", {
							id: assetId,
							kind: "audio",
							mimeType: "audio/amr",
							extension: ".amr",
							mediaFormat: "amr",
						}),
					],
				]),
			}),
		).toEqual([]);
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

describe("the search-choice seed's sites", () => {
	it("are rows the case store admits for the seeded case type", () => {
		const caseType = buildSearchChoiceBlueprint(APP_ID).caseTypes?.find(
			(type) => type.name === SEARCH_CHOICE_SEED.caseType,
		);
		if (caseType === undefined) throw new Error("case type missing");
		const ajv = new Ajv2020({ strict: false, strictNumbers: true });
		addFormats(ajv);
		const validate = ajv.compile(caseTypeToJsonSchema(caseType));
		for (const site of SEARCH_CHOICE_SEED.sites) {
			expect(validate({ home: site.home }), site.caseName).toBe(true);
		}
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
