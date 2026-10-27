/**
 * The platform rule (`rules/platforms.ts::platformFeatureAvailability`).
 *
 * Contract: each structural use a declared platform cannot run is one
 * finding, located at its owner (the app, the module, the question, or the
 * Search field's module with the field named in its details), whose message
 * is the agent voice of the refusal with the owner as its subject and whose
 * builder line names the same owner. A declaration that runs every use gets
 * none. A finding located at the wrong owner, a Search field finding the
 * editor cannot point at, or a subject the builder cannot name each fails
 * one case here.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type AppSettings,
	NEW_APP_SETTINGS,
	PLATFORMS,
	type Platform,
	platformRefusalMessage,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import { platformFeatureAvailability } from "../platforms";

const MODULE = testUuid("platform-rule-module");
const SURVEY = testUuid("platform-rule-survey");
const FORM = testUuid("platform-rule-form");
const QUESTION = testUuid("platform-rule-question");
const INPUT = testUuid("platform-rule-input");

const settings = (runsOnlyOn?: Platform): AppSettings => ({
	...NEW_APP_SETTINGS,
	...(runsOnlyOn === undefined ? {} : { runsOnlyOn }),
});

/** An app holding, on demand, a Connect app, a several-case module with a
 * single-date Search field, and a date-and-time question. */
function app(options: {
	readonly runsOnlyOn?: Platform;
	readonly connect?: boolean;
	readonly module?: boolean;
	readonly question?: boolean;
}) {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.selection = { kind: "multiple", maximum: 10 };
	config.searchInputs = [
		simpleSearchInputDef(INPUT, "dob", "Date of birth", "date", "dob"),
	];
	return buildDoc({
		appName: "Platform rule",
		appSettings: settings(options.runsOnlyOn),
		connectType: options.connect === true ? "learn" : null,
		modules: [
			...(options.module === true
				? [
						{
							uuid: MODULE,
							name: "Visits",
							caseType: "patient",
							caseListConfig: config,
							forms: [
								{
									name: "Visit",
									type: "followup" as const,
									fields: [
										f({ kind: "text", id: "note", label: proseText("Note") }),
									],
								},
							],
						},
					]
				: []),
			{
				uuid: SURVEY,
				name: "Survey",
				forms: [
					{
						uuid: FORM,
						name: "Register visit",
						type: "survey",
						...(options.connect === true
							? {
									connect: {
										learn_module: {
											id: "lesson",
											name: "Lesson",
											description: "Read it",
											time_estimate: 5,
										},
									},
								}
							: {}),
						fields: [
							options.question === true
								? f({
										kind: "datetime",
										id: "visit_time",
										uuid: QUESTION,
										label: proseText("Visit time"),
									})
								: f({
										kind: "text",
										id: "visit_time",
										uuid: QUESTION,
										label: proseText("Visit time"),
									}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
				],
			},
		],
	});
}

describe("one finding per use, located at its owner", () => {
	const findings = platformFeatureAvailability(
		app({ connect: true, module: true, question: true }),
	);
	const message = (
		feature: Parameters<typeof platformRefusalMessage>[0]["feature"],
		platform: Platform,
		subject: string,
	) =>
		platformRefusalMessage({
			feature,
			platform,
			platforms: PLATFORMS,
			subject,
		});

	it("finds the four uses in document order", () => {
		expect(findings.map((finding) => finding.details?.feature)).toEqual([
			"connect-app",
			"several-cases",
			"search-field-single-date",
			"datetime-question",
		]);
	});

	it("locates the Connect app at the app", () => {
		expect(findings[0]).toEqual({
			code: "PLATFORM_FEATURE_UNAVAILABLE",
			scope: "app",
			message: message("connect-app", "web-apps", "This app"),
			location: {},
			details: {
				feature: "connect-app",
				platform: "web-apps",
				connectType: "learn",
			},
		});
	});

	it("locates several cases at the module", () => {
		expect(findings[1]).toEqual({
			code: "PLATFORM_FEATURE_UNAVAILABLE",
			scope: "module",
			message: message("several-cases", "android", 'Module "Visits"'),
			location: { moduleUuid: MODULE, moduleName: "Visits" },
			details: { feature: "several-cases", platform: "android" },
		});
		expect(userFacingError(findings[1] as never)).toBe(
			'"Visits" lets workers choose several cases, which Android can\'t do. You can let them choose one case, or set the app to run only in Web Apps in App settings.',
		);
	});

	it("locates a Search field at its module and names the field", () => {
		expect(findings[2]).toEqual({
			code: "PLATFORM_FEATURE_UNAVAILABLE",
			scope: "module",
			message: message(
				"search-field-single-date",
				"android",
				'Search field "dob" in module "Visits"',
			),
			location: { moduleUuid: MODULE, moduleName: "Visits" },
			details: {
				feature: "search-field-single-date",
				platform: "android",
				inputUuid: INPUT,
				inputName: "dob",
				slot: "caseListConfig.searchInputs[0]",
			},
		});
		expect(userFacingError(findings[2] as never)).toBe(
			'Search field "dob" asks for one date, which Android doesn\'t show. You can ask for a date range instead, or set the app to run only in Web Apps in App settings.',
		);
	});

	it("locates a date-and-time question at the question", () => {
		expect(findings[3]).toEqual({
			code: "PLATFORM_FEATURE_UNAVAILABLE",
			scope: "field",
			message: message(
				"datetime-question",
				"web-apps",
				'Question "visit_time" in form "Register visit"',
			),
			location: {
				moduleUuid: SURVEY,
				moduleName: "Survey",
				formUuid: FORM,
				formName: "Register visit",
				fieldUuid: QUESTION,
				fieldId: "visit_time",
			},
			details: { feature: "datetime-question", platform: "web-apps" },
		});
	});
});

describe("a declaration that runs every use", () => {
	it("finds nothing for a Connect app and a date-and-time question declared Android only", () => {
		expect(
			platformFeatureAvailability(
				app({ runsOnlyOn: "android", connect: true, question: true }),
			),
		).toEqual([]);
	});

	it("finds nothing for several cases and a single-date Search field declared Web Apps only", () => {
		expect(
			platformFeatureAvailability(
				app({ runsOnlyOn: "web-apps", module: true }),
			),
		).toEqual([]);
	});
});

describe("a date-and-time question wherever it sits", () => {
	const question = f({
		kind: "datetime",
		id: "visit_time",
		uuid: QUESTION,
		label: proseText("Visit time"),
	});
	const placements: ReadonlyArray<readonly [string, FieldSpec[]]> = [
		["at the form root", [question]],
		[
			"in a group",
			[
				f({
					kind: "group",
					id: "visit",
					label: proseText("Visit"),
					children: [question],
				}),
			],
		],
		[
			"in a repeat",
			[
				f({
					kind: "repeat",
					id: "visits",
					label: proseText("Visits"),
					children: [question],
				}),
			],
		],
	];
	const surveyWith = (fields: FieldSpec[], runsOnlyOn?: Platform) =>
		buildDoc({
			appName: "Placement",
			appSettings: settings(runsOnlyOn),
			modules: [
				{
					uuid: SURVEY,
					name: "Survey",
					forms: [
						{ uuid: FORM, name: "Register visit", type: "survey", fields },
					],
				},
			],
		});

	for (const [where, fields] of placements) {
		it(`is located at the question ${where}, and admitted where Android only is declared`, () => {
			const [finding, ...rest] = platformFeatureAvailability(
				surveyWith(fields),
			);
			expect(rest).toEqual([]);
			expect(finding?.location.fieldUuid).toBe(QUESTION);
			expect(finding?.message).toBe(
				platformRefusalMessage({
					feature: "datetime-question",
					platform: "web-apps",
					platforms: PLATFORMS,
					subject: 'Question "visit_time" in form "Register visit"',
				}),
			);
			expect(userFacingError(finding as never)).toBe(
				'"visit_time" asks for a date and time, which Web Apps can\'t show. You can ask for the date and the time separately, or set the app to run only on Android in App settings.',
			);
			expect(
				platformFeatureAvailability(surveyWith(fields, "android")),
			).toEqual([]);
		});
	}
});
