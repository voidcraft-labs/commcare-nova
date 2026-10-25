/**
 * The detectors over a document (`platformUses.ts`).
 *
 * Contract: every use of a platform feature is found with the owner the
 * platform rule locates it at and the site an editor points to, a document
 * without the feature yields none, a server search condition is walked only
 * where a device works the value out, uses come in document order, and
 * `contentRunsOn` reduces the uses to the platforms the content allows,
 * which `buildDoc`, the declaration planner and publish all read.
 *
 * A detector that reads the wrong slot, misses an owner kind, walks a value
 * HQ's server evaluates (or skips one a device does), or a reduction that
 * declares the wrong platform each fails one case here.
 */

import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	contentRunsOn,
	PLATFORM_FEATURE_IDS,
	PLATFORMS,
	type PlatformFeatureId,
	platformFeatureUses,
	proseText,
	unavailablePlatform,
} from "@/lib/domain";
import {
	eq,
	gt,
	ifExpr,
	input,
	literal,
	now,
	prop,
	sessionContext,
	term,
	today,
	walkExpressionNodes,
} from "@/lib/domain/expression";
import type { Expression } from "@/lib/domain/expression/types";
import {
	FIXTURE_INPUT,
	FIXTURE_MODULE,
	PLATFORM_FEATURE_FIXTURES,
	plantedUse,
} from "./platformFeatureFixtures";

const only = (feature: PlatformFeatureId) => ({
	features: new Set([feature]),
});

describe("each feature's detector", () => {
	for (const feature of PLATFORM_FEATURE_IDS) {
		const fixture = PLATFORM_FEATURE_FIXTURES[feature];
		it(`finds ${feature} exactly where the document holds it`, () => {
			const doc = fixture.with();
			expect(platformFeatureUses(doc, only(feature))).toEqual([
				plantedUse(fixture, doc),
			]);
			expect(platformFeatureUses(fixture.without(), only(feature))).toEqual([]);
		});
	}
});

/** The node a use's path names inside its slot's stored expression, by the
 * walk that names every node's path. */
function nodeAt(expression: Expression, path: readonly (string | number)[]) {
	let found: Expression | undefined;
	walkExpressionNodes(expression, (node, at) => {
		if (JSON.stringify(at) === JSON.stringify(path)) found = node;
	});
	return found;
}

describe("a server search condition", () => {
	const conditionDoc = (predicate: Expression) => {
		const doc = PLATFORM_FEATURE_FIXTURES.search.with();
		const module = doc.modules[FIXTURE_MODULE];
		if (module?.caseListConfig === undefined)
			throw new Error("The search fixture has no case list.");
		module.caseListConfig.searchInputs = [
			advancedSearchInputDef(
				FIXTURE_INPUT,
				"dob",
				"Date of birth",
				"text",
				predicate,
			),
		];
		return doc;
	};

	it("walks a value the device works out before the search runs", () => {
		const predicate = gt(
			prop("patient", "dob"),
			ifExpr(eq(term(input(FIXTURE_INPUT)), literal("recent")), now(), today()),
		);
		const uses = platformFeatureUses(conditionDoc(predicate), only("now"));
		expect(uses).toHaveLength(1);
		const site = uses[0]?.site;
		if (site?.kind !== "expression")
			throw new Error("Expected an expression use.");
		expect(site.ref).toEqual({
			entity: "module",
			uuid: FIXTURE_MODULE,
			slot: "search_input_predicate",
			member: { searchInputUuid: FIXTURE_INPUT },
		});
		expect(nodeAt(predicate, site.path)).toEqual({ kind: "now" });
		expect(uses[0]?.owner).toEqual({
			kind: "search-input",
			moduleUuid: FIXTURE_MODULE,
			inputUuid: FIXTURE_INPUT,
		});
	});

	it("finds the clock drift and the window width a device works out for the search", () => {
		const predicate = gt(
			prop("patient", "dob"),
			ifExpr(
				eq(term(input(FIXTURE_INPUT)), literal("recent")),
				term(sessionContext("drift")),
				term(sessionContext("window_width")),
			),
		);
		const doc = conditionDoc(predicate);
		for (const [feature, field] of [
			["clock-drift", "drift"],
			["window-width", "window_width"],
		] as const) {
			const uses = platformFeatureUses(doc, only(feature));
			expect(uses).toHaveLength(1);
			const site = uses[0]?.site;
			if (site?.kind !== "expression")
				throw new Error("Expected an expression use.");
			expect(nodeAt(predicate, site.path)).toEqual(term(sessionContext(field)));
		}
	});

	it("leaves a value HQ's server evaluates", () => {
		const predicate = gt(prop("patient", "dob"), now());
		expect(platformFeatureUses(conditionDoc(predicate), only("now"))).toEqual(
			[],
		);
	});
});

describe("document order", () => {
	it("gives the app's uses, then each form's, then its fields depth first, each owner's in table order", () => {
		const doc = buildDoc(
			{
				appName: "Order",
				modules: [
					{
						name: "Survey",
						forms: [
							{
								name: "Intake",
								type: "survey",
								fields: [
									f({
										kind: "section",
										id: "page",
										label: proseText("Page"),
										children: [
											f({
												kind: "barcode",
												id: "code",
												label: proseText("Code"),
											}),
										],
									}),
									f({
										kind: "geopoint",
										id: "where",
										label: proseText("Where"),
									}),
								],
							},
						],
					},
				],
			},
			(built) => {
				built.logo = testMediaAssetId("platform-order-logo");
			},
		);
		expect(
			platformFeatureUses(doc, {
				features: new Set<PlatformFeatureId>([
					"location-question",
					"barcode-question",
					"question-pages",
					"after-submit-home",
					"app-logo",
				]),
			}).map((use) => use.feature),
		).toEqual([
			"app-logo",
			"after-submit-home",
			"question-pages",
			"barcode-question",
			"location-question",
		]);
	});
});

describe("contentRunsOn", () => {
	const refusable = PLATFORM_FEATURE_IDS.filter(
		(id) => unavailablePlatform(id, PLATFORMS) !== undefined,
	);

	it("gives each refusable feature's document the platform that runs it", () => {
		for (const feature of refusable) {
			const blocked = unavailablePlatform(feature, PLATFORMS);
			expect([
				feature,
				contentRunsOn(PLATFORM_FEATURE_FIXTURES[feature].with()),
			]).toEqual([
				feature,
				PLATFORMS.filter((platform) => platform !== blocked),
			]);
		}
	});

	it("gives a date-and-time question Android, several cases Web Apps, and both together neither", () => {
		expect(
			contentRunsOn(PLATFORM_FEATURE_FIXTURES["datetime-question"].with()),
		).toEqual(["android"]);
		expect(
			contentRunsOn(PLATFORM_FEATURE_FIXTURES["several-cases"].with()),
		).toEqual(["web-apps"]);
		expect(
			contentRunsOn(PLATFORM_FEATURE_FIXTURES["connect-app"].with()),
		).toEqual(["android"]);
		const both = PLATFORM_FEATURE_FIXTURES["several-cases"].with();
		const form = both.formOrder[FIXTURE_MODULE]?.[0];
		if (form === undefined) throw new Error("No form.");
		const question = both.fieldOrder[form]?.[0];
		const field = question === undefined ? undefined : both.fields[question];
		if (field === undefined) throw new Error("No question.");
		both.fields[field.uuid] = { ...field, kind: "datetime" } as typeof field;
		expect(contentRunsOn(both)).toEqual([]);
	});

	it("gives a document of none of them both", () => {
		expect(contentRunsOn(PLATFORM_FEATURE_FIXTURES.search.with())).toEqual([
			"web-apps",
			"android",
		]);
	});
});
