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
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FormSpec, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	contentRunsOn,
	type FormOtherwise,
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

describe("the search workflow and the case list menu entry", () => {
	it("finds a case list menu entry beside the menu's forms", () => {
		const doc = PLATFORM_FEATURE_FIXTURES["case-list-menu-item"].without();
		const module = doc.modules[FIXTURE_MODULE];
		if (module === undefined) throw new Error("The fixture has no module.");
		module.caseListMenuItem = {};
		expect(doc.formOrder[FIXTURE_MODULE]?.length).toBeGreaterThan(0);
		expect(platformFeatureUses(doc, only("case-list-menu-item"))).toEqual([
			{
				feature: "case-list-menu-item",
				owner: { kind: "module", moduleUuid: FIXTURE_MODULE },
				site: { kind: "slot", slot: "caseListMenuItem" },
			},
		]);
	});

	it("names one feature for a menu whose forms read the search, never search, search first or results first", () => {
		const doc = PLATFORM_FEATURE_FIXTURES["forms-read-search"].with();
		for (const workflow of [undefined, "skipToResults"] as const) {
			const module = doc.modules[FIXTURE_MODULE];
			if (module === undefined) throw new Error("The fixture has no module.");
			module.caseSearchConfig = {
				formsReadSearch: true,
				...(workflow !== undefined && { workflow }),
			};
			const features = platformFeatureUses(doc)
				.filter((use) => use.owner.kind === "module")
				.map((use) => use.feature);
			expect(features).toContain("forms-read-search");
			expect(features).not.toContain("search");
			expect(features).not.toContain("search-first");
			expect(features).not.toContain("skip-to-results");
		}
	});

	it("reads list first, search first and results first from the authored workflow alone", () => {
		const doc = PLATFORM_FEATURE_FIXTURES["skip-to-results"].without();
		const module = doc.modules[FIXTURE_MODULE];
		if (module === undefined) throw new Error("The fixture has no module.");
		// A filter and no visible field: results first only when authored.
		expect(platformFeatureUses(doc, only("skip-to-results"))).toEqual([]);
		expect(
			platformFeatureUses(doc, only("search-first")).map((use) => use.feature),
		).toEqual(["search-first"]);
		module.caseSearchConfig = { workflow: "listFirst" };
		expect(
			platformFeatureUses(doc, {
				features: new Set(["list-first", "search-first", "search"]),
			}).map((use) => use.feature),
		).toEqual(["list-first", "search"]);
	});
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

describe("after submit", () => {
	const MODULE = testUuid("after-submit-module");
	const FORM = testUuid("after-submit-form");
	const owner = { kind: "form", moduleUuid: MODULE, formUuid: FORM } as const;
	const features = new Set<PlatformFeatureId>([
		"after-submit-home",
		"after-submit-several-destinations",
	]);

	/** A survey whose one form holds `formLinks`, with `otherwise` set on
	 *  the built form where given. */
	function afterSubmitDoc(
		formLinks: NonNullable<FormSpec["formLinks"]> | undefined,
		otherwise?: FormOtherwise,
	) {
		return buildDoc(
			{
				appName: "After submit",
				modules: [
					{
						uuid: MODULE,
						name: "Visits",
						forms: [
							{
								uuid: FORM,
								name: "Visit",
								type: "survey",
								...(formLinks === undefined ? {} : { formLinks }),
								fields: [
									f({ kind: "text", id: "answer", label: proseText("Answer") }),
								],
							},
						],
					},
				],
			},
			(doc) => {
				const form = doc.forms[FORM];
				if (form !== undefined && otherwise !== undefined)
					form.otherwise = otherwise;
			},
		);
	}
	const conditional = {
		condition: "#form/answer = 'again'",
		target: { type: "this-form" },
	} as const;
	const everyTime = { target: { type: "this-form" } } as const;

	it("reads the app home on postSubmit for a form without destinations", () => {
		expect(
			platformFeatureUses(afterSubmitDoc(undefined), { features }),
		).toEqual([
			{
				feature: "after-submit-home",
				owner,
				site: { kind: "slot", slot: "postSubmit" },
			},
		]);
	});

	it("reads the app home on the otherwise when a destination may not run and no otherwise is set", () => {
		expect(
			platformFeatureUses(afterSubmitDoc([conditional]), { features }),
		).toEqual([
			{
				feature: "after-submit-home",
				owner,
				site: { kind: "slot", slot: "otherwise" },
			},
		]);
	});

	it("finds no app home when the otherwise is a built-in destination or every destination runs", () => {
		expect(
			platformFeatureUses(
				afterSubmitDoc([conditional], {
					kind: "destination",
					destination: "firstMenu",
				}),
				{ features },
			),
		).toEqual([]);
		expect(
			platformFeatureUses(afterSubmitDoc([everyTime]), { features }),
		).toEqual([]);
	});

	it("finds several destinations on formLinks from two destinations, beside the app home", () => {
		expect(
			platformFeatureUses(afterSubmitDoc([conditional, conditional]), {
				features,
			}),
		).toEqual([
			{
				feature: "after-submit-home",
				owner,
				site: { kind: "slot", slot: "otherwise" },
			},
			{
				feature: "after-submit-several-destinations",
				owner,
				site: { kind: "slot", slot: "formLinks" },
			},
		]);
		expect(
			platformFeatureUses(afterSubmitDoc([everyTime, everyTime, everyTime]), {
				features,
			}),
		).toEqual([
			{
				feature: "after-submit-several-destinations",
				owner,
				site: { kind: "slot", slot: "formLinks" },
			},
		]);
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

describe("inline choices", () => {
	it("gives each choice its own uses after the field's, plain text before media", () => {
		const doc = buildDoc({
			appName: "Choices",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Intake",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "answer",
									label: proseText("Answer"),
									plainLabel: true,
									options: [
										{
											value: "a",
											label: "A",
											uuid: "platform-choice-a",
											plainLabel: true,
											media: {
												image: testMediaAssetId("platform-choice-image"),
											},
										},
										{ value: "b", label: "B", uuid: "platform-choice-b" },
										{
											value: "c",
											label: "C",
											uuid: "platform-choice-c",
											plainLabel: true,
										},
									],
								}),
							],
						},
					],
				},
			],
		});
		const uses = platformFeatureUses(doc, {
			features: new Set<PlatformFeatureId>(["plain-text", "choice-media"]),
		});
		expect(
			uses.map((use) => [
				use.feature,
				use.owner.kind,
				use.owner.kind === "option" ? use.owner.optionUuid : undefined,
				use.site.kind === "slot" ? use.site.slot : undefined,
			]),
		).toEqual([
			["plain-text", "field", undefined, "plainLabel"],
			["plain-text", "option", testUuid("platform-choice-a"), "plainLabel"],
			["choice-media", "option", testUuid("platform-choice-a"), "media"],
			["plain-text", "option", testUuid("platform-choice-c"), "plainLabel"],
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
