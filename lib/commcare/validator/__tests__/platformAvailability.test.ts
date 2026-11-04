/**
 * Parity of the platform table and the gate.
 *
 * Contract: for every feature a declaration can refuse and every
 * declaration, the validator refuses a document holding one use exactly
 * when `platformRefusal` says the declaration refuses the feature, with the
 * same feature and platform: a structural feature as
 * `PLATFORM_FEATURE_UNAVAILABLE`, an expression leaf under its slot's own
 * code with the checker's `platform-unavailable`. `contentRunsOn` reads the
 * content alone, whatever the declaration, and the detector finds exactly the
 * planted use. So a detector that misses a use the gate should refuse (or the
 * reverse), a declaration read two ways, and a checker leaf that drifts from
 * the table each fail here; the builder's offering reads `platformRefusal`
 * too, so it cannot offer what the gate refuses.
 *
 * The Connect fixture holds `connect-location-capture` beside `connect-app`,
 * so no declaration that includes Web Apps admits a Connect app that records
 * its forms' location.
 */

import { describe, expect, it } from "vitest";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	contentRunsOn,
	declaredPlatforms,
	NEW_APP_SETTINGS,
	PLATFORM_FEATURE_IDS,
	PLATFORM_FEATURES,
	PLATFORMS,
	type Platform,
	platformFeatureUses,
	platformRefusal,
	unavailablePlatform,
} from "@/lib/domain";
import {
	PLATFORM_FEATURE_FIXTURES,
	plantedUse,
} from "@/lib/domain/__tests__/platformFeatureFixtures";
import { runValidation } from "../runner";

const REFUSABLE = PLATFORM_FEATURE_IDS.filter(
	(id) => unavailablePlatform(id, PLATFORMS) !== undefined,
);
const DECLARATIONS = [undefined, "web-apps", "android"] as const;

function declared(doc: BlueprintDoc, runsOnlyOn: Platform | undefined) {
	return {
		...doc,
		appSettings: {
			...NEW_APP_SETTINGS,
			showSavedForms: doc.appSettings.showSavedForms,
			showIncompleteForms: doc.appSettings.showIncompleteForms,
			...(runsOnlyOn === undefined ? {} : { runsOnlyOn }),
		},
	};
}

describe.each(REFUSABLE)("%s", (feature) => {
	const fixture = PLATFORM_FEATURE_FIXTURES[feature];
	for (const runsOnlyOn of DECLARATIONS)
		it(`is refused exactly where the table refuses it, declaring ${runsOnlyOn ?? "both"}`, () => {
			const doc = declared(fixture.with(), runsOnlyOn);
			const expected = platformRefusal(feature, declaredPlatforms(doc));
			const found = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
				.filter((error) => error.details?.feature === feature)
				.map((error) => ({
					structural: error.code === "PLATFORM_FEATURE_UNAVAILABLE",
					reason: error.details?.checkReason,
					feature: error.details?.feature,
					platform: error.details?.platform,
				}));
			const structural = PLATFORM_FEATURES[feature].channel === "structure";
			expect(found).toEqual(
				expected === undefined
					? []
					: [
							{
								structural,
								reason: structural ? undefined : "platform-unavailable",
								feature: expected.feature,
								platform: expected.platform,
							},
						],
			);
			const blocked = unavailablePlatform(feature, PLATFORMS);
			expect(contentRunsOn(doc)).toEqual(
				PLATFORMS.filter((platform) => platform !== blocked),
			);
			expect(
				platformFeatureUses(doc, { features: new Set([feature]) }),
			).toEqual([plantedUse(fixture, doc)]);
		});
});

describe("the search workflow's rows", () => {
	it("refuses list first and Forms read the search, and never search first", () => {
		expect(REFUSABLE).toEqual(
			expect.arrayContaining(["list-first", "forms-read-search"]),
		);
		expect(REFUSABLE).not.toContain("search-first");
		expect(unavailablePlatform("list-first", PLATFORMS)).toBe("web-apps");
		expect(unavailablePlatform("forms-read-search", PLATFORMS)).toBe("android");
	});

	/** Search first reads ignored on Android, never unavailable, so the menu
	 *  that holds it is admitted on every declaration. */
	for (const runsOnlyOn of DECLARATIONS)
		it(`admits a menu that searches first, declaring ${runsOnlyOn ?? "both"}`, () => {
			const doc = declared(
				PLATFORM_FEATURE_FIXTURES["search-first"].with(),
				runsOnlyOn,
			);
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		});
});
