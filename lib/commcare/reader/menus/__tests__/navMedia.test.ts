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
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain";
import { localAppStringTable } from "../../../appStrings";
import { expandDoc } from "../../../expander";
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
const FORM_AUDIO = "jr://file/commcare/audio/visit.mp3";

const ASSETS: Readonly<Record<string, ReaderMediaResolution>> = {
	[MENU_ICON]: {
		kind: "asset",
		assetId: testMediaAssetId("menu-icon"),
		mediaKind: "image",
	},
	[OTHER_ICON]: {
		kind: "asset",
		assetId: testMediaAssetId("other-icon"),
		mediaKind: "image",
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
): Promise<ReturnType<typeof readHqApp>> {
	const emitted = expandDoc(doc);
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
			recordDialect: () => undefined,
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
		// Nova writes the path under every language, which the first publish declares.
		expect(
			outcome.draft.facts.sameStateRewrites
				.filter((one) => one.register === "media-maps-respelled")
				.map((one) => one.path),
		).toEqual(["/modules/0/media_image", "/modules/0/forms/0/media_audio"]);
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

	it("refuses two files shown in two languages", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			(json.modules[0] as AppJson["modules"][number]).media_image = {
				en: MENU_ICON,
				es: OTHER_ICON,
			};
		});
		expect(findings(outcome)).toEqual([
			"menus-and-case-lists/media-image-media-audio-differing-by-language",
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

	it("refuses two files shown in two languages on a case list menu item", async () => {
		const outcome = await readWithMedia(caseListApp(), (json) => {
			listBlocks(json).item.media_image = { en: MENU_ICON, es: OTHER_ICON };
		});
		expect(findings(outcome)).toEqual([
			"menus-and-case-lists/media-image-media-audio-differing-by-language",
		]);
	});

	it("refuses two files shown in two languages on a Register button", async () => {
		const outcome = await readWithMedia(caseListApp(), (json) => {
			listBlocks(json).register.media_image = {
				en: MENU_ICON,
				es: OTHER_ICON,
			};
		});
		expect(findings(outcome)).toEqual([
			"menus-and-case-lists/media-image-media-audio-differing-by-language",
		]);
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

	it("refuses an override showing another file than the menu's in one language", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			(json.modules[0] as AppJson["modules"][number]).media_image = {
				en: MENU_ICON,
			};
			overriding(json, { "modules.m0.icon": OTHER_ICON });
		});
		expect(findings(outcome)).toEqual([
			"application-and-settings/translations-generated-key-anything-else",
		]);
		expect(
			outcome.kind === "account"
				? outcome.findings.map((one) => one.detail.name)
				: [],
		).toEqual(["modules.m0.icon"]);
	});

	it("refuses an override of a form's audio label naming another file", async () => {
		const outcome = await readWithMedia(app(), (json) => {
			const menu = json.modules[0] as AppJson["modules"][number];
			(menu.forms[0] as Record<string, unknown>).media_audio = {
				en: FORM_AUDIO,
			};
			overriding(json, { "forms.m0f0.audio": OTHER_ICON });
		});
		expect(findings(outcome)).toEqual([
			"application-and-settings/translations-generated-key-anything-else",
		]);
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
