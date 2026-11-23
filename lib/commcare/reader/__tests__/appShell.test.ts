/**
 * The application walker over CommCare HQ's own answers: an app HQ made
 * (`shell`), the same after a save of its settings page, an app HQ built
 * with menus of every kind (`hq-built`) and one after a save of its UI
 * translations page, each read through Nova's reader of HQ's source view.
 * Each key HQ's own pages write must be claimed at the app, under the entry
 * whose value class takes the value. Over sources a test changed: a logo
 * entry the uploader did not write, the Web Apps logo, and a language's
 * name that differs from Nova's label.
 *
 * It would catch an `Application` key left unclaimed, a setting accounted
 * under the wrong value class, a custom profile property Nova derives read
 * as a finding (or another one read past), a root key naming a read-only
 * member refused under the read-only entry where its setting has an entry of
 * its own (or under that entry where it has none), a logo entry with no `m_id`
 * admitted, a slot of another name the uploader wrote refused, one node of
 * `logo_refs` both handed off and claimed, a refusal of a profile setting or a
 * logo slot recorded anywhere but where the key it names sits (the lane's
 * parity joins the two there), and a display name raised as a
 * finding where the manifest keeps it (or kept where the manifest refuses
 * it), a first-language `app.display.name` other than `name` taken as the
 * source where a later language stores none, a source-language one HQ's build
 * shows over `name` left unrecognized or read without the other languages'
 * translation of `name`, and a key of a language the reading could not name held instead of covered
 * by that language's finding.
 */

import { describe, expect, it } from "vitest";
import { makeTranslationUnitId } from "@/lib/domain";
import { resolvedLanguageDisplayLabel } from "@/lib/domain/languageRegistry/names";
import { inventoryIndex } from "../../surface/inventory";
import { readHqApp } from "..";
import { readApplication } from "../appShell";
import { readStructure } from "../structure";
import {
	closeAfterStructure,
	entriesAt,
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "./readerInput";

const A = "application-and-settings";
const APP_PLACES = new Set(["app", "app-settings", "languages"]);

/** The two stages that claim an app's root keys and its menus' own keys, and the forms stage's
 *  one read of the walker's: each form's source. */
async function readShell(body: Readonly<Record<string, unknown>>) {
	const ctx = readContext(readerInput(await sourceFromBody(body)));
	readApplication(ctx);
	readStructure(ctx);
	return { ctx, closed: closeAfterStructure(ctx) };
}

it("brings in both app layouts and retains a menu's individual choice through a change of policy", async () => {
	const base = retainedSourceBody("navigation-base/app-source");
	const modules = base.modules as Record<string, unknown>[];
	for (const [policy, layout] of [
		["some", "individual"],
		["all", "grid"],
		["none", undefined],
	] as const) {
		const body = {
			...base,
			use_grid_menus: true,
			grid_form_menus: policy,
			modules: modules.map((module, index) =>
				index === 0 ? { ...module, display_style: "grid" } : module,
			),
		};
		const outcome = await readHqApp({
			...readerInput(await sourceFromBody(body)),
			recordDialect: () => undefined,
		});
		if (outcome.kind !== "read")
			throw new Error(JSON.stringify(outcome.findings));
		expect(outcome.draft.doc.appSettings.firstMenuLayout).toBe("grid");
		expect(outcome.draft.doc.appSettings.formMenuLayout).toBe(layout);
		expect(
			outcome.draft.doc.modules[outcome.draft.doc.moduleOrder[0]].menuLayout,
		).toBe("grid");
	}
});

describe("readApplication over CommCare HQ's own apps", () => {
	it.each([
		"shell/app-source",
		"shell/app-source-after-app-settings-save",
		"hq-built/app-source",
		"navigation-base/app-source-after-ui-translations-save",
	])("claims every key of %s at the app", async (file) => {
		const { closed } = await readShell(retainedSourceBody(file));
		expect(
			closed.findings.filter((finding) => APP_PLACES.has(finding.place.kind)),
		).toEqual([]);
		expect(
			closed.defects.filter((defect) => APP_PLACES.has(defect.place.kind)),
		).toEqual([]);
	});

	it("accounts each setting HQ's settings page saves under the entry of its value", async () => {
		const { ctx, closed } = await readShell(
			retainedSourceBody("shell/app-source-after-app-settings-save"),
		);
		expect(entriesAt(closed, "/build_spec")).toEqual([
			`${A}/34-hq-build-spec-at-or-above-nova-s-floor-2-57`,
		]);
		expect(entriesAt(closed, "/profile/properties/cc-autoup-freq")).toEqual([
			`${A}/1-properties-cc-autoup-freq`,
		]);
		expect(entriesAt(closed, "/profile/properties/purge-freq")).toEqual([
			`${A}/3-properties-purge-freq`,
		]);
		expect(entriesAt(closed, "/profile/properties/cc-show-saved")).toEqual([
			`${A}/20-properties-cc-show-saved`,
		]);
		expect(entriesAt(closed, "/profile/features/users")).toEqual([
			`${A}/15-features-users`,
		]);
		/* A language's key is claimed under `translations`, recorded where that key's value sits. */
		expect(entriesAt(closed, "/translations/en/en")).toEqual([]);
		expect(entriesAt(closed, "/translations")).toContain(
			`${A}/translations-lang-code-language-display-names-equal-to-the-label`,
		);
		expect(ctx.draft.appSettings).toEqual({
			showSavedForms: false,
			showIncompleteForms: false,
		});
		expect(ctx.draft.localization).toBeUndefined();
		expect(ctx.draft.appName?.value).toBe("Patients & visits <Café>");
	});

	it("reads a setting outside its choices as that setting's refusal, at the app", async () => {
		const body = retainedSourceBody("shell/app-source-after-app-settings-save");
		const profile = body.profile as {
			properties: Record<string, string>;
		};
		const { closed } = await readShell({
			...body,
			profile: {
				...profile,
				properties: {
					...profile.properties,
					"cc-autoup-freq": "freq-hourly",
					"cc-show-saved": "yes",
				},
			},
		});
		expect(entriesAt(closed, "/profile/properties/cc-autoup-freq")).toEqual([
			`${A}/profile-properties-or-features-dependencies-value-outside-its`,
		]);
		expect(
			closed.findings.filter((finding) => APP_PLACES.has(finding.place.kind)),
		).toMatchObject([
			{
				code: `${A}/profile-properties-or-features-dependencies-value-outside-its`,
				place: { kind: "app" },
				detail: { name: "cc-autoup-freq" },
			},
		]);
	});

	it("accounts each value of a setting two entries name under the entry whose class is the value", async () => {
		const body = retainedSourceBody("shell/app-source");
		const profile = (body.profile ?? {}) as {
			properties?: Record<string, string>;
		};
		for (const [value, entry] of [
			["true", `${A}/2-properties-lazy-load-video-files-true`],
			["false", `${A}/2p-properties-lazy-load-video-files-false`],
		] as const) {
			const { closed } = await readShell({
				...body,
				profile: {
					...profile,
					properties: {
						...profile.properties,
						"lazy-load-video-files": value,
					},
				},
			});
			expect(
				entriesAt(closed, "/profile/properties/lazy-load-video-files"),
			).toEqual([entry]);
		}
	});

	it("reads past the custom property Nova derives and refuses any other, by its name", async () => {
		const body = retainedSourceBody("shell/app-source");
		const { closed } = await readShell({
			...body,
			profile: {
				...((body.profile ?? {}) as object),
				custom_properties: {
					"cc-index-case-search-results": "yes",
					"cc-auto-purge": "yes",
				},
			},
		});
		expect(
			entriesAt(
				closed,
				"/profile/custom_properties/cc-index-case-search-results",
			),
		).toEqual([
			`${A}/profile-custom-properties-cc-index-case-search-results-equal-to`,
		]);
		/* The refusal names `schema:Application.profile`, whose value is the whole profile: it is
		 * recorded there, beside the profile's own claim, and nothing is recorded at the property. */
		expect(
			entriesAt(closed, "/profile/custom_properties/cc-auto-purge"),
		).toEqual([]);
		expect(entriesAt(closed, "/profile")).toContain(
			`${A}/profile-custom-properties-any-other-entry-incl-formplayer-keys`,
		);
		expect(
			closed.findings.filter((finding) => APP_PLACES.has(finding.place.kind)),
		).toMatchObject([
			{
				code: `${A}/profile-custom-properties-any-other-entry-incl-formplayer-keys`,
				place: { kind: "app" },
				detail: { name: "cc-auto-purge" },
			},
		]);
	});

	it("records a profile setting refused under the profile's own key at the profile, and its bags there too", async () => {
		const body = retainedSourceBody("shell/app-source-after-app-settings-save");
		const profile = body.profile as {
			features?: Record<string, string>;
		};
		const { closed } = await readShell({
			...body,
			profile: { ...profile, features: { ...profile.features, sense: "true" } },
		});
		const refusal = `${A}/profile-features-sense-true-or-profile-properties-cc-entry-mode`;
		expect(entriesAt(closed, "/profile")).toContain(refusal);
		expect(entriesAt(closed, "/profile/features/sense")).toEqual([]);
		/* Every record naming the profile's key stands where its value sits. */
		expect(
			[...closed.claims.records()]
				.filter((record) => record.key === "schema:Application.profile")
				.map((record) => record.where),
		).toEqual(expect.arrayContaining(["/profile"]));
		expect(
			[...closed.claims.records()].filter(
				(record) =>
					record.key === "schema:Application.profile" &&
					record.where !== "/profile",
			),
		).toEqual([]);
		expect(
			closed.findings.filter((finding) => APP_PLACES.has(finding.place.kind)),
		).toMatchObject([
			{ code: refusal, place: { kind: "app" }, detail: { name: "sense" } },
		]);
	});

	it("refuses a root key naming a read-only member under the entry its setting has, else under the read-only entry, by its name", async () => {
		const body = retainedSourceBody("shell/app-source");
		for (const [name, entry] of [
			["profile_url", `${A}/37-hq-profile-url-on-an-application`],
			[
				"post_url",
				`${A}/an-unknown-top-level-key-naming-an-application-read-only`,
			],
		] as const) {
			const { closed } = await readShell({
				...body,
				[name]: "https://example.org/x",
			});
			expect(entriesAt(closed, `/${name}`)).toEqual([entry]);
			expect(
				closed.findings.filter((finding) => APP_PLACES.has(finding.place.kind)),
			).toMatchObject([
				{
					code: entry,
					standing: "fix-in-hq",
					place: { kind: "app" },
					detail: { name },
				},
			]);
		}
	});

	it("refuses a build below Nova's floor at the app's settings, with the version HQ holds", async () => {
		const body = retainedSourceBody("shell/app-source");
		const { closed } = await readShell({
			...body,
			build_spec: { ...(body.build_spec as object), version: "2.53.0" },
		});
		expect(
			closed.findings.filter((finding) => APP_PLACES.has(finding.place.kind)),
		).toMatchObject([
			{
				code: `${A}/34p-hq-build-spec-below-nova-s-floor`,
				place: { kind: "app-settings" },
				detail: { name: "2.53.0" },
			},
		]);
	});
});

describe("readApplication's logos", () => {
	const ASSET = "0f0e0d0c-0b0a-4908-8706-050403020100";
	const webApps = (entry: Record<string, unknown>) => ({
		...retainedSourceBody("shell/app-source"),
		logo_refs: { hq_logo_web_apps: entry },
	});

	it("refuses a logo entry the uploader did not write: one with no m_id", async () => {
		const { ctx, closed } = await readShell(
			webApps({ path: "jr://file/commcare/logo/data/hq_logo_web_apps.png" }),
		);
		expect(closed.findings).toMatchObject([
			{
				code: `${A}/logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare`,
				detail: { name: "hq_logo_web_apps" },
			},
		]);
		expect(ctx.draft.logo).toBeUndefined();
		expect(ctx.facts.mediaReferences).toEqual([]);
	});

	it("refuses a slot whose path is not the uploader's", async () => {
		const { closed } = await readShell({
			...retainedSourceBody("shell/app-source"),
			logo_refs: {
				hq_logo_android_home: {
					path: "jr://file/commcare/logo/abc.png",
					m_id: "a1",
				},
			},
		});
		expect(closed.findings).toMatchObject([
			{
				code: `${A}/logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare`,
				detail: { name: "hq_logo_android_home" },
			},
		]);
	});

	it("reads the uploader's Web Apps logo into the document, and keeps an Android logo at HQ", async () => {
		const path = "jr://file/commcare/logo/data/hq_logo_web_apps.png";
		const body = {
			...retainedSourceBody("shell/app-source"),
			logo_refs: {
				hq_logo_web_apps: { path, m_id: "m1" },
				hq_logo_android_home: {
					path: "jr://file/commcare/logo/data/hq_logo_android_home.jpg",
					m_id: "m2",
				},
			},
		};
		const ctx = readContext(
			readerInput(await sourceFromBody(body), {
				media: (asked) =>
					asked === path
						? { kind: "asset", assetId: ASSET, mediaKind: "image" }
						: { kind: "no-entry" },
			}),
		);
		readApplication(ctx);
		readStructure(ctx);
		const closed = closeAfterStructure(ctx);
		expect(closed.findings).toEqual([]);
		expect(entriesAt(closed, "/logo_refs")).toEqual([
			`${A}/logo-refs-hq-logo-web-apps`,
		]);
		expect(ctx.draft.logo).toBe(ASSET);
		expect(ctx.facts.mediaReferences).toEqual([
			{
				path,
				assetId: ASSET,
				mediaKind: "image",
				place: { kind: "app-settings" },
				pointer: "/logo_refs/hq_logo_web_apps",
				slot: "app_logo",
			},
		]);
	});

	it("lists the Web Apps logo at the kind its slot plays, a picture, whatever file its path names", async () => {
		const path = "jr://file/commcare/logo/data/hq_logo_web_apps.png";
		const ctx = readContext(
			readerInput(await sourceFromBody(webApps({ path, m_id: "m1" })), {
				media: () => ({ kind: "asset", assetId: ASSET, mediaKind: "video" }),
			}),
		);
		readApplication(ctx);
		expect(ctx.facts.mediaReferences.map((one) => one.mediaKind)).toEqual([
			"image",
		]);
	});

	it("refuses a slot the uploader did not write at `logo_refs`, beside the Android logo kept there", async () => {
		const { closed } = await readShell({
			...retainedSourceBody("shell/app-source"),
			logo_refs: {
				hq_logo_android_home: {
					path: "jr://file/commcare/logo/data/hq_logo_android_home.png",
				},
				hq_logo_android_login: {
					path: "jr://file/commcare/logo/data/hq_logo_android_login.png",
					m_id: "m1",
				},
			},
		});
		expect(entriesAt(closed, "/logo_refs").sort()).toEqual([
			`${A}/logo-refs-hq-logo-android-home-login-demo`,
			`${A}/logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare`,
		]);
		expect(closed.findings).toMatchObject([
			{
				code: `${A}/logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare`,
				place: { kind: "app" },
				detail: { name: "hq_logo_android_home" },
			},
		]);
		expect(closed.defects).toEqual([]);
	});

	it("reads past a slot of another name the uploader wrote, beside an Android logo", async () => {
		const { closed } = await readShell({
			...retainedSourceBody("shell/app-source"),
			logo_refs: {
				hq_logo_android_home: {
					path: "jr://file/commcare/logo/data/hq_logo_android_home.png",
					m_id: "m1",
				},
				hq_logo_x: {
					path: "jr://file/commcare/logo/data/hq_logo_x.png",
					m_id: "m2",
				},
			},
		});
		expect(closed.findings).toEqual([]);
		expect(entriesAt(closed, "/logo_refs")).toEqual([
			`${A}/logo-refs-hq-logo-android-home-login-demo`,
		]);
	});

	it("hands the Web Apps logo with no file to project data and claims the node no more", async () => {
		const path = "jr://file/commcare/logo/data/hq_logo_web_apps.png";
		const { closed } = await readShell({
			...retainedSourceBody("shell/app-source"),
			logo_refs: {
				hq_logo_web_apps: { path, m_id: "m1" },
				hq_logo_android_home: {
					path: "jr://file/commcare/logo/data/hq_logo_android_home.png",
					m_id: "m2",
				},
			},
		});
		expect(closed.defects).toEqual([]);
		expect(entriesAt(closed, "/logo_refs")).toEqual([]);
		expect(closed.claims.handOffs).toMatchObject([
			{ where: "/logo_refs", to: "media-reference", subject: path },
		]);
	});

	it("hands the Web Apps logo to project data where its path has no file", async () => {
		const path = "jr://file/commcare/logo/data/hq_logo_web_apps.png";
		const { ctx, closed } = await readShell(webApps({ path, m_id: "m1" }));
		expect(closed.findings).toEqual([]);
		expect(closed.claims.handOffs).toEqual([
			{
				artifact: "app.json",
				where: "/logo_refs",
				key: "schema:Application.logo_refs",
				to: "media-reference",
				subject: path,
			},
		]);
		expect(ctx.facts.pendingMedia).toMatchObject([
			{ path, resolution: "no-entry", slot: "app_logo" },
		]);
	});
});

describe("readApplication's language names", () => {
	it("makes a finding of a name that differs from Nova's label exactly where the manifest's entry makes one", async () => {
		const body = retainedSourceBody("shell/app-source");
		const { closed } = await readShell({
			...body,
			translations: { en: { en: "Inglés" } },
		});
		const entry = inventoryIndex().entry(
			`${A}/translations-lang-code-any-other-value-or-absent-where-hq-s`,
		);
		const makesFinding =
			entry?.standing === "not-yet" ||
			entry?.standing === "never" ||
			entry?.standing === "fix-in-hq";
		expect(entriesAt(closed, "/translations")).toContain(entry?.id);
		expect(closed.findings.some((finding) => finding.code === entry?.id)).toBe(
			makesFinding,
		);
	});

	it("reads the app's name in another language as its translation", async () => {
		const body = retainedSourceBody("shell/app-source");
		const { ctx, closed } = await readShell({
			...body,
			langs: ["en", "fra"],
			translations: {
				en: { en: "English", fra: "français" },
				fra: { "app.display.name": "Patients et visites" },
			},
		});
		expect(entriesAt(closed, "/translations/fra/app.display.name")).toEqual([
			`${A}/translations-app-display-name`,
		]);
		expect(ctx.translations.units()).toEqual([
			{
				unit: makeTranslationUnitId("app", "name"),
				kind: "text",
				byLanguage: new Map([["fra", "Patients et visites"]]),
			},
		]);
		expect(ctx.draft.localization).toEqual({
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "fra"],
			translations: { fra: {} },
			wireCodes: { eng: "en", fra: "fra" },
		});
	});
});

describe("readApplication's runtime UI text in a language that holds none of its own", () => {
	const KEPT = `${A}/translations-key-in-a-runtime-s-ui-string-catalog-core-android`;
	const FILLED = `${A}/translations-catalog-key-hq-fills-with-its-own-text-in-a`;

	/** English and French, each named by Nova's label, with `strings` over each language's. */
	async function readTexts(
		strings: Readonly<Record<string, Readonly<Record<string, string>>>>,
	) {
		const body = retainedSourceBody("shell/app-source");
		const names = {
			en: resolvedLanguageDisplayLabel({ language: "eng" }) ?? "",
			fra: resolvedLanguageDisplayLabel({ language: "fra" }) ?? "",
		};
		return readShell({
			...body,
			langs: ["en", "fra"],
			translations: {
				en: { ...names, ...strings.en },
				fra: { ...names, ...strings.fra },
			},
		});
	}

	// HQ's build fills a key some language holds from each other language's own catalog
	// (`app_strings.py::SelectKnownAppStrings.app_strings_parts`): English has one
	// (`commcare-translations/messages_en-2.txt`), French none.
	it("keeps the text HQ's catalog gives a language that leaves the key out or blank, at `translations`", async () => {
		const englishes: Readonly<Record<string, string>>[] = [
			{},
			{ "home.sync": "" },
		];
		for (const english of englishes) {
			const { closed } = await readTexts({
				en: english,
				fra: { "home.sync": "Envoyer la tournée" },
			});
			expect(entriesAt(closed, "/translations/fra/home.sync")).toEqual([KEPT]);
			expect(entriesAt(closed, "/translations")).toContain(FILLED);
			expect(closed.findings.filter((one) => one.code === FILLED)).toEqual([]);
		}
	});

	it("claims no fill for a language whose own text stands, or that HQ holds no catalog for", async () => {
		const { closed } = await readTexts({
			en: { "home.sync": "Send the round" },
			fra: {},
		});
		expect(entriesAt(closed, "/translations/en/home.sync")).toEqual([KEPT]);
		expect(entriesAt(closed, "/translations")).not.toContain(FILLED);
	});

	// A key a runtime reads as one of its own UI strings is that item, not data of the map: its
	// claim names the `ui-string:` item, by the key or by the prefix a runtime reads it under, and
	// stands at the key, where the lane's manifest check reads the same item.
	it("keys a runtime UI string's claim by the item it overrides, recorded at the language's key", async () => {
		const { closed } = await readTexts({
			en: {
				"home.sync": "Send the round",
				"android.package.name.org.example.scanner": "Scanner",
			},
			fra: {},
		});
		const at = (where: string) =>
			[...closed.claims.records()]
				.filter((record) => record.where === where)
				.map((record) => [record.key, record.entry, record.standing]);
		expect(at("/translations/en/home.sync")).toEqual([
			["ui-string:home.sync", KEPT, "kept"],
		]);
		expect(
			at("/translations/en/android.package.name.org.example.scanner"),
		).toEqual([["ui-string:android.package.name.*", KEPT, "kept"]]);
		expect(
			[...closed.claims.records()].filter(
				(record) =>
					record.entry === KEPT &&
					record.key === "schema:Application.translations",
			),
		).toEqual([]);
		expect(
			closed.findings.filter((finding) => APP_PLACES.has(finding.place.kind)),
		).toEqual([]);
	});
});

describe("readApplication's app name and the source language it tells", () => {
	/** Two languages, each named by Nova's label, with the first language's strings given. */
	function twoLanguages(first: Readonly<Record<string, string>>) {
		const body = retainedSourceBody("shell/app-source");
		const names = {
			en: resolvedLanguageDisplayLabel({ language: "eng" }) ?? "",
			fra: resolvedLanguageDisplayLabel({ language: "fra" }) ?? "",
		};
		return {
			body: {
				...body,
				langs: ["en", "fra"],
				translations: { en: { ...names, ...first }, fra: names },
			},
			name: body.name as string,
		};
	}

	it("takes the second language as the source where only the first stores an app.display.name other than name", async () => {
		/* Nova writes the source language's name as `name` and `app.display.name` only in a
		 * language whose name differs, so the language holding none is the source, and a
		 * reading in it prints every stored key back. */
		const { body, name } = twoLanguages({ "app.display.name": "Clinic" });
		const { ctx, closed } = await readShell(body);
		expect(
			closed.findings.filter((finding) => APP_PLACES.has(finding.place.kind)),
		).toEqual([]);
		expect(entriesAt(closed, "/translations/en/app.display.name")).toEqual([
			`${A}/translations-app-display-name`,
		]);
		expect(ctx.draft.localization?.sourceLanguage).toBe("fra");
		expect(ctx.draft.localization?.defaultLanguage).toBe("eng");
		expect(ctx.draft.appName?.value).toBe(name);
		expect(ctx.translations.units()).toEqual([
			{
				unit: makeTranslationUnitId("app", "name"),
				kind: "text",
				byLanguage: new Map([["eng", "Clinic"]]),
			},
		]);
		expect(ctx.facts.foldedTranslationKeys).toHaveLength(0);
	});

	it("reads a first-language app.display.name HQ's build shows over name as the app's name where every language stores one", async () => {
		/* HQ's UI translations upload stores such a row in any language, and HQ's build puts
		 * it over `name` there. No language then holds the name as `name`, so the source is the
		 * first, and its value folds into the app's name. */
		const { body } = twoLanguages({ "app.display.name": "Clinic" });
		const { ctx, closed } = await readShell({
			...body,
			translations: {
				...body.translations,
				fra: { ...body.translations.fra, "app.display.name": "Clinique" },
			},
		});
		expect(
			closed.findings.filter((finding) => APP_PLACES.has(finding.place.kind)),
		).toEqual([]);
		expect(entriesAt(closed, "/translations/en/app.display.name")).toEqual([
			`${A}/translations-app-display-name`,
		]);
		expect(ctx.draft.localization?.sourceLanguage).toBe("eng");
		expect(ctx.draft.appName?.value).toBe("Clinic");
		expect(ctx.translations.units()).toEqual([
			{
				unit: makeTranslationUnitId("app", "name"),
				kind: "text",
				byLanguage: new Map([["fra", "Clinique"]]),
			},
		]);
		expect(ctx.facts.foldedTranslationKeys).toHaveLength(1);
	});

	it.each([
		["blank", ""],
		["equal to name", undefined],
	])(
		"reads a first-language app.display.name %s into nothing",
		async (_, given) => {
			const { body, name } = twoLanguages({});
			const { ctx, closed } = await readShell({
				...body,
				translations: {
					...body.translations,
					en: { ...body.translations.en, "app.display.name": given ?? name },
				},
			});
			expect(entriesAt(closed, "/translations/en/app.display.name")).toEqual([
				`${A}/translations-app-display-name`,
			]);
			expect(ctx.draft.appName?.value).toBe(name);
			expect(ctx.translations.units()).toEqual([]);
			expect(ctx.facts.foldedTranslationKeys).toHaveLength(0);
		},
	);
});

describe("readApplication's strings of a language it could not name", () => {
	it("covers every key of the language's strings by the code's finding, and holds none", async () => {
		const cannotName = `${A}/langs-code-nova-s-language-registry-cannot-name`;
		const { ctx, closed } = await readShell({
			...retainedSourceBody("shell/app-source"),
			langs: ["en", "xx"],
			translations: {
				en: { en: resolvedLanguageDisplayLabel({ language: "eng" }) ?? "" },
				xx: {
					"app.display.name": "Clinique",
					"homescreen.title": "Clinique",
					"nova.unread": "OK",
					en: "Anglais",
				},
			},
		});
		for (const key of [
			"app.display.name",
			"homescreen.title",
			"nova.unread",
			"en",
		])
			expect(entriesAt(closed, `/translations/xx/${key}`)).toEqual([
				cannotName,
			]);
		expect(
			closed.findings.filter((finding) => APP_PLACES.has(finding.place.kind)),
		).toMatchObject([
			{
				code: cannotName,
				place: { kind: "languages" },
				detail: { name: "xx" },
			},
		]);
		expect(ctx.translations.units()).toEqual([]);
	});
});
