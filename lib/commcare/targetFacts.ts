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
 * Every baseline reaches an archive only through `targetFactsFromSource`, a
 * bring-in's, a bring-in of changes', a publish's read-back and a Refresh of
 * kept values alike, so what CommCare HQ keeps is admitted here and nowhere
 * else: no fact names an address a phone is sent to (a custom base URL is a
 * host to show), a text is carried only where its line in the archive reads
 * back as one record under its own key, and a setting only where XML can
 * carry it. What is left out is said in the facts.
 *
 * Pure, and outside the barrel.
 */

import { isRuntimeUiStringKey, translationKeyOwner } from "./appStringKeys";
import { isLocaleFileKey, isLocaleFileValue } from "./localeFile";
import { xmlTextIssue } from "./xmlText";

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

/**
 * The address a project space's custom base URL sends a phone to in HQ's own
 * build, for a person to read and for the one comparison a download makes.
 * It is never written into a file: a `.ccz` names only the server the
 * deployment is on (`runtimeTarget.ts::profileServerProperties`).
 */
export interface HeldBaseUrl {
	/** The host, and its port where one is written, as stored, never the user information before it. */
	readonly host: string;
	/**
	 * The base's origin as a phone reaches it where it is `https` with no user
	 * information (`URL.origin`: the host's letters lowered, a default port
	 * dropped), and null for any other base, which is no server's own address.
	 */
	readonly origin: string | null;
}

/** What one project space holds of the values Nova leaves to CommCare HQ. */
export interface TargetFacts {
	/** When CommCare HQ was read: the baseline's `observed_at`. */
	readonly observedAt: string;
	/**
	 * Each kept setting the project space holds a value for, as HQ's build
	 * writes it, where XML can carry the value.
	 */
	readonly profileProperties: Readonly<
		Partial<Record<KeptProfilePropertyKey, string>>
	>;
	/**
	 * A kept setting or the worker activity credential level holds a character
	 * XML 1.0 cannot carry, so the facts leave it out and a `.ccz` writes none.
	 */
	readonly profileNotCarried: boolean;
	/**
	 * Per HQ language code, each key the project space owns that holds text,
	 * where the key is one locale record under its own name and the text is
	 * one record too: no carriage return, and not only control characters
	 * (`localeFile.ts::isLocaleFileKey`, `isLocaleFileValue`).
	 */
	readonly uiText: Readonly<Record<string, Readonly<Record<string, string>>>>;
	/** Every runtime UI text key the project space owns in any language, blank ones included, sorted. */
	readonly uiTextKeys: readonly string[];
	/**
	 * The language codes, sorted, whose stored `translations` hold text HQ's
	 * build writes and a `.ccz` cannot carry as it is stored: under a key that
	 * is no locale record of its own name, or a text that is no one record.
	 */
	readonly uiTextNotCarried: readonly string[];
	readonly secureSubmissions: boolean;
	/**
	 * Where HQ's build sends a phone for the project space's custom base URL
	 * (`hqUrlBase`), or null where it keeps no address.
	 */
	readonly customBaseUrl: HeldBaseUrl | null;
	/** The last observed HQ app setting, which an upload with Connect off leaves in place. */
	readonly autoGpsCapture: boolean;
	/** Whether Nova owned the setting at that observation, for the list of settings kept in HQ. */
	readonly novaOwnsAutoGpsCapture: boolean;
	readonly androidLogos: readonly AndroidLogoSlot[];
	readonly practiceWorker: boolean;
	readonly persistentMenu: boolean;
	readonly breadcrumbs: boolean;
	readonly mobileReportVersion: string;
	/** The worker activity level the project space issues a credential for, or null. */
	readonly credentialLevel: string | null;
	/**
	 * On a deployment Nova brought the app in from: per language of the source, each language code
	 * that language's `translations` entry holds a non-empty name for that a locale file carries
	 * as one record (`localeFile.ts::isLocaleFileValue`). Null where Nova created the HQ app.
	 */
	readonly languageNames: Readonly<
		Record<string, Readonly<Record<string, string>>>
	> | null;
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

/** The characters Python's `urllib.parse` takes in a scheme. */
const SCHEME_CHARS = new Set(
	"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.",
);

function isAsciiLetter(char: string | undefined): boolean {
	return char !== undefined && /^[A-Za-z]$/.test(char);
}

function isHexDigit(char: string): boolean {
	return /^[0-9A-Fa-f]$/.test(char);
}

/**
 * Whether `ipaddress.ip_address` reads a bracketed host as an IPv6 address:
 * the address before an optional `%` scope, which is non-empty and holds no
 * second `%`, parsed as an IPv6 literal.
 */
function isIpv6Literal(hostname: string): boolean {
	const scope = hostname.indexOf("%");
	const address = scope === -1 ? hostname : hostname.slice(0, scope);
	if (scope !== -1) {
		const id = hostname.slice(scope + 1);
		if (id === "" || id.includes("%")) return false;
	}
	if (!address.includes(":")) return false;
	try {
		new URL(`http://[${address}]/`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether `urlsplit` accepts a netloc that holds a bracket, as
 * `_check_bracketed_netloc` and `_check_bracketed_host` read it: both
 * brackets, nothing before the opening one, nothing but a port after the
 * closing one, and inside them an IPvFuture (`v`, hex digits, a dot, then
 * at least one character) or an IPv6 address.
 */
function acceptsBracketedNetloc(netloc: string): boolean {
	if (!netloc.includes("[") || !netloc.includes("]")) return false;
	const hostAndPort = netloc.slice(netloc.lastIndexOf("@") + 1);
	let hostname: string;
	const open = hostAndPort.indexOf("[");
	if (open !== -1) {
		if (open > 0) return false;
		const close = hostAndPort.indexOf("]", open + 1);
		const afterHost = close === -1 ? "" : hostAndPort.slice(close + 1);
		if (afterHost !== "" && !afterHost.startsWith(":")) return false;
		hostname = hostAndPort.slice(open + 1, close === -1 ? undefined : close);
	} else {
		const colon = hostAndPort.indexOf(":");
		hostname = colon === -1 ? hostAndPort : hostAndPort.slice(0, colon);
	}
	if (hostname.startsWith("v")) {
		const dot = hostname.indexOf(".");
		return (
			dot > 1 &&
			[...hostname.slice(1, dot)].every(isHexDigit) &&
			dot < hostname.length - 1
		);
	}
	return isIpv6Literal(hostname);
}

/**
 * Whether `_checknetloc` accepts a netloc: one that is ASCII, or whose
 * NFKC form (without its own `@`, `:`, `#` and `?`) either is unchanged or
 * gains none of `/`, `?`, `#`, `@` and `:`.
 */
function acceptsNetlocCharacters(netloc: string): boolean {
	if ([...netloc].every((char) => char.charCodeAt(0) < 0x80)) return true;
	const bare = netloc.replace(/[@:#?]/g, "");
	const normalized = bare.normalize("NFKC");
	return (
		bare === normalized ||
		![..."/?#@:"].some((char) => normalized.includes(char))
	);
}

/**
 * What HQ's build keeps of a stored `custom_base_url` in the URLs it joins
 * onto it, as its scheme and netloc, or null where it keeps no address.
 *
 * `ApplicationBase.url_base` is the stored value where it is non-empty, and
 * `absolute_url_property` joins it with a path from the root
 * (`urljoin(url_base, "/a/…")`), which keeps the base's scheme, lower-cased,
 * and its netloc exactly as written (credentials, the host's own letters, an
 * explicit default port) and drops its path, query and fragment. This reads
 * the value as `urllib.parse.urlsplit` does: leading C0 controls and spaces
 * stripped, tabs and line breaks removed, a scheme of Python's scheme
 * characters before the first colon, and a netloc after `//` up to the
 * first `/`, `?` or `#`. Only an `http` or `https` base with a netloc
 * `urlsplit` accepts gives an address: any other base joins to a URL a
 * phone does not reach (a path alone, `https:///a/…`) or makes HQ's build
 * raise, so it names no address a phone is sent to.
 */
function hqUrlBase(
	value: unknown,
): { readonly scheme: "http" | "https"; readonly netloc: string } | null {
	if (typeof value !== "string" || value === "") return null;
	let start = 0;
	while (start < value.length && value.charCodeAt(start) <= 0x20) start++;
	const url = value.slice(start).replace(/[\t\r\n]/g, "");
	const colon = url.indexOf(":");
	if (colon <= 0 || !isAsciiLetter(url[0])) return null;
	const schemeText = url.slice(0, colon);
	if (![...schemeText].every((char) => SCHEME_CHARS.has(char))) return null;
	const scheme = schemeText.toLowerCase();
	if (scheme !== "http" && scheme !== "https") return null;
	const rest = url.slice(colon + 1);
	if (!rest.startsWith("//")) return null;
	let end = rest.length;
	for (const delimiter of ["/", "?", "#"]) {
		const at = rest.indexOf(delimiter, 2);
		if (at !== -1) end = Math.min(end, at);
	}
	const netloc = rest.slice(2, end);
	if (netloc === "") return null;
	if (
		(netloc.includes("[") || netloc.includes("]")) &&
		!acceptsBracketedNetloc(netloc)
	) {
		return null;
	}
	if (!acceptsNetlocCharacters(netloc)) return null;
	return { scheme, netloc };
}

/**
 * What a person reads of a stored `custom_base_url`, and its origin where it
 * is one a server could be at (`HeldBaseUrl`). The host is the netloc after
 * its last `@`, as `urlsplit` reads it, so no user information is kept.
 */
function heldBaseUrl(value: unknown): HeldBaseUrl | null {
	const base = hqUrlBase(value);
	if (base === null) return null;
	const at = base.netloc.lastIndexOf("@");
	const host = base.netloc.slice(at + 1);
	let origin: string | null = null;
	if (base.scheme === "https" && at === -1) {
		try {
			origin = new URL(`https://${host}/`).origin;
		} catch {
			origin = null;
		}
	}
	return { host, origin };
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
	/* A value XML cannot carry would make every `.ccz` of the deployment
	 * throw at the profile's serializer, so it is left out and said. */
	let profileNotCarried = false;
	const xmlCarried = (text: string | null): string | null => {
		if (text === null || xmlTextIssue(text) === undefined) return text;
		profileNotCarried = true;
		return null;
	};
	const profileProperties: Partial<Record<KeptProfilePropertyKey, string>> = {};
	for (const key of KEPT_PROFILE_PROPERTY_KEYS) {
		const text = xmlCarried(hqProfileValueText(properties[key]));
		if (text !== null) profileProperties[key] = text;
	}
	const credentialLevel = xmlCarried(
		hqProfileValueText(objectAt(profile, "features").credentials),
	);

	const langs = sourceLanguages(source);
	const translations = objectAt(source, "translations");
	/* Keys are CommCare HQ's stored text, so every record is built with
	 * `Object.fromEntries`, which defines each key as its own: an assignment
	 * would read a key such as `__proto__` as the object's prototype. */
	/* A text is carried only where the archive's line reads back as it: under
	 * a key that is one locale record of its own name, so the key a device
	 * reads is the one `translationKeyOwner` judged, and with a text that is
	 * one record (no carriage return, which would end the line there, and not
	 * only control characters, which leave it defining nothing). HQ's build writes every
	 * non-empty value whatever its key, so a text left out is said. */
	const langCodes: ReadonlySet<string> = new Set(langs);
	const uiTextEntries: [string, Record<string, string>][] = [];
	const uiTextKeys = new Set<string>();
	const uiTextNotCarried = new Set<string>();
	for (const [lang, table] of Object.entries(translations)) {
		if (!isObject(table)) continue;
		const texts: [string, string][] = [];
		for (const [key, value] of Object.entries(table)) {
			const written = typeof value === "string" && value !== "";
			if (!isLocaleFileKey(key)) {
				if (written) uiTextNotCarried.add(lang);
				continue;
			}
			if (translationKeyOwner(key, langCodes) !== "target") continue;
			if (isRuntimeUiStringKey(key)) uiTextKeys.add(key);
			if (!written) continue;
			if (!isLocaleFileValue(value)) {
				uiTextNotCarried.add(lang);
				continue;
			}
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
		for (const lang of langCodes) {
			if (!Object.hasOwn(translations, lang)) continue;
			const table = translations[lang];
			if (!isObject(table)) continue;
			const names: [string, string][] = [];
			for (const code of langCodes) {
				const name = Object.hasOwn(table, code) ? table[code] : undefined;
				if (typeof name === "string" && name !== "" && isLocaleFileValue(name))
					names.push([code, name]);
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
		profileNotCarried,
		uiText,
		uiTextKeys: [...uiTextKeys].sort(),
		uiTextNotCarried: [...uiTextNotCarried].sort(),
		secureSubmissions: source.secure_submissions === true,
		customBaseUrl: heldBaseUrl(source.custom_base_url),
		autoGpsCapture: source.auto_gps_capture === true,
		novaOwnsAutoGpsCapture: input.novaOwnsAutoGpsCapture,
		androidLogos,
		practiceWorker: typeof practiceWorker === "string" && practiceWorker !== "",
		persistentMenu: source.persistent_menu === true,
		breadcrumbs: source.show_breadcrumbs !== false,
		mobileReportVersion:
			typeof mobileReportVersion === "string" ? mobileReportVersion : "2.0",
		credentialLevel,
		languageNames,
	};
}
