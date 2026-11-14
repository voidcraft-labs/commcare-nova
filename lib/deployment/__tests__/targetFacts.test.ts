/**
 * A deployment's facts from its baseline, the kept list they give and what a
 * `.ccz` made from them cannot follow. Pure: each test plants a baseline or a
 * set of facts and reads the projection, so a shell read for facts, a label
 * listed at a default value, or one missed at another value fails by name.
 */

import { describe, expect, it } from "vitest";
import type { TargetFacts } from "@/lib/commcare/targetFacts";
import { KEPT_LABEL_IDS, type KeptLabelId } from "@/lib/publish/keptValues";
import {
	keptAdvisoryFacts,
	keptListFor,
	targetFactsFromBaseline,
} from "../targetFacts";
import type { AppBaseline, AppOwnership } from "../types";

const OBSERVED_AT = "2026-11-10T09:00:00.000Z";

function ownership(autoGpsCapture: boolean): AppOwnership {
	return {
		addOns: [],
		profileProperties: ["cc-show-saved", "cc-show-incomplete"],
		profileCustomProperties: [],
		autoGpsCapture,
	};
}

function baseline(
	origin: "create" | "push" | "cutover",
	autoGpsCapture = false,
): Extract<AppBaseline, { source: unknown }> {
	return {
		origin,
		remoteAppId: "hq-app",
		source: {
			doc_type: "Application",
			langs: ["en"],
			translations: { en: { en: "English", "home.start": "Begin" } },
			auto_gps_capture: true,
			profile: { properties: { "cc-fuzzy-search-enabled": "yes" } },
		},
		sourceDigest: "a".repeat(64),
		ownership: ownership(autoGpsCapture),
		observedAt: OBSERVED_AT,
		observedBy: "u1",
	};
}

describe("targetFactsFromBaseline", () => {
	it("gives no facts for a shell's baseline", () => {
		expect(targetFactsFromBaseline(baseline("create"), false)).toBeNull();
		expect(targetFactsFromBaseline(baseline("create"), true)).toBeNull();
	});

	it("gives a push or cutover read's facts, with its date, its ownership of location capture and the mapping's", () => {
		for (const origin of ["push", "cutover"] as const) {
			const facts = targetFactsFromBaseline(baseline(origin), false);
			expect(facts).toMatchObject({
				observedAt: OBSERVED_AT,
				profileProperties: { "cc-fuzzy-search-enabled": "yes" },
				uiText: { en: { "home.start": "Begin" } },
				autoGpsCapture: true,
				languageNames: null,
				seeds: "nova",
			});
			expect(
				targetFactsFromBaseline(baseline(origin, true), false)?.autoGpsCapture,
			).toBe(false);
			expect(targetFactsFromBaseline(baseline(origin), true)).toMatchObject({
				languageNames: { en: { en: "English" } },
				seeds: "target",
			});
		}
	});
});

/** What a new app's project space holds: every kept value at what a first publish writes. */
const DEFAULTS: TargetFacts = {
	observedAt: OBSERVED_AT,
	profileProperties: {
		"cc-fuzzy-search-enabled": "no",
		"cc-gps-auto-capture-accuracy": "10",
		"cc-content-valid": "no",
		"cc-autoup-freq": "freq-never",
		"cc-enable-tts": "no",
		"cc-autosync-freq": "freq-never",
		"cc-days-form-retain": "-1",
		"cc-inflation-target-density": "none",
		"cc-label-required-questions-with-asterisk": "no",
		"cc-login-duration-seconds": "86400",
		"cc-maps-default-layer": "normal",
		"cc-resize-images": "none",
		logenabled: "Enabled",
		"unsent-number-limit": "5",
		"unsent-time-limit": "5",
	},
	uiText: {},
	uiTextKeys: [],
	secureSubmissions: false,
	customBaseUrl: null,
	autoGpsCapture: false,
	androidLogos: [],
	practiceWorker: false,
	persistentMenu: false,
	breadcrumbs: true,
	mobileReportVersion: "2.0",
	credentialLevel: null,
	languageNames: null,
	seeds: "nova",
};

function withSetting(key: string, value: string): Partial<TargetFacts> {
	return {
		profileProperties: { ...DEFAULTS.profileProperties, [key]: value },
	};
}

/** One planted difference per label: the facts that list it and nothing else. */
const PLANTED: Readonly<Record<KeptLabelId, Partial<TargetFacts>>> = {
	"automatic-app-updates": withSetting("cc-autoup-freq", "freq-daily"),
	"sent-form-retention": withSetting("cc-days-form-retain", "30"),
	"device-logging": withSetting("logenabled", "Disabled"),
	"automatic-sync": withSetting("cc-autosync-freq", "freq-daily"),
	"media-check-at-install": withSetting("cc-content-valid", "yes"),
	"unsent-form-warning-count": withSetting("unsent-number-limit", "10"),
	"unsent-form-warning-days": withSetting("unsent-time-limit", "2"),
	"image-resizing": withSetting("cc-resize-images", "full"),
	"fuzzy-search": withSetting("cc-fuzzy-search-enabled", "yes"),
	"sign-in-duration": withSetting("cc-login-duration-seconds", "3600"),
	"image-scaling": withSetting("cc-inflation-target-density", "DENSITY_HIGH"),
	"location-capture-accuracy": withSetting(
		"cc-gps-auto-capture-accuracy",
		"25",
	),
	"default-map-layer": withSetting("cc-maps-default-layer", "satellite"),
	"text-to-speech": withSetting("cc-enable-tts", "yes"),
	"required-question-asterisk": withSetting(
		"cc-label-required-questions-with-asterisk",
		"yes",
	),
	"case-detail-view-logging": withSetting("cc-log-entity-detail-enabled", "no"),
	"reworded-commcare-screens": { uiTextKeys: ["home.start"] },
	"android-logos": { androidLogos: ["login"] },
	"mobile-report-version": { mobileReportVersion: "1.0" },
	"location-with-every-form": { autoGpsCapture: true },
	"persistent-menu": { persistentMenu: true },
	"web-apps-breadcrumbs": { breadcrumbs: false },
	"secure-submissions": { secureSubmissions: true },
	"custom-base-url": { customBaseUrl: "https://example.org" },
	"practice-mobile-worker": { practiceWorker: true },
	"worker-activity-credential": { credentialLevel: "3MON_ACTIVE" },
};

describe("keptListFor", () => {
	it("lists nothing for a project space that holds every default", () => {
		expect(keptListFor(DEFAULTS)).toEqual([]);
		/* A setting the project space holds no value for differs from nothing. */
		expect(keptListFor({ ...DEFAULTS, profileProperties: {} })).toEqual([]);
	});

	it("lists each label under its own difference, and only it", () => {
		for (const id of KEPT_LABEL_IDS) {
			expect(keptListFor({ ...DEFAULTS, ...PLANTED[id] }), id).toEqual([id]);
		}
	});

	it("lists every label once where every difference is held", () => {
		let all: TargetFacts = DEFAULTS;
		for (const id of KEPT_LABEL_IDS) {
			const planted = PLANTED[id];
			all = {
				...all,
				...planted,
				profileProperties: {
					...all.profileProperties,
					...Object.fromEntries(
						Object.entries(planted.profileProperties ?? {}).filter(
							([key, value]) =>
								DEFAULTS.profileProperties[
									key as keyof TargetFacts["profileProperties"]
								] !== value,
						),
					),
				},
			};
		}
		const listed = keptListFor(all);
		expect(listed).toHaveLength(KEPT_LABEL_IDS.length);
		expect([...listed].sort()).toEqual([...KEPT_LABEL_IDS].sort());
	});
});

describe("keptAdvisoryFacts", () => {
	it("says nothing for a project space that holds every default", () => {
		expect(keptAdvisoryFacts(DEFAULTS, ["en", "fra"])).toEqual({
			uiTextFallsBack: false,
			androidLogos: false,
			practiceWorker: false,
			languageNames: false,
		});
	});

	it("says the UI text falls back where a language of the app has no text for a runtime key", () => {
		const facts: TargetFacts = {
			...DEFAULTS,
			uiText: {
				en: { "home.start": "Begin", "my.own.note": "A note" },
				fra: { "home.start": "Commencer" },
			},
			uiTextKeys: ["home.start"],
		};
		/* `fra` holds no `my.own.note`, which no runtime reads: no advisory. */
		expect(keptAdvisoryFacts(facts, ["en", "fra"]).uiTextFallsBack).toBe(false);
		expect(keptAdvisoryFacts(facts, ["en", "fra", "hin"]).uiTextFallsBack).toBe(
			true,
		);
	});

	it("carries the logos and the practice worker as held", () => {
		expect(
			keptAdvisoryFacts(
				{ ...DEFAULTS, androidLogos: ["home"], practiceWorker: true },
				["en"],
			),
		).toMatchObject({ androidLogos: true, practiceWorker: true });
	});

	it("says a language name may differ only on an app brought in whose tables lack one", () => {
		const names = {
			en: { en: "English", fra: "French" },
			fra: { en: "Anglais", fra: "Français" },
		};
		expect(
			keptAdvisoryFacts({ ...DEFAULTS, languageNames: names }, ["en", "fra"])
				.languageNames,
		).toBe(false);
		expect(
			keptAdvisoryFacts(
				{ ...DEFAULTS, languageNames: { ...names, fra: { fra: "Français" } } },
				["en", "fra"],
			).languageNames,
		).toBe(true);
		expect(
			keptAdvisoryFacts({ ...DEFAULTS, languageNames: null }, ["en", "fra"])
				.languageNames,
		).toBe(false);
	});
});
