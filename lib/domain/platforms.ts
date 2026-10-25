// lib/domain/platforms.ts
//
// Where an app runs, and what each feature does there. An app declares Web
// Apps, Android or both (`appSettings.runsOnlyOn`, absent for both), and this
// file is the one reader of what that declaration means (`declaredPlatforms`).
//
// `PLATFORM_FEATURES` states, per feature an author can use, whether each
// platform runs it, ignores it, cannot run it or runs it differently, with
// the clause a person reads about it. A feature one declared platform cannot
// run is refused at the commit gate: a structural use by the platform rule
// (`lib/commcare/validator/rules/platforms.ts`), an expression leaf by the
// checker's `platform-unavailable`. The table stands for the surface
// manifest's per-platform readings and is held to them by
// `lib/commcare/surface/__tests__/platformFeatures.test.ts`; the detectors
// that find each use in a document are `platformUses.ts`.
//
// Every string that names one platform inside a sentence builds it from
// `inPlatform` (a worker is in Web Apps and on Android), and every string
// that names a declaration builds it from `platformDeclarationPhrase`.

import type { BlueprintDoc } from "./blueprint";
import type { Expression } from "./expression/types";
import type { FieldKind } from "./fields";

export const PLATFORMS = ["web-apps", "android"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Each platform's name, as Nova says it to people. */
export const PLATFORM_LABELS: Readonly<Record<Platform, string>> = {
	"web-apps": "Web Apps",
	android: "Android",
};

/** The three declarations, by what `runsOnlyOn` holds ("both" is absent). */
export const PLATFORM_DECLARATION_LABELS = {
	both: "Web Apps and Android",
	"web-apps": "Web Apps only",
	android: "Android only",
} as const satisfies Readonly<Record<"both" | Platform, string>>;

const BOTH: readonly Platform[] = Object.freeze(["web-apps", "android"]);
const WEB_APPS_ONLY: readonly Platform[] = Object.freeze(["web-apps"]);
const ANDROID_ONLY: readonly Platform[] = Object.freeze(["android"]);

/** The platforms the app declares, in `PLATFORMS` order: the one reader of
 * what `runsOnlyOn` means. One of three frozen arrays, so a caller may
 * compare by reference. */
export function declaredPlatforms(
	doc: Pick<BlueprintDoc, "appSettings">,
): readonly Platform[] {
	switch (doc.appSettings.runsOnlyOn) {
		case "web-apps":
			return WEB_APPS_ONLY;
		case "android":
			return ANDROID_ONLY;
		default:
			return BOTH;
	}
}

export function declaresWebApps(
	doc: Pick<BlueprintDoc, "appSettings">,
): boolean {
	return declaredPlatforms(doc).includes("web-apps");
}

export function declaresAndroid(
	doc: Pick<BlueprintDoc, "appSettings">,
): boolean {
	return declaredPlatforms(doc).includes("android");
}

function declarationKey(platforms: readonly Platform[]): "both" | Platform {
	const webApps = platforms.includes("web-apps");
	const android = platforms.includes("android");
	if (webApps && android) return "both";
	if (webApps) return "web-apps";
	if (android) return "android";
	throw new Error(
		"A declaration names at least one platform, and this one names none. Pass declaredPlatforms(doc), or a non-empty list of platforms.",
	);
}

/** "Web Apps and Android", "Web Apps only" or "Android only". */
export function platformDeclarationLabel(
	platforms: readonly Platform[],
): string {
	return PLATFORM_DECLARATION_LABELS[declarationKey(platforms)];
}

/** One platform with its own preposition: "in Web Apps" or "on Android". */
export function inPlatform(platform: Platform): "in Web Apps" | "on Android" {
	return platform === "web-apps" ? "in Web Apps" : "on Android";
}

/** The phrase after "runs": "in Web Apps and on Android", "only in Web Apps", "only on Android". */
export function platformDeclarationPhrase(
	platforms: readonly Platform[],
): string {
	const key = declarationKey(platforms);
	return key === "both"
		? `${inPlatform("web-apps")} and ${inPlatform("android")}`
		: `only ${inPlatform(key)}`;
}

function capitalized(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export const PLATFORM_FEATURE_READINGS = [
	"runs",
	"ignored",
	"unavailable",
	"different",
] as const;
export type PlatformFeatureReading = (typeof PLATFORM_FEATURE_READINGS)[number];

export type PlatformBehavior =
	| {
			readonly reading: "runs" | "ignored" | "different";
			/** What the worker meets there, a clause that starts lower case and has no final period. */
			readonly note?: string;
	  }
	| {
			readonly reading: "unavailable";
			readonly note: string;
			/** A whole sentence offering the way that runs on both, when one exists. */
			readonly remedy?: string;
	  };

/** The agent voice of a refusal: present exactly when one reading is `unavailable`. */
export interface PlatformRefusalCopy {
	/** After the subject: "is a date-and-time question". */
	readonly what: string;
	/** One or two sentences: what goes wrong there. */
	readonly why: string;
	/** After "You can": the way that runs on every declared platform. */
	readonly alternative: string;
	/** Replaces the generated narrowing sentence (Connect). */
	readonly closing?: string;
	/** Replaces the generated picker line where the way forward is the feature's own. */
	readonly pickerLine?: string;
}

export interface PlatformFeature {
	readonly label: string;
	/** Who refuses it: the platform rule (`structure`) or the checker (`expression`). */
	readonly channel: "structure" | "expression";
	readonly webApps: PlatformBehavior;
	readonly android: PlatformBehavior;
	readonly refusal?: PlatformRefusalCopy;
	/** The question kind this feature is, where it is one. */
	readonly fieldKind?: FieldKind;
}

export const PLATFORM_FEATURE_IDS = [
	"datetime-question",
	"case-list-here",
	"search-first",
	"several-cases",
	"search-field-single-date",
	"search-field-multiple-choice",
	"connect-app",
	"case-list-search-text",
	"window-width",
	"location-question",
	"barcode-question",
	"image-question",
	"audio-question",
	"video-question",
	"question-pages",
	"choice-media",
	"help-media",
	"now",
	"today",
	"random-and-unique-id",
	"pause",
	"date-as-number",
	"json-property",
	"case-conversion",
	"text-pattern",
	"device-id",
	"app-version",
	"clock-drift",
	"app-language",
	"entry-points",
	"case-list-menu-item",
	"tile-grouping",
	"tile-alignment",
	"tile-border-and-shading",
	"column-hidden-from-results",
	"link-column",
	"search-screen-text",
	"search-field-checks",
	"barcode-search-field",
	"hidden-search-field",
	"search",
	"skip-to-results",
	"after-submit-home",
	"app-logo",
	"saved-forms",
	"incomplete-forms",
	"connect-location-capture",
] as const;
export type PlatformFeatureId = (typeof PLATFORM_FEATURE_IDS)[number];

/** The features a declaration can refuse, in `PLATFORM_FEATURE_IDS` order. */
export const REFUSABLE_PLATFORM_FEATURE_IDS = [
	"datetime-question",
	"case-list-here",
	"search-first",
	"several-cases",
	"search-field-single-date",
	"search-field-multiple-choice",
	"connect-app",
	"case-list-search-text",
	"window-width",
] as const satisfies readonly PlatformFeatureId[];
export type RefusablePlatformFeatureId =
	(typeof REFUSABLE_PLATFORM_FEATURE_IDS)[number];

export const PLATFORM_FEATURES: Readonly<
	Record<PlatformFeatureId, PlatformFeature>
> = {
	"datetime-question": {
		label: "Date and time questions",
		channel: "structure",
		fieldKind: "datetime",
		webApps: {
			reading: "unavailable",
			note: "there's no entry for a date and time, so a worker can't answer one",
			remedy:
				"Ask for a date question and a time question instead, joined in a hidden value as the workflows guide shows.",
		},
		android: { reading: "runs" },
		refusal: {
			what: "is a date-and-time question",
			why: "Web Apps has no entry for a date and time, so a worker there can't answer it, and a form that holds it may not submit.",
			alternative: "ask for a date question and a time question instead",
			pickerLine:
				"Not available in Web Apps. You can ask for a date and a time as two questions, or change where this app runs in App settings.",
		},
	},
	"case-list-here": {
		label: "here() in a case list",
		channel: "expression",
		webApps: {
			reading: "unavailable",
			note: "the worker's location isn't known there, so here() reads blank, or a fixed place while the list is built",
		},
		android: { reading: "runs" },
		refusal: {
			what: "reads here(), the worker's location",
			why: "Web Apps doesn't know where the worker is, so here() reads blank there, or a fixed place while the list is built.",
			alternative: "take here() out of this value",
		},
	},
	"search-first": {
		label: "Search first",
		channel: "structure",
		webApps: {
			reading: "runs",
			note: "a form opened from a link or an entry point reads each Search field's starting value, not what the worker searched for",
		},
		android: {
			reading: "unavailable",
			note: "a worker can open only a case the phone already holds",
			remedy:
				"You can show the case list first and let workers search from it.",
		},
		refusal: {
			what: "opens on Search first",
			why: 'On Android a worker can open only a case the phone already holds, and choosing any other case stops with "Session Refresh Required".',
			alternative:
				"turn Search first off, so the module shows its case list first",
		},
	},
	"several-cases": {
		label: "Choosing several cases",
		channel: "structure",
		webApps: { reading: "runs" },
		android: {
			reading: "unavailable",
			note: "the menu stops at the home screen, so a worker can't reach the form",
			remedy: "You can let workers choose one case at a time.",
		},
		refusal: {
			what: "lets workers choose several cases at once",
			why: "Android can't choose several cases from one list, so a worker there stops at the home screen and never reaches the form.",
			alternative: "let workers choose one case",
		},
	},
	"search-field-single-date": {
		label: "Single-date Search fields",
		channel: "structure",
		webApps: { reading: "runs" },
		android: {
			reading: "unavailable",
			note: "the field isn't shown, so a search runs without it",
			remedy: "A date range Search field runs on both.",
		},
		refusal: {
			what: "asks for a single date",
			why: "Android doesn't show a single-date Search field, so a search there runs without it.",
			alternative: "ask for a date range, which both platforms show",
		},
	},
	"search-field-multiple-choice": {
		label: "Multiple-choice Search fields",
		channel: "structure",
		webApps: { reading: "runs" },
		android: {
			reading: "unavailable",
			note: "the field isn't shown, so a search runs without it",
			remedy: "A single-choice Search field runs on both.",
		},
		refusal: {
			what: "lets workers pick several choices",
			why: "Android doesn't show a multiple-choice Search field, so a search there runs without it.",
			alternative: "let workers pick one choice, which both platforms show",
		},
	},
	"connect-app": {
		label: "CommCare Connect",
		channel: "structure",
		webApps: {
			reading: "unavailable",
			note: "workers sign in to a Connect app only in the Connect app on Android",
		},
		android: {
			reading: "runs",
			note: "the Connect app installs it and signs workers in with PersonalID",
		},
		refusal: {
			what: "is a CommCare Connect app",
			why: "Connect workers open it only in the Connect app on Android: CommCare HQ gives them no password, so they can't sign in to Web Apps.",
			alternative: "turn Connect off",
			closing:
				'You can set the app to run only on Android (updateApp/update_app, runs_only_on "android"), or turn Connect off (configureConnect/configure_connect, mode null).',
			pickerLine:
				"Not available for a Connect app. You can turn off Connect, then choose this.",
		},
	},
	"case-list-search-text": {
		label: "Case list search text",
		channel: "expression",
		webApps: {
			reading: "unavailable",
			note: "the case list keeps no search text, so the read is always blank",
		},
		android: {
			reading: "runs",
			note: "the text the worker typed in the case list's search box, blank when there's none",
		},
		refusal: {
			what: "reads the case list's search text",
			why: "Web Apps keeps no case list search text, so the read is always blank there.",
			alternative: "take the read out",
		},
	},
	"window-width": {
		label: "Window width",
		channel: "expression",
		webApps: {
			reading: "runs",
			note: "the width of the worker's browser window, sent each time a menu or a list loads",
		},
		android: {
			reading: "unavailable",
			note: "there's no window width, so a screen that reads it can't open",
		},
		refusal: {
			what: "reads the window width",
			why: "Android has no window width, so a screen that reads it can't open there.",
			alternative: "take the read out",
		},
	},
	"location-question": {
		label: "Location questions",
		channel: "structure",
		fieldKind: "geopoint",
		webApps: {
			reading: "different",
			note: "the worker places a point on a map, with no altitude or accuracy",
		},
		android: {
			reading: "runs",
			note: "the device records its location, with altitude and accuracy",
		},
	},
	"barcode-question": {
		label: "Barcode questions",
		channel: "structure",
		fieldKind: "barcode",
		webApps: { reading: "different", note: "the worker types the code" },
		android: { reading: "runs", note: "the camera scans it" },
	},
	"image-question": {
		label: "Image questions",
		channel: "structure",
		fieldKind: "image",
		webApps: {
			reading: "different",
			note: "the worker attaches a JPG, JPEG or PNG file of up to 4 MB",
		},
		android: {
			reading: "runs",
			note: "the worker takes a picture with the camera or chooses one, up to 15 MB",
		},
	},
	"audio-question": {
		label: "Audio questions",
		channel: "structure",
		fieldKind: "audio",
		webApps: {
			reading: "different",
			note: "the worker attaches an MP3, WAV, OGG, AMR, QCP or 3GA file of up to 4 MB",
		},
		android: {
			reading: "runs",
			note: "the worker records it in the app, up to 15 MB",
		},
	},
	"video-question": {
		label: "Video questions",
		channel: "structure",
		fieldKind: "video",
		webApps: {
			reading: "different",
			note: "the worker attaches an MP4, MPG, MPEG, MPG4, MPEG4, M4V, 3GP, 3GPP, 3GP2 or 3G2 file of up to 4 MB",
		},
		android: {
			reading: "runs",
			note: "the worker records a video with the camera or chooses one, up to 15 MB",
		},
	},
	"question-pages": {
		label: "Question pages",
		channel: "structure",
		webApps: { reading: "ignored", note: "the whole form shows on one page" },
		android: { reading: "runs", note: "each page shows on its own screen" },
	},
	"choice-media": {
		label: "Pictures and sound on choices",
		channel: "structure",
		webApps: { reading: "ignored", note: "choices show their text only" },
		android: { reading: "runs" },
	},
	"help-media": {
		label: "Help media",
		channel: "structure",
		webApps: {
			reading: "different",
			note: "it shows only when the help has text",
		},
		android: { reading: "runs" },
	},
	now: {
		label: "now()",
		channel: "expression",
		webApps: {
			reading: "different",
			note: "it reads the server's clock, and a calculated value that uses it changes each time the worker answers a question",
		},
		android: { reading: "runs", note: "it reads the phone's clock" },
	},
	today: {
		label: "today()",
		channel: "expression",
		webApps: {
			reading: "different",
			note: "the day comes from the server's clock, in the browser's time zone",
		},
		android: {
			reading: "runs",
			note: "the day comes from the phone's clock and time zone",
		},
	},
	"random-and-unique-id": {
		label: "random() and uuid()",
		channel: "expression",
		webApps: {
			reading: "different",
			note: "a calculated value that uses them changes each time the worker answers a question",
		},
		android: { reading: "runs" },
	},
	pause: {
		label: "sleep()",
		channel: "expression",
		webApps: {
			reading: "different",
			note: "it pauses each time the worker answers a question",
		},
		android: {
			reading: "runs",
			note: "it pauses only when a value it depends on changes",
		},
	},
	"date-as-number": {
		label: "A date read as a number",
		channel: "expression",
		webApps: {
			reading: "different",
			note: "the number is counted in the server's time zone, UTC, not the worker's",
		},
		android: { reading: "runs" },
	},
	"json-property": {
		label: "json-property()",
		channel: "expression",
		webApps: {
			reading: "different",
			note: "a value that isn't text reads blank",
		},
		android: {
			reading: "different",
			note: "a value that isn't text reads as its JSON text",
		},
	},
	"case-conversion": {
		label: "lower-case() and upper-case()",
		channel: "expression",
		webApps: {
			reading: "different",
			note: "letters change by the server's language rules",
		},
		android: {
			reading: "different",
			note: "letters change by the phone's language rules",
		},
	},
	"text-pattern": {
		label: "Pattern matches and replace()",
		channel: "expression",
		webApps: {
			reading: "different",
			note: "letter and digit classes match only English letters and digits",
		},
		android: {
			reading: "different",
			note: "letter and digit classes match every alphabet, and named groups need Android 8 or later",
		},
	},
	"device-id": {
		label: "Device ID",
		channel: "expression",
		webApps: { reading: "different", note: "it reads Formplayer" },
		android: { reading: "runs", note: "it reads the phone's own ID" },
	},
	"app-version": {
		label: "App version",
		channel: "expression",
		webApps: {
			reading: "different",
			note: "it reads Formplayer's version, not the app's",
		},
		android: {
			reading: "runs",
			note: "it reads the app's version on the phone",
		},
	},
	"clock-drift": {
		label: "Clock drift",
		channel: "expression",
		webApps: { reading: "different", note: "it's always 0" },
		android: {
			reading: "runs",
			note: "the whole hours the phone's clock was ahead of the server's when it last reached the server",
		},
	},
	"app-language": {
		label: "App language",
		channel: "expression",
		webApps: {
			reading: "different",
			note: "it's the worker's language in menus and case lists and when a form opens, and may differ on later answers in a form",
		},
		android: { reading: "runs" },
	},
	"entry-points": {
		label: "Deep links",
		channel: "structure",
		webApps: { reading: "different", note: "a link opens it in the browser" },
		android: {
			reading: "different",
			note: "only another app or CommCare Connect can open it, and it ignores display conditions",
		},
	},
	"case-list-menu-item": {
		label: "Case list menus",
		channel: "structure",
		webApps: {
			reading: "different",
			note: "choosing a case shows Redirecting after sync and returns to the app's first menu",
		},
		android: {
			reading: "runs",
			note: "with no case details, choosing a case returns to the home screen",
		},
	},
	"tile-grouping": {
		label: "Grouped tiles",
		channel: "structure",
		webApps: { reading: "runs" },
		android: {
			reading: "ignored",
			note: "the list shows every case as its own tile",
		},
	},
	"tile-alignment": {
		label: "Tile cell alignment",
		channel: "structure",
		webApps: { reading: "runs" },
		android: {
			reading: "different",
			note: "only Middle vertical alignment takes effect",
		},
	},
	"tile-border-and-shading": {
		label: "Tile borders and shading",
		channel: "structure",
		webApps: { reading: "runs" },
		android: { reading: "ignored", note: "cells show no border or shading" },
	},
	"column-hidden-from-results": {
		label: "Columns hidden from Results",
		channel: "structure",
		webApps: {
			reading: "different",
			note: "workers can still search by it, and sort by it only from Sort by",
		},
		android: { reading: "runs" },
	},
	"link-column": {
		label: "Link columns",
		channel: "structure",
		webApps: { reading: "runs" },
		android: {
			reading: "different",
			note: "the case list shows the address as plain text rather than a link, and only the case's details show it as a link",
		},
	},
	"search-screen-text": {
		label: "Search screen title, subtitle and hints",
		channel: "structure",
		webApps: { reading: "runs" },
		android: {
			reading: "ignored",
			note: "the Search screen shows none of them",
		},
	},
	"search-field-checks": {
		label: "Required Search fields and checks",
		channel: "structure",
		webApps: {
			reading: "runs",
			note: "the app checks the answer before it searches",
		},
		android: {
			reading: "ignored",
			note: "the search runs without checking the answer",
		},
	},
	"barcode-search-field": {
		label: "Barcode Search fields",
		channel: "structure",
		webApps: { reading: "ignored", note: "it's a plain text box" },
		android: { reading: "runs", note: "the camera can scan a code into it" },
	},
	"hidden-search-field": {
		label: "Hidden Search values",
		channel: "structure",
		webApps: { reading: "runs" },
		android: {
			reading: "different",
			note: "the value shows on the Search screen, and the worker can change it",
		},
	},
	search: {
		label: "Search",
		channel: "structure",
		webApps: { reading: "runs" },
		android: {
			reading: "different",
			note: "a search that finds nothing stays on the Search screen, and each case a worker opens from the results is followed by a sync",
		},
	},
	"skip-to-results": {
		label: "Skip to results",
		channel: "structure",
		webApps: { reading: "runs" },
		android: {
			reading: "ignored",
			note: "the case list opens first, and Search opens the Search screen",
		},
	},
	"after-submit-home": {
		label: "App home after submit",
		channel: "structure",
		webApps: {
			reading: "different",
			note: "after submit, App home and First menu both open the app's first menu",
		},
		android: {
			reading: "different",
			note: "after submit, App home opens the CommCare home screen, and First menu opens the app's first menu",
		},
	},
	"app-logo": {
		label: "App logo",
		channel: "structure",
		webApps: { reading: "runs" },
		android: { reading: "ignored", note: "the app shows no logo" },
	},
	"saved-forms": {
		label: "Saved forms",
		channel: "structure",
		webApps: {
			reading: "ignored",
			note: "workers can't look back at forms they have sent",
		},
		android: {
			reading: "runs",
			note: "workers open them from the home screen",
		},
	},
	"incomplete-forms": {
		label: "Incomplete forms",
		channel: "structure",
		webApps: {
			reading: "different",
			note: "the setting shows or hides the list, and every unfinished form is kept either way",
		},
		android: { reading: "runs" },
	},
	"connect-location-capture": {
		label: "Connect location capture",
		channel: "structure",
		webApps: { reading: "ignored", note: "forms are sent with no location" },
		android: {
			reading: "runs",
			note: "each form records where the worker was",
		},
	},
};

export function platformBehavior(
	feature: PlatformFeatureId,
	platform: Platform,
): PlatformBehavior {
	const row = PLATFORM_FEATURES[feature];
	return platform === "web-apps" ? row.webApps : row.android;
}

/** The first platform of `platforms`, in `PLATFORMS` order, where the feature reads `unavailable`. */
export function unavailablePlatform(
	feature: PlatformFeatureId,
	platforms: readonly Platform[],
): Platform | undefined {
	return PLATFORMS.find(
		(platform) =>
			platforms.includes(platform) &&
			platformBehavior(feature, platform).reading === "unavailable",
	);
}

/** Whether a declaration refuses the feature, and where: what every offering site asks. */
export function platformRefusal(
	feature: PlatformFeatureId,
	platforms: readonly Platform[],
):
	| { readonly feature: PlatformFeatureId; readonly platform: Platform }
	| undefined {
	const platform = unavailablePlatform(feature, platforms);
	return platform === undefined ? undefined : { feature, platform };
}

const FEATURE_BY_FIELD_KIND: ReadonlyMap<FieldKind, PlatformFeatureId> =
	new Map(
		PLATFORM_FEATURE_IDS.flatMap((id) => {
			const kind = PLATFORM_FEATURES[id].fieldKind;
			return kind === undefined ? [] : [[kind, id] as const];
		}),
	);

/** The feature a question kind is, if any. */
export function featureForFieldKind(
	kind: FieldKind,
): PlatformFeatureId | undefined {
	return FEATURE_BY_FIELD_KIND.get(kind);
}

/** The feature an expression node is on its own, without typing, if it is
 * one the checker can refuse. */
export function expressionLeafFeature(
	expression: Expression,
): PlatformFeatureId | undefined {
	if (expression.kind === "here") return "case-list-here";
	if (expression.kind === "case-list-search-text")
		return "case-list-search-text";
	if (
		expression.kind === "term" &&
		expression.term.kind === "session-context" &&
		expression.term.field === "window_width"
	)
		return "window-width";
	return undefined;
}

/**
 * The feature's stated difference on each platform of `platforms`: the
 * guide's per-feature sentence and the builder's note. An unavailable
 * reading speaks its note and remedy; any other reading with a note speaks
 * the note; a reading with no note says nothing.
 */
export function platformSentence(
	feature: PlatformFeatureId,
	platforms: readonly Platform[] = PLATFORMS,
): string {
	const pieces: string[] = [];
	for (const platform of PLATFORMS) {
		if (!platforms.includes(platform)) continue;
		const behavior = platformBehavior(feature, platform);
		if (behavior.reading === "unavailable") {
			pieces.push(`Not available ${inPlatform(platform)}: ${behavior.note}.`);
			if (behavior.remedy !== undefined) pieces.push(behavior.remedy);
		} else if (behavior.note !== undefined)
			pieces.push(`${capitalized(inPlatform(platform))}, ${behavior.note}.`);
	}
	return pieces.join(" ");
}

/** The line a picker or menu shows beside a choice it withholds: what
 * withholds it, then the way forward. */
export function platformPickerLine(refusal: {
	readonly feature: PlatformFeatureId;
	readonly platform: Platform;
}): string {
	return (
		PLATFORM_FEATURES[refusal.feature].refusal?.pickerLine ??
		`Not available ${inPlatform(refusal.platform)}. You can change where this app runs in App settings.`
	);
}

function otherPlatform(platform: Platform): Platform {
	return platform === "web-apps" ? "android" : "web-apps";
}

/**
 * The agent and MCP voice of a refusal: the validator's message for a
 * feature a declared platform cannot run. Names the subject, the
 * declaration, why the platform can't run it, and both ways forward.
 */
export function platformRefusalMessage(options: {
	readonly feature: PlatformFeatureId;
	readonly platform: Platform;
	readonly platforms: readonly Platform[];
	readonly subject: string;
}): string {
	const row = PLATFORM_FEATURES[options.feature];
	const copy = row.refusal;
	const declaration = platformDeclarationPhrase(options.platforms);
	if (copy === undefined)
		return `${options.subject} uses ${row.label}, which isn't available ${inPlatform(options.platform)}, and the app runs ${declaration}.`;
	const lead = `${options.subject} ${copy.what}, and the app runs ${declaration}. ${copy.why}`;
	if (copy.closing !== undefined) return `${lead} ${copy.closing}`;
	const other = otherPlatform(options.platform);
	const otherAudience =
		other === "web-apps" ? "Web Apps" : "the CommCare app on Android";
	return `${lead} You can ${copy.alternative}, or, if workers use only ${otherAudience}, set the app to run ${platformDeclarationPhrase([other])} (updateApp/update_app, runs_only_on "${other}").`;
}
