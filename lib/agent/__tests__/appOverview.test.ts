import { expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	PLATFORM_FEATURE_IDS,
	PLATFORM_FEATURES,
	PLATFORMS,
	type Platform,
	platformBehavior,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { appOverview } from "../appOverview";
import { buildAppStateMessage } from "../prompts";

it("orients an edit without sending every question's content", () => {
	const doc = buildDoc({
		appId: "overview-app",
		appName: "Clinic intake",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: Array.from({ length: 220 }, (_, index) => ({
							kind: "text" as const,
							id: `question_${index}`,
							label: `Question ${index}`,
						})),
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const overview = appOverview(doc);
	expect(overview).toMatchObject({
		appId: "overview-app",
		name: "Clinic intake",
		modules: [
			{
				uuid: moduleUuid,
				name: "Visits",
				forms: [
					{ uuid: formUuid, name: "Intake", type: "survey", fields: 220 },
				],
			},
		],
	});
	const verbose = structuredClone(doc);
	for (const field of Object.values(verbose.fields)) {
		if (field.kind === "text")
			field.label = proseText(
				"Detailed clinical question guidance. ".repeat(100),
			);
	}
	expect(appOverview(verbose)).toEqual(overview);
	expect(buildAppStateMessage(verbose)).toEqual(buildAppStateMessage(doc));
	expect(JSON.stringify(buildAppStateMessage(doc))).not.toContain(
		"question_219",
	);
});

it("holds the document's form-list settings", () => {
	const doc = buildDoc({
		appSettings: { showSavedForms: true, showIncompleteForms: false },
	});
	expect(appOverview(doc).settings).toEqual({
		showSavedForms: true,
		showIncompleteForms: false,
	});
});

it.each([
	[undefined, ["web-apps", "android"]],
	["web-apps", ["web-apps"]],
	["android", ["android"]],
] as const)(
	"names where an app with runsOnlyOn %s runs and every feature refused there",
	(runsOnlyOn, platforms) => {
		const doc = buildDoc({
			appSettings: {
				showSavedForms: false,
				showIncompleteForms: false,
				...(runsOnlyOn !== undefined && { runsOnlyOn }),
			},
		});
		const overview = appOverview(doc);
		expect(overview.platforms).toEqual(platforms);
		const suffix: Record<Platform, string> = {
			"web-apps": "not in Web Apps",
			android: "not on Android",
		};
		const expected = PLATFORM_FEATURE_IDS.flatMap((id) => {
			const platform = PLATFORMS.find(
				(each) =>
					(platforms as readonly Platform[]).includes(each) &&
					platformBehavior(id, each).reading === "unavailable",
			);
			return platform === undefined
				? []
				: [`${PLATFORM_FEATURES[id].label}, ${suffix[platform]}`];
		});
		expect(overview.notOffered).toEqual(expected);
		if (runsOnlyOn === undefined)
			expect(overview.notOffered).toContain(
				`${PLATFORM_FEATURES["datetime-question"].label}, not in Web Apps`,
			);
		if (runsOnlyOn === "android")
			expect(overview.notOffered).not.toContain(
				`${PLATFORM_FEATURES["datetime-question"].label}, not in Web Apps`,
			);
	},
);
