/**
 * Every app string a reading holds, read from CommCare HQ's shapes and printed back.
 *
 * Contract: an app string (the app's name, a column's header, a Search field's label, hint,
 * required message and validation message, the search screen's title and subtitle, a case list
 * menu item's and a Register button's label) is held through one function
 * (`heldText.ts::heldText`): a device shows HQ's build of it (`commcare_translations.py::dumps`
 * writes a text Python reads as blank as one non-breaking space and a line break as `\n`, and
 * Core's `LocalizationUtils.parseAndAdd` trims the characters up to U+0020 at a line's end before
 * `parseValue` reads `\n` back), Nova's gate admits no text with a space or a line break at
 * either end and no blank translation of a text whose role requires one, so the reading drops
 * them at a text's ends and gives a blank-looking language the source's text where the role
 * requires text. A Search field's validation message is held apart from the runtime guard's
 * text joined after it. The reading is a document the gate
 * admits, Nova's export of it shows on a device what HQ's build showed except where the reading
 * says a worker reads another text (`text-spaces-dropped`), and a respelling no worker meets is
 * recorded under the surface's own id.
 *
 * Plausible failures: a reading whose document the gate refuses
 * (`APP_STRING_VALUE_UNREPRESENTABLE`, `TRANSLATION_REQUIRED_CONTENT_BLANK`), which ends a bring-in
 * as a reader defect; a text left unrecognized that Nova can hold; a worker-facing change recorded
 * as a respelling, or a respelling recorded as a change workers see; a blank translation of a text
 * whose role allows one filled with the source's text.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type LanguageTag,
	makeTranslationUnitId,
} from "@/lib/domain";
import {
	idMappingColumn,
	idMappingEntry,
	plainColumn,
} from "@/lib/domain/modules";
import { SEARCH_RUNTIME_VALIDATION_MESSAGES } from "@/lib/domain/searchRuntimeValidationMessages";
import { expandDoc } from "../../expander";
import { commCareLocalization } from "../../localization";
import { runValidation } from "../../validator/runner";
import { patients, uuid } from "../caseList/__tests__/fixtures";
import { cleanTrans } from "../hqText";
import { readHqApp } from "../index";
import { inSpanish } from "../menus/__tests__/menuReading";
import type { AppStringTable } from "../types";
import { exportedBody, inputFor } from "./novaExport";

type JsonObject = Record<string, unknown>;
type Texts = Record<string, string>;
type Path = readonly (string | number)[];

/** Spanish first, English the source: `langs` is `["es", "en"]`. */
const PROMPTS = localizationWireFixture("prompts");
const LANGS = ["es", "en"] as const;

/**
 * What a device shows for an app string HQ's build writes as `text`, `""` for one that shows
 * blank: `dumps` writes a text Python strips to nothing as one non-breaking space and a line
 * break as `\n`, and Core trims the line, dropping every character up to U+0020 at its end,
 * before it reads `\n` as a line break. The test's texts hold ASCII spaces and line breaks
 * only.
 */
function onDevice(text: string): string {
	if (text.trim() === "") return "";
	const line = text.replaceAll("\n", "\\n");
	let end = line.length;
	while (end > 0 && line.charCodeAt(end - 1) <= 0x20) end -= 1;
	return line.slice(0, end).replaceAll("\\n", "\n");
}

/** A language's own app string, `clean_trans(map, [lang] + langs)`. */
function own(map: unknown, lang: string, langs: readonly string[]): string {
	const text = cleanTrans(map, [lang, ...langs]);
	if (!text.ok) throw new Error("The test's maps hold text only.");
	return text.text;
}

/** What each language of `langs` shows on a device for a `clean_trans` app string stored as
 *  `map`: a language's own string, or the first build language's that is not empty where its own
 *  is (`create_custom_app_strings`, `create_default_app_strings`). */
function showsIn(langs: readonly string[]): (map: unknown) => Texts {
	return (map) => {
		const fallback =
			langs.map((lang) => own(map, lang, langs)).find((one) => one !== "") ??
			"";
		return Object.fromEntries(
			langs.map((lang) => {
				const text = own(map, lang, langs);
				return [lang, onDevice(text === "" ? fallback : text)];
			}),
		);
	};
}

const shows = showsIn(LANGS);

/** What each language's devices show for a label stored as `map`, HQ's `fallback` where the
 *  chosen text is empty (the case list's label, `_create_case_list_form_app_strings`). */
function labelShows(
	map: unknown,
	fallback: string,
	langs: readonly string[],
): Texts {
	return Object.fromEntries(
		langs.map((lang) => {
			const text = own(map, lang, langs);
			return [lang, onDevice(text === "" ? fallback : text)];
		}),
	);
}

/** What each language's devices show for the search title stored as `map`: its own text, or the
 *  first language's where its own is empty (`CaseSearch.get_search_title_label`). */
function titleShows(map: unknown): Texts {
	const stored = map as Texts;
	return Object.fromEntries(
		LANGS.map((lang) => [lang, onDevice(stored[lang] || stored[LANGS[0]])]),
	);
}

/** Each language's text without the spaces at its start, which Core kept on the device and
 *  Nova's print of a held text has none of. */
function startless(texts: Texts): Texts {
	return Object.fromEntries(
		Object.entries(texts).map(([lang, text]) => [lang, text.trimStart()]),
	);
}

/** Each language's text without a line break at its end, which the device showed. */
function breakless(texts: Texts): Texts {
	return Object.fromEntries(
		Object.entries(texts).map(([lang, text]) => [lang, text.trimEnd()]),
	);
}

/** Nova's sentence the fixture's validated Search field joins after its own message in `text`. */
function guardOf(text: string): string {
	const guard = SEARCH_RUNTIME_VALIDATION_MESSAGES.find((one) =>
		text.endsWith(` ${one.message}`),
	);
	if (guard === undefined)
		throw new Error("The fixture's validation joins a runtime guard.");
	return guard.message;
}

const TEXT_REGISTERS = new Set([
	"names-respelled",
	"list-settings-respelled",
	"text-spaces-dropped",
]);

interface Surface {
	readonly title: string;
	readonly doc: BlueprintDoc;
	/** The stored maps' places in a JSON body: the first is the one compared on devices. */
	readonly at: readonly Path[];
	/** What each language's devices show for one stored map. */
	readonly shows: (map: unknown) => Texts;
}

function get(body: JsonObject, path: Path): unknown {
	let node: unknown = body;
	for (const step of path) node = (node as Record<string, unknown>)[step];
	return node;
}

function set(body: JsonObject, path: Path, value: unknown): void {
	const parent = get(body, path.slice(0, -1)) as Record<string, unknown>;
	parent[path[path.length - 1] as string] = value;
}

const pointer = (path: Path) => `/${path.join("/")}`;

/** A list that always offers the registration of another menu, in English and Spanish. */
function registrationDoc(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				name: "Registration",
				caseType: "patient",
				forms: [
					{
						uuid: "reg",
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "notes",
								caseWrite: { caseType: "patient", property: "notes" },
							}),
						],
					},
				],
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

/** A list with an ID mapping, in English, its source and first language, and French. */
function mappingDoc(): BlueprintDoc {
	const doc = patients([
		plainColumn(uuid(1), "case_name", "Name"),
		idMappingColumn(uuid(2), "notes", "Notes", [idMappingEntry("a", "Alpha")]),
	]);
	const fra = "fra" as LanguageTag;
	return {
		...doc,
		localization: {
			sourceLanguage: "eng" as LanguageTag,
			defaultLanguage: "eng" as LanguageTag,
			languageOrder: ["eng", fra] as LanguageTag[],
			wireCodes: { eng: "en", [fra]: "fr" },
			translations: { [fra]: {} },
		},
	};
}

/** The prompts fixture with its case list a menu item, so a case list label is stored. */
function menuItemDoc(): BlueprintDoc {
	return produce(PROMPTS, (draft) => {
		const module = draft.modules[draft.moduleOrder[0] as string];
		if (module !== undefined) module.caseListMenuItem = {};
	});
}

const SEARCH = ["modules", 0, "search_config"] as const;
const SURFACES = {
	header: {
		title: "a column's header",
		doc: PROMPTS,
		at: [
			["modules", 0, "case_details", "short", "columns", 0, "header"],
			["modules", 0, "case_details", "long", "columns", 0, "header"],
		],
		shows,
	},
	label: {
		title: "a Search field's label",
		doc: PROMPTS,
		at: [[...SEARCH, "properties", 0, "label"]],
		shows,
	},
	hint: {
		title: "a Search field's hint",
		doc: PROMPTS,
		at: [[...SEARCH, "properties", 0, "hint"]],
		shows,
	},
	required: {
		title: "a Search field's required message",
		doc: PROMPTS,
		at: [[...SEARCH, "properties", 1, "required", "text"]],
		shows,
	},
	validation: {
		title:
			"a Search field's validation message, the runtime guard's sentence joined after it,",
		doc: PROMPTS,
		at: [[...SEARCH, "properties", 2, "validations", 0, "text"]],
		shows,
	},
	title: {
		title: "the search screen's title",
		doc: PROMPTS,
		at: [[...SEARCH, "title_label"]],
		shows: titleShows,
	},
	description: {
		title: "the search screen's subtitle",
		doc: PROMPTS,
		at: [[...SEARCH, "description"]],
		shows,
	},
	mapping: {
		title: "an ID mapping's label",
		doc: mappingDoc(),
		at: [
			["modules", 0, "case_details", "short", "columns", 1, "enum", 0, "value"],
			["modules", 0, "case_details", "long", "columns", 1, "enum", 0, "value"],
		],
		shows: showsIn(["en", "fr"]),
	},
	menuItem: {
		title: "a case list menu item's label",
		doc: menuItemDoc(),
		at: [["modules", 0, "case_list", "label"]],
		shows: (map: unknown) => labelShows(map, "Case List", LANGS),
	},
	register: {
		title: "a Register button's label",
		doc: registrationDoc(),
		at: [["modules", 1, "case_list_form", "label"]],
		shows: (map: unknown) => labelShows(map, "Create a new Case", ["en", "es"]),
	},
} satisfies Record<string, Surface>;

async function read(doc: BlueprintDoc, edit: (body: JsonObject) => void) {
	const body = exportedBody(doc);
	edit(body);
	const outcome = readHqApp(await inputFor(body));
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "read")
		throw new Error(
			`The app read to an account: ${JSON.stringify(outcome.findings.map((one) => [one.code, one.detail]))}`,
		);
	return { body, draft: outcome.draft };
}

/** Nova's export of a reading's document, as HQ's import stores it. */
function republished(doc: BlueprintDoc): JsonObject {
	return JSON.parse(JSON.stringify(expandDoc(doc))) as JsonObject;
}

describe("an app string read from CommCare HQ", () => {
	const cases: readonly {
		readonly surface: Surface;
		readonly case: string;
		/** Each language's stored text, from the export's own map. */
		readonly stored: (map: Texts) => Texts;
		/** What each language's devices show from Nova's export of the reading, where a worker
		 *  reads another text; else what they showed. */
		readonly novaShows?: (before: Texts) => Texts;
		/** The record of the stored map's rewrite, if any. */
		readonly register?: "list-settings-respelled" | "text-spaces-dropped";
	}[] = [
		{
			surface: SURFACES.header,
			case: "with a space at the start of a language's text",
			stored: (map) => ({ ...map, es: ` ${map.es}` }),
			novaShows: startless,
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.header,
			case: "with spaces at the end of every language's text",
			stored: (map) => ({ es: `${map.es}  `, en: `${map.en} ` }),
			register: "list-settings-respelled",
		},
		{
			surface: SURFACES.mapping,
			case: "with a space at the start of a language's text",
			stored: () => ({ en: "Alpha", fr: " Alpha FR" }),
			novaShows: startless,
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.mapping,
			case: "with spaces at the end of every language's text",
			stored: () => ({ en: "Alpha ", fr: "Alpha FR  " }),
			register: "list-settings-respelled",
		},
		{
			surface: SURFACES.label,
			case: "only spaces in a language beside the source's text",
			stored: (map) => ({ ...map, es: "  " }),
			novaShows: (before) => ({ ...before, es: before.en }),
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.label,
			case: "with a space at the start of the source's text",
			stored: (map) => ({ ...map, en: ` ${map.en}` }),
			novaShows: startless,
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.hint,
			case: "with a space at the start of a language's text",
			stored: (map) => ({ ...map, es: ` ${map.es}` }),
			novaShows: startless,
			register: "text-spaces-dropped",
		},
		{
			// A hint's translation may be blank, and Nova writes it blank as HQ's build does.
			surface: SURFACES.hint,
			case: "only spaces in a language beside the source's text, a blank its role allows,",
			stored: (map) => ({ ...map, es: "  " }),
		},
		{
			surface: SURFACES.required,
			case: "only spaces in a language beside the source's text",
			stored: (map) => ({ ...map, es: "  " }),
			novaShows: (before) => ({ ...before, es: before.en }),
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.required,
			case: "with a space at the start of a language's text",
			stored: (map) => ({ ...map, es: ` ${map.es}` }),
			novaShows: startless,
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.validation,
			case: "only spaces in a language beside the source's text",
			stored: (map) => ({ ...map, es: "  " }),
			novaShows: (before) => ({ ...before, es: before.en }),
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.validation,
			case: "with a space at the start of a language's text",
			stored: (map) => ({ ...map, es: ` ${map.es}` }),
			novaShows: startless,
			register: "text-spaces-dropped",
		},
		{
			// The source's message ends with a space of its own before the guard's sentence, so
			// Nova's join shows one space fewer.
			surface: SURFACES.validation,
			case: "with two spaces before the guard's sentence in the source's text",
			stored: (map) => {
				const guard = guardOf(map.en ?? "");
				const message = (map.en ?? "").slice(0, -guard.length - 1);
				return { ...map, en: `${message}  ${guard}` };
			},
			novaShows: (before) => {
				const guard = guardOf(before.en ?? "");
				return {
					...before,
					en: `${(before.en ?? "").slice(0, -guard.length - 2)} ${guard}`,
				};
			},
			register: "text-spaces-dropped",
		},
		{
			// The guard's text in Spanish is split where neither side meets the space with one of
			// its own, so the join is the stored bytes.
			surface: SURFACES.validation,
			case: "with two spaces inside a language's message before a guard's text it translates",
			stored: (map) => ({ ...map, es: "Usa  minúsculas. Debe ser fecha." }),
		},
		{
			surface: SURFACES.header,
			case: "with a line break at the end of a language's text",
			stored: (map) => ({ ...map, es: `${map.es}\n` }),
			novaShows: breakless,
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.menuItem,
			case: "with a line break at the end of a language's text",
			stored: () => ({ es: "Todos\n", en: "All patients" }),
			novaShows: breakless,
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.title,
			case: "with a space at the start of a language's text",
			stored: () => ({ es: " Buscar", en: "Find" }),
			novaShows: startless,
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.title,
			case: "with spaces at the end of every language's text",
			stored: () => ({ es: "Buscar ", en: "Find  " }),
			register: "list-settings-respelled",
		},
		{
			surface: SURFACES.description,
			case: "only spaces in a language beside the source's text",
			stored: () => ({ es: "  ", en: "Find a patient" }),
			novaShows: (before) => ({ ...before, es: before.en }),
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.description,
			case: "with a space at the start of the source's text",
			stored: () => ({ es: "Buscar", en: " Find a patient" }),
			novaShows: startless,
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.menuItem,
			case: "only spaces in a language beside the source's text",
			stored: () => ({ es: "  ", en: "All patients" }),
			novaShows: (before) => ({ ...before, es: before.en }),
			register: "text-spaces-dropped",
		},
		{
			// Every language shows a blank label, as Nova's print of the one blank text does.
			surface: SURFACES.menuItem,
			case: "only spaces, unlike, in every language",
			stored: () => ({ es: "  ", en: " " }),
			register: "list-settings-respelled",
		},
		{
			surface: SURFACES.menuItem,
			case: "with spaces at the end of every language's text",
			stored: () => ({ es: "Todos ", en: "All patients " }),
			register: "list-settings-respelled",
		},
		{
			surface: SURFACES.register,
			case: "only spaces in a language beside the source's text",
			stored: () => ({ en: "New patient", es: "  " }),
			novaShows: (before) => ({ ...before, es: before.en }),
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.register,
			case: "with a space at the start of a language's text",
			stored: () => ({ en: "New patient", es: " Nuevo" }),
			novaShows: startless,
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.register,
			case: "with spaces at the end of every language's text",
			stored: () => ({ en: "New patient ", es: "Nuevo " }),
			register: "list-settings-respelled",
		},
		{
			surface: SURFACES.register,
			case: "with no key for a language, which shows the source's text",
			stored: () => ({ en: "New patient" }),
			register: "list-settings-respelled",
		},
	];

	for (const one of cases)
		it(`${one.surface.title} ${one.case} reads as devices showed it, held as Nova's gate admits it`, async () => {
			const { surface } = one;
			const { body, draft } = await read(surface.doc, (body) => {
				for (const path of surface.at)
					set(body, path, one.stored((get(body, path) ?? {}) as Texts));
			});
			// The reading is a document Nova's gate admits.
			expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			const first = surface.at[0] ?? [];
			const before = surface.shows(get(body, first));
			const after = surface.shows(get(republished(draft.doc), first));
			expect(after).toEqual(one.novaShows?.(before) ?? before);
			if (one.novaShows !== undefined) expect(after).not.toEqual(before);
			const records = draft.facts.sameStateRewrites.filter(
				(record) =>
					TEXT_REGISTERS.has(record.register) &&
					surface.at.some((path) => record.path === pointer(path)),
			);
			if (one.register === undefined) expect(records).toEqual([]);
			else {
				expect(records.map((record) => record.path)).toContain(pointer(first));
				expect(new Set(records.map((record) => record.register))).toEqual(
					new Set([one.register]),
				);
			}
		});
});

describe("the app's name read from CommCare HQ", () => {
	const nameShows = (body: JsonObject): Texts => {
		const translations = (body.translations ?? {}) as Record<
			string,
			Record<string, unknown>
		>;
		return Object.fromEntries(
			LANGS.map((lang) => {
				const override = translations[lang]?.["app.display.name"];
				return [
					lang,
					onDevice(
						typeof override === "string" && override !== ""
							? override
							: (body.name as string),
					),
				];
			}),
		);
	};

	it("with a space at its start drops it, which workers then read", async () => {
		const { body, draft } = await read(PROMPTS, (body) => {
			body.name = " Health app";
		});
		expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(draft.doc.appName).toBe("Health app");
		expect(nameShows(body)).toEqual({ es: " Health app", en: " Health app" });
		expect(nameShows(republished(draft.doc))).toEqual({
			es: "Health app",
			en: "Health app",
		});
		expect(
			draft.facts.sameStateRewrites.filter((record) => record.path === "/name"),
		).toEqual([
			{
				entry: "application-and-settings/name",
				path: "/name",
				register: "text-spaces-dropped",
			},
		]);
	});

	it("with spaces at its end, which no device showed, is respelled", async () => {
		const { body, draft } = await read(PROMPTS, (body) => {
			body.name = "Health app  ";
		});
		expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(draft.doc.appName).toBe("Health app");
		expect(nameShows(republished(draft.doc))).toEqual(nameShows(body));
		expect(
			draft.facts.sameStateRewrites.filter((record) => record.path === "/name"),
		).toEqual([
			{
				entry: "application-and-settings/name",
				path: "/name",
				register: "names-respelled",
			},
		]);
	});

	it("only spaces in a language's own name beside the source's takes the source's name there", async () => {
		const { body, draft } = await read(PROMPTS, (body) => {
			const translations = body.translations as Record<string, JsonObject>;
			translations.es = { ...translations.es, "app.display.name": "  " };
		});
		expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(nameShows(body)).toEqual({ es: "", en: "Health app" });
		expect(nameShows(republished(draft.doc))).toEqual({
			es: "Health app",
			en: "Health app",
		});
		expect(
			draft.facts.sameStateRewrites.filter((record) =>
				record.path.startsWith("/translations/es/"),
			),
		).toEqual([
			{
				entry: "application-and-settings/translations-app-display-name",
				path: "/translations/es/app.display.name",
				register: "text-spaces-dropped",
			},
		]);
	});
});

describe("an app translation folded over an app string", () => {
	/** Nova's build of the first column's two headers, in each language, through the production
	 *  projection. */
	const headerStrings = (doc: BlueprintDoc): AppStringTable => {
		const module = doc.modules[doc.moduleOrder[0] as string];
		const column = module?.caseListConfig?.columns[0];
		if (column === undefined) throw new Error("The fixture has a column.");
		const unit = makeTranslationUnitId("column", column.uuid, "header");
		const headers = commCareLocalization(doc).textMap(unit);
		const keys = [SHORT_HEADER, LONG_HEADER];
		return {
			languages: Object.fromEntries(
				LANGS.map((lang) => [
					lang,
					Object.fromEntries(keys.map((key) => [key, headers[lang] ?? ""])),
				]),
			),
			units: Object.fromEntries(keys.map((key) => [key, unit])),
		};
	};
	const SHORT_HEADER = "m0.case_short.case_case_name_1.header";
	const LONG_HEADER = "m0.case_long.case_case_name_1.header";

	it("with a space at its start is held without it, which workers then read, recorded at the key", async () => {
		const body = exportedBody(PROMPTS);
		const translations = body.translations as Record<string, JsonObject>;
		// One unit feeds both headers' keys, so an override words both.
		translations.es = {
			...translations.es,
			[SHORT_HEADER]: " Nombre",
			[LONG_HEADER]: " Nombre",
		};
		const outcome = readHqApp({
			...(await inputFor(body)),
			appStrings: headerStrings,
		});
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(
				JSON.stringify(outcome.findings.map((one) => [one.code, one.detail])),
			);
		const draft = outcome.draft;
		expect(draft.facts.foldedTranslationKeys).toBe(2);
		expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const column =
			draft.doc.modules[draft.doc.moduleOrder[0] as string]?.caseListConfig
				?.columns[0];
		expect(
			draft.doc.localization?.translations.spa?.[
				makeTranslationUnitId("column", column?.uuid ?? "", "header")
			]?.value,
		).toBe("Nombre");
		expect(
			draft.facts.sameStateRewrites.filter(
				(record) => record.register === "text-spaces-dropped",
			),
		).toEqual([
			{
				entry:
					"application-and-settings/translations-generated-key-over-one-text",
				path: `/translations/es/${SHORT_HEADER}`,
				register: "text-spaces-dropped",
			},
		]);
	});

	it("over a literal backslash and n, which no spelling Nova's gate admits holds, is refused at the key", async () => {
		const body = exportedBody(PROMPTS);
		const translations = body.translations as Record<string, JsonObject>;
		translations.es = {
			...translations.es,
			[SHORT_HEADER]: "Nom\\nbre",
			[LONG_HEADER]: "Nom\\nbre",
		};
		const outcome = readHqApp({
			...(await inputFor(body)),
			appStrings: headerStrings,
		});
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		if (outcome.kind !== "account") return;
		expect(
			outcome.findings
				.map((one) => one.detail?.name)
				.filter((name) => name === SHORT_HEADER || name === LONG_HEADER)
				.sort(),
		).toEqual([LONG_HEADER, SHORT_HEADER]);
	});
});

describe("a case list menu item's label Nova's gate admits no spelling of", () => {
	it("is refused at the case list, and the item's other keys are still read", async () => {
		const body = exportedBody(menuItemDoc());
		const path = ["modules", 0, "case_list"] as const;
		const caseList = get(body, path) as JsonObject;
		caseList.label = { es: "Todos\\n", en: "All patients" };
		caseList.custom_icons = [{ form: "badge", text: {}, xpath: "1" }];
		const outcome = readHqApp(await inputFor(body));
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		if (outcome.kind !== "account") return;
		const atCaseList = outcome.findings.filter(
			(one) => one.place.kind === "case-list",
		);
		// One finding names the label, and `custom_icons` is refused by its own entry, never left
		// unclaimed.
		expect(
			atCaseList.filter((one) => one.detail?.name === "schema:CaseList.label"),
		).toHaveLength(1);
		expect(
			atCaseList.filter(
				(one) =>
					one.code === "unrecognized" &&
					one.detail?.name !== "schema:CaseList.label",
			),
		).toEqual([]);
	});
});
