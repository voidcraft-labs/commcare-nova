/**
 * A `.ccz` made for a project space writes what that project space keeps,
 * read through an independent consumer: the archive is unzipped, its
 * `profile.ccpr` and a form are parsed as XML, and each `app_strings.txt` is
 * read as Core's `LocalizationUtils.parseLocaleInput` reads a locale file.
 *
 * The failures it catches: a kept setting, the secure receiver, a custom
 * base URL, the worker activity credential, location capture, a runtime UI
 * text or a language name CommCare HQ holds that the archive drops or writes
 * at Nova's value; a text HQ holds that the archive spells so Core reads
 * another; an archive that changes where no project space was read, or
 * where the project space holds exactly what Nova's publish wrote; and a
 * publish and an archive that state two profiles for one project space.
 */

import { readFileSync } from "node:fs";
import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { appProfileProperties } from "../appProfileSettings";
import { compileCcz } from "../compiler";
import { derivedProfileProperties } from "../derivedProfile";
import { expandDoc } from "../expander";
import { targetProfileProperties } from "../keptProfile";
import { commCareLocalization } from "../localization";
import {
	hqProfileValueText,
	KEPT_PROFILE_PROPERTY_KEYS,
	type TargetFacts,
	targetFactsFromSource,
} from "../targetFacts";
import { projectProfileForTarget } from "../targetOverlay";
import type { HqApplicationProfile } from "../types";
import {
	USERCASE_MISSING_LOCALE_ID,
	USERCASE_MISSING_MESSAGE,
} from "../usercaseWire";
import { parseXml } from "../xmlParse";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { usercaseWriteFixture } from "./usercaseWriteFixture";

/** A survey that writes the worker's record, in English and French. */
function bilingualDoc(): BlueprintDoc {
	const doc = usercaseWriteFixture("survey");
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "fra"],
		wireCodes: { eng: "en", fra: "fra" },
		translations: {},
	};
	return doc;
}

function compiled(
	doc: BlueprintDoc,
	targetFacts?: TargetFacts | null,
): ReadonlyMap<string, Buffer> {
	const zip = new AdmZip(
		compileCcz(expandDoc(doc), doc.appName, doc, {
			runtimeTarget: TEST_RUNTIME_TARGET,
			...(targetFacts !== undefined && { targetFacts }),
		}),
	);
	return new Map(
		zip
			.getEntries()
			.filter((entry) => !entry.isDirectory)
			.map((entry) => [entry.entryName, entry.getData()]),
	);
}

function text(files: ReadonlyMap<string, Buffer>, path: string): string {
	const bytes = files.get(path);
	if (bytes === undefined) throw new Error(`The archive holds no ${path}.`);
	return bytes.toString("utf8");
}

function elements(parent: { children: readonly unknown[] }): Element[] {
	return parent.children.filter((child): child is Element =>
		isTag(child as Element),
	);
}

function only(found: readonly Element[], name: string): Element {
	const matching = found.filter((element) => element.name === name);
	if (matching.length !== 1 || matching[0] === undefined) {
		throw new Error(`Expected one ${name}, found ${matching.length}.`);
	}
	return matching[0];
}

/** Java's `String.trim`: every code unit at or below U+0020 at either end. */
function javaTrim(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
	while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
	return value.slice(start, end);
}

/** A locale file as `LocalizationUtils.parseLocaleInput` reads it, line by line. */
function readLocaleFile(source: string): ReadonlyMap<string, string> {
	const table = new Map<string, string>();
	for (const raw of source.split(/\r\n|\r|\n/)) {
		let line = javaTrim(raw);
		let end = line.length;
		for (;;) {
			const at = line.slice(0, end).lastIndexOf("#");
			if (at === -1) break;
			if (at === 0 || line[at - 1] !== "\\") {
				line = line.slice(0, at);
				end = line.length;
			} else {
				end = at;
			}
		}
		const equals = line.indexOf("=");
		if (equals === -1 || equals === line.length - 1) continue;
		table.set(
			line.slice(0, equals),
			line
				.slice(equals + 1)
				.replaceAll("\\#", "#")
				.replaceAll("\\n", "\n"),
		);
	}
	return table;
}

const READ = {
	observedAt: "2026-11-01T00:00:00.000Z",
	novaOwnsAutoGpsCapture: false,
} as const;

/** A project space's source holding a value for each kept value an archive mirrors. */
const KEPT_SOURCE = {
	langs: ["en", "fra"],
	secure_submissions: true,
	custom_base_url: "https://example.org/hq/",
	auto_gps_capture: true,
	profile: {
		properties: {
			"cc-autoup-freq": "freq-daily",
			"cc-maps-default-layer": "satellite",
			"cc-gps-auto-capture-accuracy": 20,
			"cc-log-entity-detail-enabled": true,
		},
		features: { credentials: "3MON_ACTIVE" },
	},
	translations: {
		en: {
			en: "English, as typed",
			"home.start": "Begin a visit",
			/* Blank to Python's `strip`, though not to JavaScript's `trim`. */
			"home.sync": " \u001c　",
			[USERCASE_MISSING_LOCALE_ID]: "Ask your supervisor # for a record",
		},
		fra: {
			fra: "Français",
			"home.start": "Commencer\nune visite",
			/* Held in French alone: no catalog of CommCare HQ holds it. */
			"custom.greeting": "Bonjour",
			/* Held in French alone, and English's catalog holds it. */
			"home.logout": "Se déconnecter",
		},
	},
};

function keptFacts(adopted: boolean): TargetFacts {
	const facts = targetFactsFromSource(KEPT_SOURCE, { ...READ, adopted });
	if (facts === null) throw new Error("The kept source is an object.");
	return facts;
}

describe("a CCZ made for a project space that keeps values", () => {
	const doc = bilingualDoc();
	const files = compiled(doc, keptFacts(true));
	const profile = parseXml(text(files, "profile.ccpr"));
	const root = only(elements(profile), "profile");
	const properties = new Map(
		elements(root)
			.filter((element) => element.name === "property")
			.map((element) => [element.attribs.key, element.attribs]),
	);

	it("writes each kept setting at the project space's value and the log setting forced", () => {
		expect(properties.get("cc-autoup-freq")).toEqual({
			key: "cc-autoup-freq",
			value: "freq-daily",
			force: "true",
		});
		expect(properties.get("cc-maps-default-layer")).toEqual({
			key: "cc-maps-default-layer",
			value: "satellite",
		});
		expect(properties.get("cc-gps-auto-capture-accuracy")?.value).toBe("20");
		/* The app was brought in, so a seeded setting the project space
		 * holds no value for stays absent, as it does in HQ's build. */
		expect(properties.has("cc-enable-tts")).toBe(false);
		expect(properties.get("cc-log-entity-detail-enabled")).toEqual({
			key: "cc-log-entity-detail-enabled",
			value: "True",
			force: "true",
		});
	});

	it("sends forms to the secure receiver on the custom base URL's origin", () => {
		expect(properties.get("PostURL")?.value).toBe(
			"https://example.org/a/nova-test/receiver/secure/nova-test-app/",
		);
		expect(properties.get("ota-restore-url")?.value).toBe(
			"https://example.org/a/nova-test/phone/restore/nova-test-app/",
		);
		expect(properties.get("key_server")?.value).toBe(
			"https://example.org/a/nova-test/phone/keys/",
		);
		expect(properties.get("cc_user_domain")?.value).toBe(
			"nova-test.commcarehq.org",
		);
	});

	it("writes the worker activity credential as the last child of features", () => {
		const features = elements(only(elements(root), "features"));
		expect(features.map((element) => element.name)).toEqual([
			"checkoff",
			"users",
			"credentials",
		]);
		const credentials = only(features, "credentials");
		expect(credentials.attribs).toEqual({ active: "true" });
		expect(
			elements(credentials).map((element) => [element.name, element.attribs]),
		).toEqual([["credential", { level: "3MON_ACTIVE", type: "APP_ACTIVITY" }]]);
	});

	it("captures location with every form", () => {
		const html = only(
			elements(parseXml(text(files, "modules-0/forms-0.xml"))),
			"h:html",
		);
		const model = only(elements(only(elements(html), "h:head")), "model");
		const data = only(
			elements(
				only(
					elements(model).filter(
						(element) =>
							element.name === "instance" && element.attribs.src === undefined,
					),
					"instance",
				),
			),
			"data",
		);
		expect(elements(only(elements(data), "orx:meta")).at(-1)?.name).toBe(
			"cc:location",
		);
		expect(
			elements(model)
				.slice(-2)
				.map((element) => [element.name, element.attribs]),
		).toEqual([
			["orx:pollsensor", { event: "xforms-ready", ref: "/data/meta/location" }],
			["bind", { nodeset: "/data/meta/location", type: "geopoint" }],
		]);
	});

	it("writes each language's UI text and held names, and default as HQ's build merges it", () => {
		const tables = Object.fromEntries(
			["default", "en", "fra"].map((dir) => [
				dir,
				readLocaleFile(text(files, `${dir}/app_strings.txt`)),
			]),
		);
		for (const dir of ["default", "en"]) {
			expect(tables[dir]?.get("home.start")).toBe("Begin a visit");
			/* The project space's text in place of Nova's own message. */
			expect(tables[dir]?.get(USERCASE_MISSING_LOCALE_ID)).toBe(
				"Ask your supervisor # for a record",
			);
			/* HQ's build writes a blank text as one non-breaking space. */
			expect(tables[dir]?.get("home.sync")).toBe(" ");
			expect(tables[dir]?.get("en")).toBe("English, as typed");
			expect(tables[dir]?.get("lang.current")).toBe("en");
		}
		/* HQ's default table takes a later language's text where the first
		 * language holds none and its catalog none either; where English's
		 * catalog holds the key, HQ writes English's catalog text, which an
		 * archive cannot carry, so the phone's own wording stands. */
		expect(tables.default?.get("custom.greeting")).toBe("Bonjour");
		expect(tables.en?.has("custom.greeting")).toBe(false);
		expect(tables.default?.has("home.logout")).toBe(false);
		expect(tables.en?.has("home.logout")).toBe(false);
		expect(tables.fra?.get("home.logout")).toBe("Se déconnecter");
		expect(tables.fra?.get("home.start")).toBe("Commencer\nune visite");
		expect(tables.fra?.get("fra")).toBe("Français");
		expect(tables.fra?.get("lang.current")).toBe("fra");
		/* French holds no name for English, so the archive writes Nova's. */
		const novaFrench = readLocaleFile(
			text(compiled(doc, null), "fra/app_strings.txt"),
		);
		expect(tables.fra?.get("en")).toBe(novaFrench.get("en"));
		/* No French text for this key: the archive keeps Nova's message. */
		expect(tables.fra?.get(USERCASE_MISSING_LOCALE_ID)).toBe(
			novaFrench.get(USERCASE_MISSING_LOCALE_ID),
		);
	});

	it("writes Nova's seeds and labels where Nova created the HQ app", () => {
		const createdFiles = compiled(doc, keptFacts(false));
		const seeded = new Map(
			elements(
				only(elements(parseXml(text(createdFiles, "profile.ccpr"))), "profile"),
			)
				.filter((element) => element.name === "property")
				.map((element) => [element.attribs.key, element.attribs.value]),
		);
		expect(seeded.get("cc-enable-tts")).toBe("no");
		expect(seeded.get("cc-autoup-freq")).toBe("freq-daily");
		const created = readLocaleFile(text(createdFiles, "en/app_strings.txt"));
		expect(created.get("en")).toBe(
			readLocaleFile(text(compiled(doc, null), "en/app_strings.txt")).get("en"),
		);
		expect(created.get("en")).not.toBe("English, as typed");
		expect(created.get("home.start")).toBe("Begin a visit");
	});
});

/**
 * `bilingualDoc`'s profile and string tables, as the compiler wrote them
 * before it read any project space: retained bytes, not output of the code
 * under test. (Its form's namespace comes from an id the fixture helper
 * counts up for each document it builds, so the form's own test reads its
 * structure.)
 */
const RETAINED_ARCHIVE = "./fixtures/ccz-without-project-space/";
const RETAINED_ARCHIVE_FILES = [
	"profile.ccpr",
	"default/app_strings.txt",
	"en/app_strings.txt",
	"fra/app_strings.txt",
] as const;

describe("a CCZ with no project space read", () => {
	it("is byte for byte the archive Nova wrote before it read a project space", () => {
		const doc = bilingualDoc();
		for (const facts of [null, undefined]) {
			const files = compiled(doc, facts);
			for (const path of RETAINED_ARCHIVE_FILES) {
				expect(files.get(path), path).toEqual(
					readFileSync(new URL(`${RETAINED_ARCHIVE}${path}`, import.meta.url)),
				);
			}
		}
	});

	it("writes Nova's own profile, receiver, features, form and text", () => {
		const doc = bilingualDoc();
		const files = compiled(doc, null);
		const root = only(
			elements(parseXml(text(files, "profile.ccpr"))),
			"profile",
		);
		expect(
			elements(root)
				.filter((element) => element.name === "property")
				.map((element) => element.attribs),
		).toEqual([
			{ key: "CommCare App Name", value: doc.appName },
			{ key: "cc-content-version", value: "1" },
			{ key: "cc-app-version", value: "1" },
			{
				key: "ota-restore-url",
				value:
					"https://www.commcarehq.org/a/nova-test/phone/restore/nova-test-app/",
				force: "true",
			},
			{
				key: "PostURL",
				value: "https://www.commcarehq.org/a/nova-test/receiver/nova-test-app/",
				force: "true",
			},
			{
				key: "key_server",
				value: "https://www.commcarehq.org/a/nova-test/phone/keys/",
				force: "true",
			},
			{
				key: "cc_user_domain",
				value: "nova-test.commcarehq.org",
				force: "true",
			},
			{ key: "cur_locale", value: "en", force: "false" },
			...appProfileProperties(doc).map(({ key, value, force }) => ({
				key,
				value,
				...(force && { force: "true" }),
			})),
			...Object.entries(derivedProfileProperties(doc)).map(([key, value]) => ({
				key,
				value,
				force: "true",
			})),
		]);
		expect(
			elements(only(elements(root), "features")).map((element) => [
				element.name,
				element.attribs,
			]),
		).toEqual([
			["checkoff", { active: "true" }],
			["users", { active: "true" }],
		]);

		const html = only(
			elements(parseXml(text(files, "modules-0/forms-0.xml"))),
			"h:html",
		);
		const model = only(elements(only(elements(html), "h:head")), "model");
		const data = only(
			elements(
				only(
					elements(model).filter(
						(element) =>
							element.name === "instance" && element.attribs.src === undefined,
					),
					"instance",
				),
			),
			"data",
		);
		expect(
			elements(only(elements(data), "orx:meta")).map((element) => element.name),
		).not.toContain("cc:location");
		expect(elements(model).map((element) => element.name)).not.toContain(
			"orx:pollsensor",
		);

		const localization = commCareLocalization(doc);
		for (const [dir, language] of [
			["default", "en"],
			["en", "en"],
			["fra", "fra"],
		] as const) {
			const table = readLocaleFile(text(files, `${dir}/app_strings.txt`));
			expect(table.get(USERCASE_MISSING_LOCALE_ID)).toBe(
				USERCASE_MISSING_MESSAGE,
			);
			expect(table.has("home.start")).toBe(false);
			expect(table.get("en")).toBe(localization.languageName("en"));
			expect(table.get("fra")).toBe(localization.languageName("fra"));
			expect(table.get("lang.current")).toBe(language);
		}
	});

	it("is unchanged by a project space that holds exactly what Nova's publish wrote", () => {
		const doc = bilingualDoc();
		const app = expandDoc(doc);
		const facts = targetFactsFromSource(app, { ...READ, adopted: false });
		expect(facts).not.toBeNull();
		expect(compiled(doc, facts)).toEqual(compiled(doc, null));
	});
});

/** Each seeded setting's own choices (`commcare-profile-settings.yml`). */
const CHOICES: Readonly<Record<string, readonly string[]>> = {
	"cc-fuzzy-search-enabled": ["yes", "no"],
	"cc-gps-auto-capture-accuracy": ["5", "10", "20", "40", "80"],
	"cc-content-valid": ["yes", "no"],
	"cc-autoup-freq": ["freq-never", "freq-daily", "freq-weekly"],
	"cc-enable-tts": ["yes", "no"],
	"cc-autosync-freq": ["freq-never", "freq-daily", "freq-weekly"],
	"cc-days-form-retain": ["1", "7", "31", "92", "365", "-1"],
	"cc-inflation-target-density": [
		"120",
		"160",
		"240",
		"320",
		"480",
		"640",
		"none",
	],
	"cc-label-required-questions-with-asterisk": ["yes", "no"],
	"cc-login-duration-seconds": [
		"86400",
		"43200",
		"28800",
		"7200",
		"3600",
		"1800",
		"900",
	],
	"cc-maps-default-layer": ["normal", "satellite", "terrain", "hybrid"],
	"cc-resize-images": ["full", "half", "width", "none"],
	logenabled: ["Enabled", "Disabled"],
	"unsent-number-limit": ["5", "10", "20", "40", "80", "160"],
	"unsent-time-limit": ["-1", "1", "5", "7", "14", "30"],
};

/**
 * A stored setting: one of its choices, a value HQ's build writes as text of
 * its own (`True`, a number), or a value it writes nothing for.
 */
const storedSetting = (key: string) =>
	fc.option(
		fc.oneof(
			fc.constantFrom<unknown>(...(CHOICES[key] ?? [])),
			fc.constantFrom<unknown>(true, 10),
			fc.constantFrom<unknown>("", null, false, 0, ["yes"], {}),
		),
		{ nil: undefined },
	);

describe("a publish and the archive for one project space", () => {
	it("state the same seventeen settings", () => {
		expect(Object.keys(CHOICES)).toEqual(
			KEPT_PROFILE_PROPERTY_KEYS.slice(0, 15),
		);
		const doc = bilingualDoc();
		const app = expandDoc(doc);
		fc.assert(
			fc.property(
				fc.record(
					Object.fromEntries(
						Object.keys(CHOICES).map((key) => [key, storedSetting(key)]),
					),
				),
				fc.boolean(),
				fc.boolean(),
				(drawn, showSaved, showIncomplete) => {
					const properties = Object.fromEntries(
						Object.entries(drawn).filter(([, value]) => value !== undefined),
					);
					const held: HqApplicationProfile = {
						properties: {
							...properties,
							"cc-show-saved": showSaved ? "yes" : "no",
							"cc-show-incomplete": showIncomplete ? "yes" : "no",
						},
					};
					const published =
						projectProfileForTarget(app, held, "not-needed") ?? held;
					const facts = targetFactsFromSource(
						{ profile: published },
						{ ...READ, adopted: false },
					);
					const archived = targetProfileProperties(doc, facts).filter(
						({ key }) => key !== "cc-log-entity-detail-enabled",
					);
					expect(archived).toHaveLength(17);
					/* What HQ's build of the published profile writes for each key. */
					const stated = published.properties as Record<string, unknown>;
					for (const { key, value } of archived) {
						expect(hqProfileValueText(stated[key]), key).toBe(value);
					}
				},
			),
		);
	});
});
