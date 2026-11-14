/**
 * What one CommCare HQ project space holds of the values Nova leaves to it,
 * read from one normalized source read of the app there.
 *
 * Nova's publish keeps these as CommCare HQ holds them (the profile settings
 * it seeds only where none is held, the runtime UI text in `translations`,
 * the Android logos, the project space's submission and URL settings), so a
 * `.ccz` made for that project space, Preview and the Publishing card read
 * them from here rather than from Nova's own constants. The reading of HQ's
 * own keys is wire vocabulary, which is why it lives in this package; the
 * deployment layer applies it to a stored baseline.
 *
 * Pure, and outside the barrel.
 */

import { isRuntimeUiStringKey, translationKeyOwner } from "./appStringKeys";

/** The profile settings a project space holds that a `.ccz` writes at its value. */
export const KEPT_PROFILE_PROPERTY_KEYS = [
	"cc-fuzzy-search-enabled",
	"cc-gps-auto-capture-accuracy",
	"cc-content-valid",
	"cc-autoup-freq",
	"cc-enable-tts",
	"cc-autosync-freq",
	"cc-days-form-retain",
	"cc-inflation-target-density",
	"cc-label-required-questions-with-asterisk",
	"cc-login-duration-seconds",
	"cc-maps-default-layer",
	"cc-resize-images",
	"logenabled",
	"unsent-number-limit",
	"unsent-time-limit",
	"cc-log-entity-detail-enabled",
] as const;
export type KeptProfilePropertyKey =
	(typeof KEPT_PROFILE_PROPERTY_KEYS)[number];

export type AndroidLogoSlot = "home" | "login" | "demo";

const ANDROID_LOGO_SLOTS: readonly AndroidLogoSlot[] = [
	"home",
	"login",
	"demo",
];

/** What one project space holds of the values Nova leaves to CommCare HQ. */
export interface TargetFacts {
	/** When CommCare HQ was read: the baseline's `observed_at`. */
	readonly observedAt: string;
	/** Each kept setting the project space holds a value for, as HQ's build writes it. */
	readonly profileProperties: Readonly<
		Partial<Record<KeptProfilePropertyKey, string>>
	>;
	/** Per HQ language code, each key the project space owns that holds text. */
	readonly uiText: Readonly<Record<string, Readonly<Record<string, string>>>>;
	/** Every runtime UI text key the project space owns in any language, blank ones included, sorted. */
	readonly uiTextKeys: readonly string[];
	readonly secureSubmissions: boolean;
	/** The origin (scheme, host, port) of the project space's custom base URL, or null. */
	readonly customBaseUrl: string | null;
	/** Location captured with every form, on an app Nova does not set it on. */
	readonly autoGpsCapture: boolean;
	readonly androidLogos: readonly AndroidLogoSlot[];
	readonly practiceWorker: boolean;
	readonly persistentMenu: boolean;
	readonly breadcrumbs: boolean;
	readonly mobileReportVersion: string;
	/** The worker activity level the project space issues a credential for, or null. */
	readonly credentialLevel: string | null;
	/**
	 * On a deployment Nova brought the app in from: per language of the source, each language code
	 * that language's `translations` entry holds a non-empty name for. Null where Nova created
	 * the HQ app.
	 */
	readonly languageNames: Readonly<
		Record<string, Readonly<Record<string, string>>>
	> | null;
	/** Who fills a seeded setting the project space holds no value for. */
	readonly seeds: "nova" | "target";
}

type JsonObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(holder: JsonObject, key: string): JsonObject {
	const value = holder[key];
	return isObject(value) ? value : {};
}

/**
 * The text HQ's profile template writes for a stored setting value, or null
 * where it writes none.
 *
 * `Application.create_profile` keeps a setting only `if setting_value:`, and
 * the template prints what it kept: `None`, `""`, `False` and `0` are
 * dropped, `True` prints `True`, a number its decimal text and a string
 * itself. A list or an object is no value a setting holds.
 */
export function hqProfileValueText(raw: unknown): string | null {
	if (raw === true) return "True";
	if (typeof raw === "string") return raw === "" ? null : raw;
	if (typeof raw === "number") {
		return raw === 0 || !Number.isFinite(raw) ? null : String(raw);
	}
	return null;
}

/** The source's own language codes, in its order. */
function sourceLanguages(source: JsonObject): readonly string[] {
	const langs = source.langs;
	return Array.isArray(langs)
		? langs.filter((code): code is string => typeof code === "string")
		: [];
}

/** The origin of an absolute `http:` or `https:` URL, or null for anything else. */
function httpOrigin(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	return url.protocol === "http:" || url.protocol === "https:"
		? url.origin
		: null;
}

/** The facts one normalized source read holds. A source that is no object gives null. */
export function targetFactsFromSource(
	source: unknown,
	input: {
		readonly observedAt: string;
		/** True where Nova's own body set `auto_gps_capture` (the baseline's ownership). */
		readonly novaOwnsAutoGpsCapture: boolean;
		/** True where Nova brought the app in: the live app mapping is `adopted`. */
		readonly adopted: boolean;
	},
): TargetFacts | null {
	if (!isObject(source)) return null;

	const profile = objectAt(source, "profile");
	const properties = objectAt(profile, "properties");
	const profileProperties: Partial<Record<KeptProfilePropertyKey, string>> = {};
	for (const key of KEPT_PROFILE_PROPERTY_KEYS) {
		const text = hqProfileValueText(properties[key]);
		if (text !== null) profileProperties[key] = text;
	}

	const langs = sourceLanguages(source);
	const translations = objectAt(source, "translations");
	/* Keys are CommCare HQ's stored text, so every record is built with
	 * `Object.fromEntries`, which defines each key as its own: an assignment
	 * would read a key such as `__proto__` as the object's prototype. */
	const uiTextEntries: [string, Record<string, string>][] = [];
	const uiTextKeys = new Set<string>();
	for (const [lang, table] of Object.entries(translations)) {
		if (!isObject(table)) continue;
		const texts: [string, string][] = [];
		for (const [key, value] of Object.entries(table)) {
			if (translationKeyOwner(key, langs) !== "target") continue;
			if (isRuntimeUiStringKey(key)) uiTextKeys.add(key);
			if (typeof value !== "string" || value === "") continue;
			texts.push([key, value]);
		}
		if (texts.length > 0) uiTextEntries.push([lang, Object.fromEntries(texts)]);
	}
	const uiText: Record<string, Record<string, string>> = Object.fromEntries(
		uiTextEntries,
	);

	let languageNames: Record<string, Record<string, string>> | null = null;
	if (input.adopted) {
		const held: [string, Record<string, string>][] = [];
		for (const lang of new Set(langs)) {
			if (!Object.hasOwn(translations, lang)) continue;
			const table = translations[lang];
			if (!isObject(table)) continue;
			const names: [string, string][] = [];
			for (const code of new Set(langs)) {
				const name = Object.hasOwn(table, code) ? table[code] : undefined;
				if (typeof name === "string" && name !== "") names.push([code, name]);
			}
			if (names.length > 0) held.push([lang, Object.fromEntries(names)]);
		}
		languageNames = Object.fromEntries(held);
	}

	const logoRefs = objectAt(source, "logo_refs");
	const androidLogos = ANDROID_LOGO_SLOTS.filter((slot) => {
		const entry = logoRefs[`hq_logo_android_${slot}`];
		return isObject(entry) && typeof entry.path === "string";
	});

	const practiceWorker = source.practice_mobile_worker_id;
	const mobileReportVersion = source.mobile_ucr_restore_version;

	return {
		observedAt: input.observedAt,
		profileProperties,
		uiText,
		uiTextKeys: [...uiTextKeys].sort(),
		secureSubmissions: source.secure_submissions === true,
		customBaseUrl: httpOrigin(source.custom_base_url),
		autoGpsCapture:
			!input.novaOwnsAutoGpsCapture && source.auto_gps_capture === true,
		androidLogos,
		practiceWorker: typeof practiceWorker === "string" && practiceWorker !== "",
		persistentMenu: source.persistent_menu === true,
		breadcrumbs: source.show_breadcrumbs !== false,
		mobileReportVersion:
			typeof mobileReportVersion === "string" ? mobileReportVersion : "2.0",
		credentialLevel: hqProfileValueText(
			objectAt(profile, "features").credentials,
		),
		languageNames,
		seeds: input.adopted ? "target" : "nova",
	};
}
