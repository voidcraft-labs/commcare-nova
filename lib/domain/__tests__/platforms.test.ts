/**
 * The declaration's one reader and the table's sentence builders
 * (`platforms.ts`).
 *
 * Contract: `declaredPlatforms` is the only reading of what `runsOnlyOn`
 * means, returning one of three frozen arrays; every string that names a
 * platform in a sentence says "in Web Apps" and "on Android"; a refusal is
 * the first declared platform where the feature reads unavailable; and the
 * three voices of a refusal are built from the row's copy in one frame, so
 * a remedy, a platform or a way forward is never dropped. A second reading
 * of the stored key, "on Web Apps", a picker line that dead-ends, or a
 * message that names the wrong platform each fails one case here.
 */

import { describe, expect, it } from "vitest";
import {
	declaredPlatforms,
	declaresAndroid,
	declaresWebApps,
	expressionLeafFeature,
	featureForFieldKind,
	inPlatform,
	NEW_APP_SETTINGS,
	PLATFORM_FEATURE_IDS,
	PLATFORM_FEATURES,
	PLATFORMS,
	type Platform,
	platformDeclarationLabel,
	platformDeclarationPhrase,
	platformPickerLine,
	platformRefusal,
	platformRefusalMessage,
	platformSentence,
	REFUSABLE_PLATFORM_FEATURE_IDS,
	unavailablePlatform,
} from "@/lib/domain";

const declaring = (runsOnlyOn?: Platform) => ({
	appSettings: {
		...NEW_APP_SETTINGS,
		...(runsOnlyOn === undefined ? {} : { runsOnlyOn }),
	},
});

describe("the declaration", () => {
	it("reads absent as both and each value as its one platform, as frozen arrays", () => {
		const both = declaredPlatforms(declaring());
		expect(both).toEqual(["web-apps", "android"]);
		expect(declaredPlatforms(declaring())).toBe(both);
		expect(declaredPlatforms(declaring("web-apps"))).toEqual(["web-apps"]);
		expect(declaredPlatforms(declaring("android"))).toEqual(["android"]);
		for (const runsOnlyOn of [undefined, "web-apps", "android"] as const)
			expect(Object.isFrozen(declaredPlatforms(declaring(runsOnlyOn)))).toBe(
				true,
			);
	});

	it("answers whether each platform is declared", () => {
		expect(declaresWebApps(declaring())).toBe(true);
		expect(declaresAndroid(declaring())).toBe(true);
		expect(declaresWebApps(declaring("android"))).toBe(false);
		expect(declaresAndroid(declaring("web-apps"))).toBe(false);
	});

	it("names each declaration, and refuses an empty one", () => {
		expect(platformDeclarationLabel(PLATFORMS)).toBe("Web Apps and Android");
		expect(platformDeclarationLabel(["web-apps"])).toBe("Web Apps only");
		expect(platformDeclarationLabel(["android"])).toBe("Android only");
		expect(platformDeclarationPhrase(PLATFORMS)).toBe(
			"in Web Apps and on Android",
		);
		expect(platformDeclarationPhrase(["web-apps"])).toBe("only in Web Apps");
		expect(platformDeclarationPhrase(["android"])).toBe("only on Android");
		expect(() => platformDeclarationLabel([])).toThrow(/names none/);
		expect(() => platformDeclarationPhrase([])).toThrow(/names none/);
	});

	it("gives each platform its own preposition", () => {
		expect(inPlatform("web-apps")).toBe("in Web Apps");
		expect(inPlatform("android")).toBe("on Android");
	});
});

describe("refusals", () => {
	it("refuses each refusable feature exactly on the declarations that hold its unavailable platform", () => {
		for (const feature of REFUSABLE_PLATFORM_FEATURE_IDS) {
			const blocked = unavailablePlatform(feature, PLATFORMS);
			expect(blocked).toBeDefined();
			for (const platforms of [PLATFORMS, ["web-apps"], ["android"]] as const) {
				const expected = platforms.some((platform) => platform === blocked)
					? { feature, platform: blocked }
					: undefined;
				expect(platformRefusal(feature, platforms)).toEqual(expected);
				expect(unavailablePlatform(feature, platforms)).toBe(
					expected?.platform,
				);
			}
		}
	});

	it("refuses nothing a feature with no unavailable reading names", () => {
		for (const feature of PLATFORM_FEATURE_IDS.filter(
			(id) =>
				!(REFUSABLE_PLATFORM_FEATURE_IDS as readonly string[]).includes(id),
		))
			expect(platformRefusal(feature, PLATFORMS)).toBeUndefined();
	});

	it("names the feature a question kind is, and the leaf a node is", () => {
		for (const feature of PLATFORM_FEATURE_IDS) {
			const kind = PLATFORM_FEATURES[feature].fieldKind;
			if (kind !== undefined) expect(featureForFieldKind(kind)).toBe(feature);
		}
		expect(featureForFieldKind("text")).toBeUndefined();
		expect(expressionLeafFeature({ kind: "here" })).toBe("case-list-here");
		expect(expressionLeafFeature({ kind: "now" })).toBeUndefined();
	});
});

describe("platformSentence", () => {
	it("speaks an unavailable reading with its remedy, then each note in platform order", () => {
		expect(platformSentence("datetime-question")).toBe(
			"Not available in Web Apps: there's no entry for a date and time, so a worker can't answer one. Ask for a date question and a time question instead, joined in a hidden value as the workflows guide shows.",
		);
		expect(platformSentence("location-question")).toBe(
			"In Web Apps, the worker places a point on a map, with no altitude or accuracy. On Android, the device records its location, with altitude and accuracy.",
		);
	});

	it("leaves out a reading with no note, and a platform it was not asked about", () => {
		expect(platformSentence("tile-grouping")).toBe(
			"On Android, the list shows every case as its own tile.",
		);
		expect(platformSentence("tile-grouping", ["android"])).toBe(
			"On Android, the list shows every case as its own tile.",
		);
		expect(platformSentence("location-question", ["android"])).toBe(
			"On Android, the device records its location, with altitude and accuracy.",
		);
		expect(platformSentence("tile-grouping", ["web-apps"])).toBe("");
	});

	it("never says on Web Apps", () => {
		for (const feature of PLATFORM_FEATURE_IDS)
			expect(platformSentence(feature)).not.toMatch(/on Web Apps/);
	});
});

describe("platformRefusalMessage", () => {
	it("names the subject, the declaration, why, and both ways forward", () => {
		expect(
			platformRefusalMessage({
				feature: "datetime-question",
				platform: "web-apps",
				platforms: PLATFORMS,
				subject: 'Question "visit_time" in form "Register visit"',
			}),
		).toBe(
			'Question "visit_time" in form "Register visit" is a date-and-time question, and the app runs in Web Apps and on Android. Web Apps has no entry for a date and time, so a worker there can\'t answer it, and a form that holds it may not submit. You can ask for a date question and a time question instead, or, if workers use only the CommCare app on Android, set the app to run only on Android (updateApp/update_app, runs_only_on "android").',
		);
		expect(
			platformRefusalMessage({
				feature: "several-cases",
				platform: "android",
				platforms: PLATFORMS,
				subject: 'Module "Visits"',
			}),
		).toBe(
			'Module "Visits" lets workers choose several cases at once, and the app runs in Web Apps and on Android. Android can\'t choose several cases from one list, so a worker there stops at the home screen and never reaches the form. You can let workers choose one case, or, if workers use only Web Apps, set the app to run only in Web Apps (updateApp/update_app, runs_only_on "web-apps").',
		);
	});

	it("lets a row's closing replace the generated ways forward", () => {
		expect(
			platformRefusalMessage({
				feature: "connect-app",
				platform: "web-apps",
				platforms: PLATFORMS,
				subject: "This app",
			}),
		).toBe(
			'This app is a CommCare Connect app, and the app runs in Web Apps and on Android. Connect workers open it only in the Connect app on Android: CommCare HQ gives them no password, so they can\'t sign in to Web Apps. You can set the app to run only on Android (updateApp/update_app, runs_only_on "android"), or turn Connect off (configureConnect/configure_connect, mode null).',
		);
	});
});

describe("platformPickerLine", () => {
	it("says what withholds a choice and the way forward, on each platform", () => {
		expect(
			platformPickerLine({ feature: "case-list-here", platform: "web-apps" }),
		).toBe(
			"Not available in Web Apps. You can change where this app runs in App settings.",
		);
		expect(
			platformPickerLine({ feature: "several-cases", platform: "android" }),
		).toBe(
			"Not available on Android. You can change where this app runs in App settings.",
		);
	});

	it("takes a row's own line where its way forward is the feature's", () => {
		expect(
			platformPickerLine({
				feature: "datetime-question",
				platform: "web-apps",
			}),
		).toBe(
			"Not available in Web Apps. You can ask for a date and a time as two questions, or change where this app runs in App settings.",
		);
		expect(
			platformPickerLine({ feature: "connect-app", platform: "web-apps" }),
		).toBe(
			"Not available for a Connect app. You can turn off Connect, then choose this.",
		);
	});
});
