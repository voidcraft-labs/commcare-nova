/**
 * A menu's or a form's media map read as CommCare HQ's build shows it in each language.
 *
 * Contract: HQ's page stores an icon or an audio label only under the language being edited
 * (`views/media_utils.py::handle_media_edits`), and HQ's build shows a language with no path of
 * its own the path of its `default` table (`models/mixins.py::NavMenuItemMediaMixin`,
 * `app_strings.py::create_default_app_strings`, Core's `Localizer.getLocaleData`). So a map
 * that shows one file in every language reads as that one asset, whichever languages store it,
 * and only a map that shows two files differs by language; a map no app language holds a path
 * in shows nothing (`uses_image` is false), and `use_default_image_for_all` shows the first
 * language's path everywhere.
 *
 * Plausible failures: a map stored in one language refused as differing by language, though
 * every language shows its file; a reading that takes a stored path no language shows; the
 * acceptance comparing the stored map with Nova's map of every language and calling the
 * reading unrecognized.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import type { BlueprintDoc } from "@/lib/domain";
import { effectiveAppLocalization, proseText } from "@/lib/domain";
import { navigationFilesInLanguage } from "@/lib/domain/navigationMedia";
import { manifestFor } from "../../../__tests__/fixtureMediaManifest";
import { localAppStringTable } from "../../../appStrings";
import { expandDoc } from "../../../expander";
import type { AssetManifest } from "../../../multimedia/assetWirePath";
import {
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { readHqApp } from "../../index";
import type { ReaderMediaResolution } from "../../types";
import { shownNavMedia } from "../navMedia";
import { type AppJson, formNamed, inSpanish, moduleNamed } from "./menuReading";

const MENU_ICON = "jr://file/commcare/image/menu.png";
const OTHER_ICON = "jr://file/commcare/image/other.png";
const MENU_ICON_ALIAS = "jr://file/commcare/image/menu-alias.png";
const FORM_AUDIO = "jr://file/commcare/audio/visit.mp3";
const OTHER_AUDIO = "jr://file/commcare/audio/translated.mp3";

const ASSETS: Readonly<Record<string, ReaderMediaResolution>> = {
	[MENU_ICON]: {
		kind: "asset",
		assetId: testMediaAssetId("menu-icon"),
		mediaKind: "image",
	},
	[MENU_ICON_ALIAS]: {
		kind: "asset",
		assetId: testMediaAssetId("menu-icon"),
		mediaKind: "image",
	},
	[OTHER_ICON]: {
		kind: "asset",
		assetId: testMediaAssetId("other-icon"),
		mediaKind: "image",
	},
	[OTHER_AUDIO]: {
		kind: "asset",
		assetId: testMediaAssetId("other-audio"),
		mediaKind: "audio",
	},
	[FORM_AUDIO]: {
		kind: "asset",
		assetId: testMediaAssetId("form-audio"),
		mediaKind: "audio",
	},
};

describe("the path each language shows", () => {
	const langs = ["en", "fr"];
	it.each([
		["a path stored in the first language only", { en: "a" }, "a", "a"],
		["a path stored in the second language only", { fr: "a" }, "a", "a"],
		["a path left blank in the first language", { en: "", fr: "a" }, "a", "a"],
		["a null beside a path", { en: null, fr: "a" }, "a", "a"],
		["the same path in both", { en: "a", fr: "a" }, "a", "a"],
		["two paths", { en: "a", fr: "b" }, "a", "b"],
		// The first language's own blank takes the map's least key in the default table.
		["a blank beside a stale language", { de: "b", en: "", fr: "a" }, "b", "a"],
		// No app language holds a path, so the suite references none.
		["a stale language alone", { de: "a" }, "", ""],
		["an empty map", {}, "", ""],
	])("%s", (_, stored, en, fr) => {
		expect(shownNavMedia(stored, false, langs)).toEqual({ en, fr });
	});

	it("shows the first language's path everywhere under the switch, and nothing where it holds none", () => {
		expect(shownNavMedia({ en: "a", fr: "b" }, true, langs)).toEqual({
			en: "a",
			fr: "a",
		});
		expect(shownNavMedia({ en: "", fr: "b" }, true, langs)).toEqual({
			en: "",
			fr: "",
		});
	});

	it("knows no path for a value HQ's string map never holds", () => {
		expect(shownNavMedia({ en: 5 }, false, langs)).toBeUndefined();
	});
});

/** A two-language app of one menu with one form. */
function app(): BlueprintDoc {
	return inSpanish(
		buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: proseText("Q") })],
						},
					],
				},
			],
		}),
		new Map(),
	);
}

/** `doc` emitted on HQ's shell, `edit` applied as HQ's page stores it, and read back, with the
 *  app strings Nova's build gives the document read beside it, so a generated key is judged. */
async function readWithMedia(
	doc: BlueprintDoc,
	edit: (app: AppJson) => void,
	assets?: AssetManifest,
): Promise<ReturnType<typeof readHqApp>> {
	const emitted = expandDoc(doc, { assets });
	const json = JSON.parse(
		JSON.stringify({
			...retainedSourceBody("shell/app-source"),
			langs: emitted.langs,
			modules: emitted.modules,
			_attachments: emitted._attachments,
		}),
	) as AppJson;
	edit(json);
	const input = readerInput(await sourceFromBody(json), {
		media: (path) => ASSETS[path] ?? { kind: "no-entry" },
	});
	return readHqApp(
		{
			...input,
			recordDialect: recordDialectRoundTrip,
			appStrings: (read) => localAppStringTable(read, []),
		},
		{ claims: "full" },
	);
}

/** The entries the reading accounted each `translations` key under, by key. */
function translationEntries(outcome: ReturnType<typeof readHqApp>): string[] {
	return [...outcome.claims.records()]
		.filter(
			(record) =>
				record.artifact === "app.json" && record.where === "/translations",
		)
		.map((record) => record.entry.slice(record.entry.indexOf("/") + 1));
}

/** HQ's `translations` with `overrides` added in English. */
function overriding(json: AppJson, overrides: Record<string, string>): void {
	const translations = (json.translations ?? {}) as Record<
		string,
		Record<string, string>
	>;
	json.translations = {
		...translations,
		en: { ...(translations.en ?? {}), ...overrides },
	};
}

function findings(outcome: ReturnType<typeof readHqApp>): string[] {
	return outcome.kind === "account"
		? outcome.findings.map((one) =>
				one.code === "unrecognized"
					? `unrecognized:${one.detail.name ?? ""}`
					: one.code,
			)
		: [];
}

describe("a menu's and a form's media read as HQ shows them", () => {
	it("reads a path stored in one language as the one asset every language shows", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			const menu = json.modules[0] as AppJson["modules"][number];
			menu.media_image = { en: MENU_ICON };
			(menu.forms[0] as Record<string, unknown>).media_audio = {
				es: FORM_AUDIO,
			};
		});
		expect(outcome.defects).toEqual([]);
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The app did not read.");
		const read = outcome.draft.doc;
		expect(moduleNamed(read, "Visits").icon).toBe(
			testMediaAssetId("menu-icon"),
		);
		expect(formNamed(read, "Visit").audioLabel).toBe(
			testMediaAssetId("form-audio"),
		);
		// A profile restricted to the other language can show no image. Keeping
		// the sparse dictionary preserves that choice on the original target.
		const mod = moduleNamed(read, "Visits");
		const localization = effectiveAppLocalization(read.localization);
		expect(navigationFilesInLanguage(mod, "spa", localization).icon).toBe(
			testMediaAssetId("menu-icon"),
		);
		expect(
			navigationFilesInLanguage(mod, "spa", localization, ["spa"]).icon,
		).toBeUndefined();
		expect(
			outcome.draft.facts.sameStateRewrites
				.filter((one) => one.register === "media-maps-respelled")
				.map((one) => one.path),
		).toEqual([]);
	});

	it("records no rewrite of a map stored as Nova writes it", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			(json.modules[0] as AppJson["modules"][number]).media_image = {
				en: MENU_ICON,
				es: MENU_ICON,
			};
		});
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The app did not read.");
		expect(
			outcome.draft.facts.sameStateRewrites.filter(
				(one) => one.register === "media-maps-respelled",
			),
		).toEqual([]);
	});

	it("reads a restored-case count in a menu and the worker record in a form from the saved app", async () => {
		const outcome = await readWithMedia(caseListApp(), (json) => {
			const menu = json.modules[1] as AppJson["modules"][number];
			menu.module_filter =
				"count(instance('casedb')/casedb/case[@case_type = 'patient']) > 0";
			menu.forms[0].form_filter = "#user/district = 'north'";
		});
		expect(outcome.defects).toEqual([]);
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The app did not read.");
		expect(
			moduleNamed(outcome.draft.doc, "Patients").displayCondition?.kind,
		).toBe("gt");
		const forms = Object.values(outcome.draft.doc.forms);
		expect(forms.some((form) => form.displayCondition?.kind === "eq")).toBe(
			true,
		);
	});

	it("reads the menu's translated badge and the form's calculation from the same app", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			const menu = json.modules[0] as AppJson["modules"][number];
			menu.custom_icons = [
				{
					doc_type: "CustomIcon",
					form: "badge",
					xpath: null,
					text: { en: "New", es: "Hoy" },
				},
			];
			(menu.forms[0] as Record<string, unknown>).custom_icons = [
				{ doc_type: "CustomIcon", form: "badge", xpath: "4", text: {} },
			];
		});
		expect(outcome.defects).toEqual([]);
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The app did not read.");
		const doc = outcome.draft.doc;
		expect(moduleNamed(doc, "Visits").badge).toEqual({
			kind: "text",
			text: "New",
		});
		expect(formNamed(doc, "Visit").badge).toEqual({
			kind: "calculation",
			expression: { kind: "term", term: { kind: "literal", value: 4 } },
		});
	});

	it("refuses a badge that holds no text in any language and no calculation, as HQ's build writes no text for it", async () => {
		// An empty text map sits at its default, so the refusal is of the icon.
		const outcome = await readWithMedia(app(), (json) => {
			const menu = json.modules[0] as AppJson["modules"][number];
			menu.custom_icons = [
				{ doc_type: "CustomIcon", form: "badge", xpath: null, text: {} },
			];
		});
		expect(outcome.kind).toBe("account");
		expect(JSON.stringify(outcome)).toContain(
			"menus-and-case-lists/badge-missing-localized-text",
		);
	});

	it("reads a list item and its action when their inherited badge fields contain text and an expression", async () => {
		const outcome = await readWithMedia(caseListApp(), (json) => {
			const { item, register } = listBlocks(json);
			item.custom_icons = [{ doc_type: "CustomIcon", text: { en: "Inbox" } }];
			register.custom_icons = [{ doc_type: "CustomIcon", xpath: "3 + 1" }];
		});
		expect(outcome.defects).toEqual([]);
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The app did not read.");
		const patients = moduleNamed(outcome.draft.doc, "Patients");
		expect(patients.caseListMenuItem).toBeDefined();
		expect(patients.caseListRegistrationForm?.kind).toBe("always");
	});

	it("reads the first language's path under the switch, though another stores a second", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			const menu = json.modules[0] as AppJson["modules"][number];
			menu.media_image = { en: MENU_ICON, es: OTHER_ICON };
			menu.use_default_image_for_all = true;
		});
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The app did not read.");
		expect(moduleNamed(outcome.draft.doc, "Visits").icon).toBe(
			testMediaAssetId("menu-icon"),
		);
		expect(
			outcome.draft.facts.sameStateRewrites
				.filter((one) => one.register === "media-maps-respelled")
				.map((one) => one.path),
		).toEqual([
			"/modules/0/media_image",
			"/modules/0/use_default_image_for_all",
		]);
	});

	it("reads a path no app language stores as no media", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			(json.modules[0] as AppJson["modules"][number]).media_image = {
				de: MENU_ICON,
			};
		});
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The app did not read.");
		expect(moduleNamed(outcome.draft.doc, "Visits").icon).toBeUndefined();
	});

	it("keeps a former language that still supplies the full app fallback, but not a named installation", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			const mod = json.modules[0] as AppJson["modules"][number];
			mod.media_image = { de: OTHER_ICON, en: "", es: MENU_ICON };
		});
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The app did not read.");
		const mod = moduleNamed(outcome.draft.doc, "Visits");
		const localization = effectiveAppLocalization(
			outcome.draft.doc.localization,
		);
		expect(navigationFilesInLanguage(mod, "eng", localization).icon).toBe(
			testMediaAssetId("other-icon"),
		);
		expect(
			navigationFilesInLanguage(mod, "eng", localization, ["eng", "spa"]).icon,
		).toBe(testMediaAssetId("menu-icon"));
		expect(
			navigationFilesInLanguage(mod, "eng", localization, ["eng"]).icon,
		).toBeUndefined();
	});

	it("reads distinct files", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			(json.modules[0] as AppJson["modules"][number]).media_image = {
				en: MENU_ICON,
				es: OTHER_ICON,
			};
		});
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The app did not read.");
		const mod = moduleNamed(outcome.draft.doc, "Visits");
		expect(mod.mediaByLanguage?.spa?.icon).toBe(testMediaAssetId("other-icon"));
		expect(mod.icon).toBe(testMediaAssetId("menu-icon"));
	});

	it("reads a map whose file goes to the media plan by the paths it shows", async () => {
		const missing = "jr://file/commcare/image/missing.png";
		const entriesAt = (outcome: ReturnType<typeof readHqApp>, where: string) =>
			[...outcome.claims.records()]
				.filter((one) => one.artifact === "app.json" && one.where === where)
				.map((one) => `${one.key} ${one.entry}`);
		const one = await readWithMedia(app(), (json) => {
			(json.modules[0] as AppJson["modules"][number]).media_image = {
				en: missing,
			};
		});
		expect(entriesAt(one, "/modules/0/media_image")).toEqual([
			"schema:Module.media_image menus-and-case-lists/media-image-media-audio-same-asset-in-every-language",
		]);
		const two = await readWithMedia(app(), (json) => {
			(json.modules[0] as AppJson["modules"][number]).media_image = {
				en: missing,
				es: MENU_ICON,
			};
		});
		expect(entriesAt(two, "/modules/0/media_image")).toEqual([
			"schema:Module.media_image menus-and-case-lists/media-image-media-audio-differing-by-language",
		]);
	});
});

const registerForm = {
	uuid: "reg",
	name: "Register",
	type: "registration" as const,
	fields: [
		f({
			kind: "text",
			id: "name",
			caseWrite: { caseType: "patient", property: "case_name" },
		}),
	],
};

const visitForm = {
	name: "Visit",
	type: "followup" as const,
	fields: [
		f({
			kind: "text",
			id: "notes",
			caseWrite: { caseType: "patient", property: "notes" },
		}),
	],
};

/** A two-language app whose second menu offers a case list menu item and always offers the
 *  first menu's registration on its list (a Register button). */
function caseListApp(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{ name: "Registration", caseType: "patient", forms: [registerForm] },
			{
				name: "Patients",
				caseType: "patient",
				caseListMenuItem: {},
				forms: [visitForm],
			},
		],
	});
	return inSpanish(
		produce(doc, (draft) => {
			const host = Object.values(draft.modules).find(
				(one) => one.name === "Patients",
			);
			if (host !== undefined)
				host.caseListRegistrationForm = {
					kind: "always",
					formUuid: testUuid("reg"),
					afterSubmit: "case-list",
				};
		}),
		new Map(),
	);
}

/** The second menu's case list item and Register blocks of an app's JSON. */
function listBlocks(json: AppJson): {
	readonly item: Record<string, unknown>;
	readonly register: Record<string, unknown>;
} {
	const menu = json.modules[1] as AppJson["modules"][number];
	return {
		item: menu.case_list as Record<string, unknown>,
		register: menu.case_list_form as Record<string, unknown>,
	};
}

describe("a case list menu item's and a Register button's media read as HQ shows them", () => {
	// HQ's menu page sets both switches on both blocks (`views/modules.py` calls
	// `handle_media_edits` with the `case_list-menu_item_` and `case_list_form_` prefixes), and
	// both are `NavMenuItemMediaMixin`s, so the build reads them as a menu's.

	it("reads the first language's path under the switch, though another stores a second", async () => {
		const outcome = await readWithMedia(caseListApp(), (json) => {
			const { item, register } = listBlocks(json);
			item.media_image = { en: MENU_ICON, es: OTHER_ICON };
			item.use_default_image_for_all = true;
			register.media_image = { en: MENU_ICON, es: OTHER_ICON };
			register.use_default_image_for_all = true;
		});
		expect(outcome.defects).toEqual([]);
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The app did not read.");
		const patients = moduleNamed(outcome.draft.doc, "Patients");
		expect(patients.caseListMenuItem?.icon).toBe(testMediaAssetId("menu-icon"));
		const registration = patients.caseListRegistrationForm;
		expect(registration?.kind === "always" && registration.icon).toBe(
			testMediaAssetId("menu-icon"),
		);
		expect(
			outcome.draft.facts.sameStateRewrites
				.filter((one) => one.register === "media-maps-respelled")
				.map((one) => one.path)
				.sort(),
		).toEqual([
			"/modules/1/case_list/media_image",
			"/modules/1/case_list/use_default_image_for_all",
			"/modules/1/case_list_form/media_image",
			"/modules/1/case_list_form/use_default_image_for_all",
		]);
	});

	it("reads distinct files on a case list menu item", async () => {
		const outcome = await readWithMedia(caseListApp(), (json) => {
			listBlocks(json).item.media_image = { en: MENU_ICON, es: OTHER_ICON };
		});
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The app did not read.");
		expect(
			moduleNamed(outcome.draft.doc, "Patients").caseListMenuItem
				?.mediaByLanguage?.spa?.icon,
		).toBe(testMediaAssetId("other-icon"));
	});

	it("reads distinct files on a Register button", async () => {
		const outcome = await readWithMedia(caseListApp(), (json) => {
			listBlocks(json).register.media_image = {
				en: MENU_ICON,
				es: OTHER_ICON,
			};
		});
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The app did not read.");
		const register = moduleNamed(
			outcome.draft.doc,
			"Patients",
		).caseListRegistrationForm;
		expect(
			register?.kind === "always" && register.mediaByLanguage?.spa?.icon,
		).toBe(testMediaAssetId("other-icon"));
	});
});

describe("an override of a generated media key in `translations`", () => {
	// HQ's build writes a language's override over the string it generates
	// (`app_strings.py::SelectKnownAppStrings.app_strings_parts`), and the suite reads a menu's or
	// a form's icon and audio through those strings (`suite_xml/sections/menus.py`,
	// `entries.py`, `image_locale_id`), so the override is the file a worker sees there.
	it("holds an override naming the file the language already shows as inert", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			(json.modules[0] as AppJson["modules"][number]).media_image = {
				en: MENU_ICON,
			};
			overriding(json, { "modules.m0.icon": MENU_ICON });
		});
		expect(findings(outcome)).toEqual([]);
		expect(translationEntries(outcome)).toContain(
			"translations-generated-key-with-no-effect",
		);
	});

	it("keeps a menu's generated icon and original map independently", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			const menu = json.modules[0];
			menu.media_image = { en: MENU_ICON };
			(menu.forms[0] as Record<string, unknown>).media_image = {
				en: OTHER_ICON,
			};
			overriding(json, { "modules.m0.icon": OTHER_ICON });
		});
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The menu did not read.");
		const doc = outcome.draft.doc;
		const menu = doc.modules[doc.moduleOrder[0]];
		expect(menu.icon).toBe(testMediaAssetId("menu-icon"));
		expect(menu.mediaByLanguage?.eng?.iconOverride).toBe(
			testMediaAssetId("other-icon"),
		);
		const appLanguages = effectiveAppLocalization(doc.localization);
		expect(
			navigationFilesInLanguage(menu, appLanguages.sourceLanguage, appLanguages)
				.icon,
		).toBe(testMediaAssetId("other-icon"));
		expect(translationEntries(outcome)).toContain(
			"translations-generated-navigation-file",
		);
		const assets = new Map(manifestFor(doc));
		for (const [path, id] of [
			[MENU_ICON, testMediaAssetId("menu-icon")],
			[OTHER_ICON, testMediaAssetId("other-icon")],
		] as const) {
			const asset = assets.get(id);
			if (asset)
				assets.set(id, {
					...asset,
					wirePath: path.replace("jr://file/", ""),
				});
		}
		const body = expandDoc(doc, { assets });
		expect(body.modules[0].media_image.en).toBe(MENU_ICON);
		expect(body.translations?.en["modules.m0.icon"]).toBe(OTHER_ICON);
	});

	it("reads the same document after publishing two paths mapped to the same strict asset", async () => {
		const original = await readWithMedia(app(), (json) => {
			const menu = json.modules[0];
			menu.media_image = { en: MENU_ICON };
			// The form carries the alternate path as an ordinary resource, so HQ can
			// install both paths even though they own one media file.
			(menu.forms[0] as Record<string, unknown>).media_image = {
				en: MENU_ICON_ALIAS,
			};
			overriding(json, { "modules.m0.icon": MENU_ICON_ALIAS });
		});
		expect(findings(original)).toEqual([]);
		if (original.kind !== "read") throw new Error("The source did not read.");
		const doc = original.draft.doc;
		const id = testMediaAssetId("menu-icon");
		const assets = new Map(manifestFor(doc));
		const asset = assets.get(id);
		if (!asset) throw new Error("The source lost its icon.");
		assets.set(id, { ...asset, wirePath: MENU_ICON.replace("jr://file/", "") });
		const emitted = expandDoc(doc, { assets });
		expect(emitted.modules[0].media_image.en).toBe(MENU_ICON);
		const reread = await readWithMedia(doc, (json) => {
			json.modules = JSON.parse(
				JSON.stringify(emitted.modules),
			) as AppJson["modules"];
			json.translations = emitted.translations;
		});
		expect(findings(reread)).toEqual([]);
		if (reread.kind !== "read") throw new Error("The export did not read.");
		const own = (candidate: BlueprintDoc) =>
			candidate.modules[candidate.moduleOrder[0]].mediaByLanguage?.eng
				?.iconOverride;
		expect(own(reread.draft.doc)).toBe(own(doc));
		expect(own(doc)).toBeUndefined();
		expect(translationEntries(original)).toContain(
			"translations-generated-key-with-no-effect",
		);
	});

	it("refuses a same-asset alias HQ does not package as an exact path", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			json.modules[0].media_image = { en: MENU_ICON };
			overriding(json, { "modules.m0.icon": MENU_ICON_ALIAS });
		});
		expect(findings(outcome)).toEqual([
			"application-and-settings/translations-generated-navigation-file-not-packaged",
		]);
	});

	it("does not count a default-for-all fallback as a named language's package", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			const menu = json.modules[0];
			menu.media_image = { en: MENU_ICON, es: MENU_ICON };
			const form = menu.forms[0] as Record<string, unknown>;
			form.media_image = { en: OTHER_ICON };
			form.use_default_image_for_all = true;
			json.translations = { es: { "modules.m0.icon": OTHER_ICON } };
		});
		expect(findings(outcome)).toEqual([
			"application-and-settings/translations-generated-navigation-file-not-packaged",
		]);
	});

	it("keeps an override equal to the full-app fallback for a limited installation", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			json.langs = [...(json.langs as string[]), "fr"];
			const menu = json.modules[0];
			menu.media_image = { en: MENU_ICON, es: OTHER_ICON };
			(menu.forms[0] as Record<string, unknown>).media_image = {
				fr: MENU_ICON,
			};
			json.translations = { fr: { "modules.m0.icon": MENU_ICON } };
		});
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The menu did not read.");
		const doc = outcome.draft.doc;
		const menu = doc.modules[doc.moduleOrder[0]];
		const localization = effectiveAppLocalization(doc.localization);
		expect(menu.mediaByLanguage?.fra?.iconOverride).toBe(
			testMediaAssetId("menu-icon"),
		);
		expect(
			navigationFilesInLanguage(menu, "fra", localization, ["fra", "spa"]).icon,
		).toBe(testMediaAssetId("menu-icon"));
	});

	it("counts media stored on a case list's ordinary menu item", async () => {
		const outcome = await readWithMedia(caseListApp(), (json) => {
			json.modules[0].media_image = { en: MENU_ICON };
			listBlocks(json).item.media_image = { en: OTHER_ICON };
			overriding(json, { "modules.m0.icon": OTHER_ICON });
		});
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The menu did not read.");
		expect(
			outcome.draft.doc.modules[outcome.draft.doc.moduleOrder[0]]
				.mediaByLanguage?.eng?.iconOverride,
		).toBe(testMediaAssetId("other-icon"));
	});

	it("counts the exact path on a question's ordinary media in that language", async () => {
		const doc = app();
		const id = testMediaAssetId("other-icon");
		const withMedia = produce(doc, (draft) => {
			const field = Object.values(draft.fields)[0];
			if (field?.kind !== "text") throw new Error("Missing question.");
			field.label_media = { image: id };
		});
		const assets = new Map(manifestFor(withMedia));
		const asset = assets.get(id);
		if (!asset) throw new Error("Missing fixture image.");
		assets.set(id, {
			...asset,
			wirePath: OTHER_ICON.replace("jr://file/", ""),
		});
		const outcome = await readWithMedia(
			withMedia,
			(json) => {
				json.modules[0].media_image = { en: MENU_ICON };
				overriding(json, { "modules.m0.icon": OTHER_ICON });
			},
			assets,
		);
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The menu did not read.");
		expect(
			outcome.draft.doc.modules[outcome.draft.doc.moduleOrder[0]]
				.mediaByLanguage?.eng?.iconOverride,
		).toBe(id);
	});

	it("keeps a form's generated spoken label on that form and locale", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			const menu = json.modules[0] as AppJson["modules"][number];
			(menu.forms[0] as Record<string, unknown>).media_audio = {
				en: FORM_AUDIO,
			};
			menu.media_audio = { en: OTHER_AUDIO };
			overriding(json, { "forms.m0f0.audio": OTHER_AUDIO });
		});
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The form did not read.");
		const doc = outcome.draft.doc;
		const form = doc.forms[doc.formOrder[doc.moduleOrder[0]][0]];
		expect(form.audioLabel).toBe(testMediaAssetId("form-audio"));
		expect(form.mediaByLanguage?.eng?.audioLabelOverride).toBe(
			testMediaAssetId("other-audio"),
		);
	});

	it.each([
		[undefined, "translations-generated-menu-icon-only-in-media-map"],
		["es", "translations-generated-navigation-file-not-packaged"],
	])(
		"distinguishes a mapped icon from another language's carrier (%s)",
		async (carrier, entry) => {
			const outcome = await readWithMedia(app(), (json) => {
				const menu = json.modules[0];
				menu.media_image = { en: MENU_ICON };
				json.multimedia_map = {
					[OTHER_ICON]: {
						media_type: "CommCareImage",
						multimedia_id: "mapped-icon",
					},
				};
				if (carrier)
					(menu.forms[0] as Record<string, unknown>).media_image = {
						[carrier]: OTHER_ICON,
					};
				overriding(json, { "modules.m0.icon": OTHER_ICON });
			});
			expect(findings(outcome)).toEqual([`application-and-settings/${entry}`]);
		},
	);

	it.each([
		[
			["en"],
			"es",
			"translations-generated-menu-icon-outside-installation-languages",
		],
		[["en", "es"], "es", "translations-generated-navigation-file-not-packaged"],
		[["es"], "es", "translations-generated-navigation-file-not-packaged"],
		[["en"], "en", undefined],
	] as const)(
		"accounts for an icon in a named %j installation with its carrier in %s",
		async (languages, carrier, finding) => {
			const outcome = await readWithMedia(app(), (json) => {
				const menu = json.modules[0];
				menu.media_image = { en: MENU_ICON };
				(menu.forms[0] as Record<string, unknown>).media_image = {
					[carrier]: OTHER_ICON,
				};
				json.multimedia_map = {
					[OTHER_ICON]: {
						media_type: "CommCareImage",
						multimedia_id: "mapped-icon",
					},
				};
				Object.assign(json, {
					build_profiles: { field: { name: "Field", langs: languages } },
				});
				overriding(json, { "modules.m0.icon": OTHER_ICON });
			});
			expect(findings(outcome)).toEqual(
				finding === undefined ? [] : [`application-and-settings/${finding}`],
			);
		},
	);

	it("refuses an override whose file HQ leaves out of the installation", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			json.modules[0].media_image = { en: MENU_ICON };
			overriding(json, { "modules.m0.icon": OTHER_ICON });
		});
		expect(findings(outcome)).toEqual([
			"application-and-settings/translations-generated-navigation-file-not-packaged",
		]);
	});

	it.each([
		[
			"jr://file/commcare/image/unmapped.png",
			"translations-generated-menu-icon-without-mapping",
		],
		[
			"not-an-installation-file",
			"translations-generated-navigation-file-not-packaged",
		],
		[
			"http://example.invalid/menu-icon.png",
			"translations-generated-navigation-file-not-packaged",
		],
	])(
		"refuses an unpackaged generated literal even without a resolved asset (%s)",
		async (path, entry) => {
			const outcome = await readWithMedia(app(), (json) => {
				json.modules[0].media_image = { en: MENU_ICON };
				overriding(json, { "modules.m0.icon": path });
			});
			expect(findings(outcome)).toEqual([`application-and-settings/${entry}`]);
			expect(outcome.claims.handOffs.map((ref) => ref.subject)).not.toContain(
				path,
			);
			expect(translationEntries(outcome)).not.toContain(
				"translations-generated-navigation-file",
			);
		},
	);

	it("hands an ordinary referenced path with a missing asset to the media plan", async () => {
		const path = "jr://file/commcare/image/unmapped.png";
		const outcome = await readWithMedia(app(), (json) => {
			const menu = json.modules[0];
			menu.media_image = { en: MENU_ICON };
			(menu.forms[0] as Record<string, unknown>).media_image = { en: path };
			overriding(json, { "modules.m0.icon": path });
		});
		expect(findings(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The menu did not read.");
		expect(outcome.draft.facts.pendingMedia).toContainEqual(
			expect.objectContaining({
				path,
				pointer: "/translations/en/modules.m0.icon",
			}),
		);
	});

	it("refuses to keep a resolved override whose ordinary carrier was lost", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			const menu = json.modules[0];
			menu.media_image = {
				en: "jr://file/commcare/image/no-ordinary-file.png",
			};
			(menu.forms[0] as Record<string, unknown>).media_image = {
				en: OTHER_ICON,
			};
			overriding(json, { "modules.m0.icon": OTHER_ICON });
		});
		expect(findings(outcome)).toContain(
			"application-and-settings/translations-generated-navigation-file-not-packaged",
		);
	});

	it("holds an override of media no language shows as inert: no screen reads the key", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			overriding(json, {
				"modules.m0.icon": OTHER_ICON,
				"forms.m0f0.audio": FORM_AUDIO,
				"m0.case_short.case_photo_1.alt_text.kyes": "A photo",
			});
		});
		expect(findings(outcome)).toEqual([]);
		/* One record a key, each at `translations`, where the key its claim names sits. */
		expect(
			translationEntries(outcome).filter(
				(entry) => entry === "translations-generated-key-with-no-effect",
			),
		).toHaveLength(3);
	});
});
