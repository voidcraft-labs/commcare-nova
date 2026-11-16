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
import AdmZip from "adm-zip";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type LanguageTag,
	makeTranslationUnitId,
} from "@/lib/domain";
import { formWireName } from "@/lib/domain/formWireName";
import {
	idMappingColumn,
	idMappingEntry,
	NO_SEARCH_SCREEN_TITLE,
	plainColumn,
} from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { SEARCH_RUNTIME_VALIDATION_MESSAGES } from "@/lib/domain/searchRuntimeValidationMessages";
import { casePropertyOptionTranslationUnitId } from "@/lib/domain/translationUnits";
import type { Uuid } from "@/lib/domain/uuid";
import { compileCcz } from "../../compiler";
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
 * break as `\n`, Core ends the line at a carriage return and trims it, dropping every character
 * up to U+0020 at its end, before it reads `\n`, whether `dumps` wrote it or the text held it,
 * as a line break. `dumps` also writes a `#` no backslash precedes as `\#`, and Core reads `\#`
 * as `#` before it reads `\n`, so a backslash before `#` is not shown. The test's texts hold
 * ASCII letters, spaces, line breaks, carriage returns, backslashes and `#` only.
 */
function onDevice(text: string): string {
	if (text.trim() === "") return "";
	const lines = text.replaceAll("\n", "\\n");
	let written = "";
	for (let index = 0; index < lines.length; index += 1)
		written +=
			lines[index] === "#" && lines[index - 1] !== "\\" ? "\\#" : lines[index];
	const line = written.split("\r")[0] ?? "";
	let end = line.length;
	while (end > 0 && line.charCodeAt(end - 1) <= 0x20) end -= 1;
	return line.slice(0, end).replaceAll("\\#", "#").replaceAll("\\n", "\n");
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

/** The entry a text whose rest after a carriage return defines another app string is refused
 *  under. */
const LINE_END_ENTRY =
	"application-and-settings/app-text-holding-a-carriage-return-whose-rest-defines-an-app-string";

/** The entry an app text holding a character XML 1.0 cannot carry is refused under. */
const CHARACTER_ENTRY =
	"application-and-settings/app-text-holding-a-character-xml-cannot-carry";

/** The entry an app `name` the profile shows otherwise than the app strings do is refused under. */
const APP_NAME_ENTRY =
	"application-and-settings/app-name-holding-backslash-n-a-backslash-before-hash-or-a-carriage-return";

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
	menuName: {
		title: "a menu's name",
		doc: PROMPTS,
		at: [["modules", 0, "name"]],
		shows,
	},
	formName: {
		title: "a form's name",
		doc: PROMPTS,
		at: [["modules", 0, "forms", 0, "name"]],
		shows,
	},
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
		readonly register?:
			| "names-respelled"
			| "list-settings-respelled"
			| "text-spaces-dropped";
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
		// The two characters `\n` show as the line break `dumps` writes the same way, so the
		// reading holds that line break and only the stored map is new.
		{
			surface: SURFACES.menuName,
			case: "with the two characters `\\n` inside a language's text",
			stored: (map) => ({ ...map, es: "Todos\\nlos pacientes" }),
			register: "names-respelled",
		},
		{
			surface: SURFACES.formName,
			case: "with the two characters `\\n` inside the source's text",
			stored: (map) => ({ ...map, en: "Visit\\nnow" }),
			register: "names-respelled",
		},
		{
			surface: SURFACES.header,
			case: "with the two characters `\\n` inside a language's text",
			stored: (map) => ({ ...map, es: "Nom\\nbre" }),
			register: "list-settings-respelled",
		},
		{
			surface: SURFACES.header,
			case: "with the two characters `\\n` after a backslash inside a language's text",
			stored: (map) => ({ ...map, es: "Nom\\\\nbre" }),
			register: "list-settings-respelled",
		},
		{
			surface: SURFACES.header,
			case: "with the two characters `\\n` at the end of a language's text",
			stored: (map) => ({ ...map, es: `${map.es}\\n` }),
			novaShows: breakless,
			register: "text-spaces-dropped",
		},
		{
			surface: SURFACES.label,
			case: "with the two characters `\\n` inside the source's text",
			stored: (map) => ({ ...map, en: "Patient\\nname" }),
			register: "list-settings-respelled",
		},
		// A backslash before `#` is left by `dumps` and read by Core as `#` alone, so the reading
		// holds the `#` a device showed and only the stored map is new.
		{
			surface: SURFACES.menuName,
			case: "with a backslash before `#` inside a language's text",
			stored: (map) => ({ ...map, es: "Visita \\#1" }),
			register: "names-respelled",
		},
		{
			surface: SURFACES.formName,
			case: "with a backslash before `#` inside the source's text",
			stored: (map) => ({ ...map, en: "Visit \\#1 and #2" }),
			register: "names-respelled",
		},
		{
			surface: SURFACES.header,
			case: "with a backslash before `#` inside a language's text",
			stored: (map) => ({ ...map, es: "Nombre \\#" }),
			register: "list-settings-respelled",
		},
		{
			surface: SURFACES.label,
			case: "with a backslash before `#` inside the source's text",
			stored: (map) => ({ ...map, en: "Patient \\#" }),
			register: "list-settings-respelled",
		},
		{
			surface: SURFACES.register,
			case: "with a backslash before `#` inside every language's text",
			stored: () => ({ en: "New \\#", es: "Nuevo \\#" }),
			register: "list-settings-respelled",
		},
		{
			surface: SURFACES.header,
			case: "with a `#` no backslash precedes, which a device shows as it is",
			stored: (map) => ({ ...map, es: "Nombre #1" }),
		},
		// A device shows only the text before a carriage return, and a rest with no `=` defines
		// no app string, so the reading holds what it showed.
		{
			surface: SURFACES.menuItem,
			case: "with a carriage return inside a language's text, whose rest defines nothing",
			stored: () => ({ es: "Todos\rlos pacientes", en: "All patients" }),
			register: "list-settings-respelled",
		},
		{
			surface: SURFACES.menuName,
			case: "with a carriage return inside the source's text, whose rest defines nothing",
			stored: (map) => ({ ...map, en: `${map.en}\r(old)` }),
			register: "names-respelled",
		},
		{
			surface: SURFACES.description,
			case: "with a carriage return inside a language's text, whose rest ends in `=`",
			stored: () => ({ es: "Buscar\rx=", en: "Find a patient" }),
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

	// A language that stores no `app.display.name` shows `name`: where the source language's own
	// display name is read as the app's name, that language takes `name` as its translation, and a
	// respelling of it is CommCare HQ's `name`, the one path that holds it.
	it("folded from the source language's own display name records another language's respelling at `name`, never at a display name it does not store", async () => {
		const doc = localizationWireFixture("prompts");
		const localization = doc.localization;
		if (localization === undefined)
			throw new Error("The prompts fixture holds two languages.");
		/* English first and the source, Spanish translating Nova's sentences, so Spanish never
		 * reads as the source, and an English display name other than `name` is the fold's. */
		doc.localization = {
			...localization,
			defaultLanguage: "eng" as LanguageTag,
			languageOrder: ["eng", "spa"] as LanguageTag[],
		};
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const { draft } = await read(doc, (body) => {
			body.name = "Health app  ";
			const translations = body.translations as Record<string, JsonObject>;
			expect(translations.es?.["app.display.name"]).toBeUndefined();
			translations.en = {
				...translations.en,
				"app.display.name": "Health override",
			};
		});
		expect(draft.doc.appName).toBe("Health override");
		expect(
			draft.facts.sameStateRewrites.filter(
				(record) =>
					record.path === "/name" || record.path.endsWith("/app.display.name"),
			),
		).toEqual([
			{
				entry: "application-and-settings/name",
				path: "/name",
				register: "names-respelled",
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

	it("over the two characters `\\n` is held as the line break a device shows there", async () => {
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
		).toBe("Nom\nbre");
		// No worker reads another header: HQ's build writes the line break as those two characters.
		expect(
			draft.facts.sameStateRewrites.filter(
				(record) => record.register === "text-spaces-dropped",
			),
		).toEqual([]);
	});

	it("whose rest after a carriage return defines another app string is refused at the key, under that entry", async () => {
		const body = exportedBody(PROMPTS);
		const translations = body.translations as Record<string, JsonObject>;
		translations.es = {
			...translations.es,
			[SHORT_HEADER]: "Nombre\rmodules.m0=Otro",
			[LONG_HEADER]: "Nombre\rmodules.m0=Otro",
		};
		const outcome = readHqApp({
			...(await inputFor(body)),
			appStrings: headerStrings,
		});
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		if (outcome.kind !== "account") return;
		// Both keys stand at the app and name one string: one finding.
		expect(
			outcome.findings
				.filter((one) => one.code === LINE_END_ENTRY)
				.map((one) => one.detail?.name),
		).toEqual(["modules.m0"]);
		expect(
			outcome.findings.filter(
				(one) =>
					one.detail?.name === SHORT_HEADER || one.detail?.name === LONG_HEADER,
			),
		).toEqual([]);
	});
});

describe("a case list menu item's label Nova's gate admits no spelling of", () => {
	it("is refused at the case list, and the item's other keys are still read", async () => {
		const body = exportedBody(menuItemDoc());
		const path = ["modules", 0, "case_list"] as const;
		const caseList = get(body, path) as JsonObject;
		// A character XML 1.0 cannot carry, which Nova's gate admits in no app text.
		caseList.label = { es: "To\u0001dos", en: "All patients" };
		caseList.custom_icons = [{ form: "badge", text: {}, xpath: "1" }];
		const outcome = readHqApp(await inputFor(body));
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		if (outcome.kind !== "account") return;
		const atCaseList = outcome.findings.filter(
			(one) => one.place.kind === "case-list",
		);
		// One finding names the label, under the entry that says what is wrong with it, and
		// `custom_icons` is refused by its own entry, never left unclaimed.
		expect(
			atCaseList.filter((one) => one.code === CHARACTER_ENTRY),
		).toHaveLength(1);
		expect(
			atCaseList.find((one) => one.code === CHARACTER_ENTRY)?.detail?.name,
		).toBe("To\u0001dos");
		expect(atCaseList.filter((one) => one.code === "unrecognized")).toEqual([]);
	});
});

describe("an app string whose rest after a carriage return defines another app string", () => {
	// HQ's build leaves a carriage return in the line it writes (`dumps`), and Core reads the rest
	// as a line of its own, `modules.m0=Hacked` setting the first menu's name.
	const cases: readonly {
		readonly title: string;
		readonly doc: BlueprintDoc;
		readonly at: readonly Path[];
		/** Where each stored text is refused: each is an app string of its own. */
		readonly places: readonly string[];
	}[] = [
		{
			title: "a menu's name",
			doc: PROMPTS,
			at: [["modules", 0, "name"]],
			places: ["menu"],
		},
		{
			title: "a form's name",
			doc: PROMPTS,
			at: [["modules", 0, "forms", 0, "name"]],
			places: ["form"],
		},
		{
			title: "a column's header",
			doc: PROMPTS,
			at: SURFACES.header.at,
			places: ["case-list", "case-detail"],
		},
		{
			title: "a Search field's label",
			doc: PROMPTS,
			at: [[...SEARCH, "properties", 0, "label"]],
			places: ["search"],
		},
		{
			title: "a case list menu item's label",
			doc: menuItemDoc(),
			at: [["modules", 0, "case_list", "label"]],
			places: ["case-list"],
		},
	];
	for (const one of cases)
		it(`in ${one.title} is refused at its place under that entry alone`, async () => {
			const body = exportedBody(one.doc);
			for (const path of one.at) {
				const map = (get(body, path) ?? {}) as Texts;
				set(body, path, { ...map, es: "Uno\rmodules.m0=Hacked" });
			}
			const outcome = readHqApp(await inputFor(body));
			expect(outcome.defects).toEqual([]);
			expect(outcome.kind).toBe("account");
			if (outcome.kind !== "account") return;
			expect(
				outcome.findings.map((finding) => [
					finding.code,
					finding.place.kind,
					finding.detail?.name,
				]),
			).toEqual(
				one.places.map((place) => [LINE_END_ENTRY, place, "modules.m0"]),
			);
		});

	// HQ fixes a Register label a language holds blank, recorded under its own register, so the
	// refusal cannot ride on the text's respelling record.
	it("in a Register button's label beside a language HQ's build fills is refused at the case list", async () => {
		const body = exportedBody(registrationDoc());
		set(body, ["modules", 1, "case_list_form", "label"], {
			en: "",
			es: "Nuevo\rmodules.m0=Hacked",
		});
		const outcome = readHqApp(await inputFor(body));
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		if (outcome.kind !== "account") return;
		expect(
			outcome.findings.map((finding) => [
				finding.code,
				finding.place.kind,
				finding.detail?.name,
			]),
		).toEqual([[LINE_END_ENTRY, "case-list", "modules.m0"]]);
	});

	// Where a language's text shows none of itself (nothing before the carriage return), Nova
	// holds no spelling of the label, and its rest defines another app string: one finding at the
	// case list under that entry, as a menu's name is, whether or not another language holds the
	// blank HQ's build fills.
	it("in a Register button's label a device shows none of is refused at the case list alone, beside a language HQ's build fills too", async () => {
		for (const label of [
			{ en: "", es: "\rmodules.m0=X" },
			{ en: "New patient", es: "\rmodules.m0=X" },
		]) {
			const body = exportedBody(registrationDoc());
			set(body, ["modules", 1, "case_list_form", "label"], label);
			const outcome = readHqApp(await inputFor(body));
			expect(outcome.defects).toEqual([]);
			expect(outcome.kind).toBe("account");
			if (outcome.kind !== "account") return;
			expect(
				outcome.findings.map((finding) => [
					finding.code,
					finding.place.kind,
					finding.detail?.name,
				]),
			).toEqual([[LINE_END_ENTRY, "case-list", "modules.m0"]]);
		}
	});

	// HQ's build writes every non-empty value of an app language's translations into its file,
	// whatever the key names (`SelectKnownAppStrings.app_strings_parts`, `non_empty_only`).
	const translationCases: readonly {
		readonly title: string;
		readonly language: string;
		readonly key: string;
	}[] = [
		{
			title:
				"the source language's app display name, which a reading takes as the app's name",
			language: "en",
			key: "app.display.name",
		},
		{
			title: "a translation of a key no runtime reads",
			language: "es",
			key: "zz.not.a.string",
		},
		{
			title:
				"a translation of a generated key that names no string of this app",
			language: "es",
			key: "m0.case_short.case_nothing_9.header",
		},
	];
	// A value a device shows none of (nothing before the carriage return) is refused here too:
	// the rest is checked before the text is held.
	for (const one of translationCases)
		it(`in ${one.title} is refused at the key under that entry, a value a device shows none of included`, async () => {
			for (const value of ["Salud\rmodules.m0=Hacked", "\rmodules.m0=Hacked"]) {
				const body = exportedBody(PROMPTS);
				const translations = body.translations as Record<string, JsonObject>;
				translations[one.language] = {
					...translations[one.language],
					[one.key]: value,
				};
				const outcome = readHqApp({
					...(await inputFor(body)),
					appStrings: () => ({ languages: { es: {}, en: {} }, units: {} }),
				});
				expect(outcome.defects).toEqual([]);
				expect(outcome.kind).toBe("account");
				if (outcome.kind !== "account") return;
				expect(
					outcome.findings.map((finding) => [
						finding.code,
						finding.place.kind,
						finding.detail?.name,
					]),
				).toEqual([[LINE_END_ENTRY, "app", "modules.m0"]]);
			}
		});

	it("in the app's name is refused at the app under that entry alone, a name a device shows none of included", async () => {
		for (const name of [
			"Health app\rmodules.m0=Hacked",
			"\rmodules.m0=Hacked",
		]) {
			const body = exportedBody(PROMPTS);
			body.name = name;
			const outcome = readHqApp(await inputFor(body));
			expect(outcome.defects).toEqual([]);
			expect(outcome.kind).toBe("account");
			if (outcome.kind !== "account") return;
			expect(
				outcome.findings.map((finding) => [
					finding.code,
					finding.place.kind,
					finding.detail?.name,
				]),
			).toEqual([[LINE_END_ENTRY, "app", "modules.m0"]]);
		}
	});

	// A text held at a slot is held through `heldText`, which admits no spelling of a text a
	// device shows none of; its rest defines another app string, so it is that entry's one
	// finding (`heldText.ts::unheldRefusal`).
	it("in a menu's name a device shows none of is refused at the menu under that entry alone", async () => {
		const body = exportedBody(PROMPTS);
		const path: Path = ["modules", 0, "name"];
		set(body, path, {
			...((get(body, path) ?? {}) as Texts),
			es: "\rmodules.m0=Hacked",
		});
		const outcome = readHqApp(await inputFor(body));
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		if (outcome.kind !== "account") return;
		expect(
			outcome.findings.map((finding) => [
				finding.code,
				finding.place.kind,
				finding.detail?.name,
			]),
		).toEqual([[LINE_END_ENTRY, "menu", "modules.m0"]]);
	});
});

describe("a name a device shows with a line break where CommCare HQ stores `\\n`", () => {
	it("in a form's name writes the line break into the form's title and data node, which no screen shows", async () => {
		const { draft } = await read(PROMPTS, (body) => {
			set(body, ["modules", 0, "forms", 0, "name"], {
				es: "Visita\\nhoy",
				en: "Visit\\nnow",
			});
		});
		expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const formUuid =
			draft.doc.formOrder[draft.doc.moduleOrder[0] as string]?.[0];
		// The default language, Spanish, names the form in its own source.
		expect(formWireName(draft.doc, formUuid as Uuid)).toBe("Visita\nhoy");
	});

	// HQ's build writes `name` as stored into the profile's `name` attribute, which Android's list of
	// the apps on a phone shows (kxml2 reads a carriage return there as a space), and Web Apps' list
	// of apps shows the app's `name` as stored, while the app's own screens show the app strings as
	// Core reads them: the lists show one text and the screens another, and no one name Nova writes
	// into both gives both back. One finding, under its own entry.
	it("in the app's `name` is refused at the app: the lists of apps show the name otherwise than the app's screens", async () => {
		for (const name of ["Health\\napp", "Health app \\#1", "Health\rapp"]) {
			const body = exportedBody(PROMPTS);
			body.name = name;
			const outcome = readHqApp(await inputFor(body));
			expect(outcome.defects).toEqual([]);
			expect(outcome.kind).toBe("account");
			if (outcome.kind !== "account") return;
			expect(
				outcome.findings.map((finding) => [
					finding.code,
					finding.place.kind,
					finding.detail?.name,
				]),
			).toEqual([[APP_NAME_ENTRY, "app", name]]);
		}
	});

	// A line break inside the name shows as a space in the lists of apps (the profile's attribute,
	// Web Apps' tile) and as a line break on the app's screens, but that is no change a reading
	// makes: Nova writes the source's `name` and app strings again, so HQ's build of Nova's publish
	// gives the profile and the app strings HQ's build of the source gave.
	it("a line break inside the app's `name` is held, and Nova writes the same name and app strings again", async () => {
		const { body, draft } = await read(PROMPTS, (body) => {
			body.name = "Health\napp";
		});
		expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(draft.doc.appName).toBe("Health\napp");
		const again = republished(draft.doc);
		// The profile's `name` and Web Apps' list of apps read `name` as stored.
		expect(again.name).toBe(body.name);
		const appStrings = (doc: JsonObject): Texts => {
			const translations = (doc.translations ?? {}) as Record<
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
								: (doc.name as string),
						),
					];
				}),
			);
		};
		expect(appStrings(again)).toEqual(appStrings(body));
		expect(appStrings(again)).toEqual({ es: "Health\napp", en: "Health\napp" });
	});

	// HQ's build writes the name into the profile and the app strings as it is, and Core reads
	// both as text, but Nova's gate admits the character in no app text.
	it("in the app's `name`, a character XML cannot carry is one finding at the app under its own entry", async () => {
		const body = exportedBody(PROMPTS);
		body.name = "Health\u0001app";
		const outcome = readHqApp(await inputFor(body));
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		if (outcome.kind !== "account") return;
		expect(
			outcome.findings.map((finding) => [
				finding.code,
				finding.place.kind,
				finding.detail?.name,
			]),
		).toEqual([[CHARACTER_ENTRY, "app", "Health\u0001app"]]);
	});
});

/**
 * The string CommCare Core reads for `key` from an `app_strings.txt`, as
 * `LocalizationUtils.parseLocaleInput` reads it at the pin: each line ended at a line break or
 * a carriage return, trimmed, a `#` no backslash precedes and what follows it dropped, the key
 * before the first `=`, and the value after it with `\#` read as `#` and then `\n` as a line
 * break. A later line for one key wins.
 */
function coreAppString(file: string, key: string): string | undefined {
	let found: string | undefined;
	for (const raw of file.split(/\r\n|\r|\n/)) {
		// Java's `String.trim()`: every character up to U+0020 at both ends.
		let start = 0;
		let end = raw.length;
		while (start < end && raw.charCodeAt(start) <= 0x20) start += 1;
		while (end > start && raw.charCodeAt(end - 1) <= 0x20) end -= 1;
		let line = raw.slice(start, end);
		let dec = line.length;
		for (;;) {
			const at = line.slice(0, dec).lastIndexOf("#");
			if (at === -1) break;
			if (at === 0 || line[at - 1] !== "\\") {
				line = line.slice(0, at);
				dec = line.length;
			} else dec = at;
		}
		const equal = line.indexOf("=");
		if (equal === -1 || equal === line.length - 1) continue;
		if (line.slice(0, equal) !== key) continue;
		found = line
			.slice(equal + 1)
			.split("\\#")
			.join("#")
			.split("\\n")
			.join("\n");
	}
	return found;
}

describe("a menu's name read with a backslash before `#`, printed into Nova's own archive", () => {
	it("shows on a device what HQ's build of the source showed", async () => {
		const { body, draft } = await read(PROMPTS, (body) => {
			set(body, ["modules", 0, "name"], {
				es: "Visitas \\#1",
				en: "Visits \\#1 and #2",
			});
		});
		expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const before = shows(get(body, ["modules", 0, "name"]));
		expect(before).toEqual({ es: "Visitas #1", en: "Visits #1 and #2" });
		const zip = new AdmZip(
			compileCcz(expandDoc(draft.doc), draft.doc.appName, draft.doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		for (const lang of LANGS)
			expect(
				coreAppString(zip.readAsText(`${lang}/app_strings.txt`), "modules.m0"),
			).toBe(before[lang]);
	});
});

/** The entries an app string Nova's gate admits no spelling of is refused under. */
const SHOWS_NOTHING_ENTRY =
	"application-and-settings/app-text-holding-a-carriage-return-before-which-a-device-shows-nothing";
const BACKSLASH_ENTRY =
	"application-and-settings/app-text-a-device-shows-with-a-backslash-before-hash";
const PLACEHOLDER_ENTRY =
	"application-and-settings/name-or-label-holding-a-placeholder-a-screen-fills";

/** Each held text's surface, the language whose text a case replaces, and where its finding
 *  stands, one place for each stored map. */
const UNHELD_SURFACES: readonly {
	readonly surface: Surface;
	readonly lang: string;
	readonly places: readonly string[];
	/** Whether some screen reads the text through Core's argument filler. */
	readonly argumentScreen: boolean;
}[] = [
	{
		surface: SURFACES.menuName,
		lang: "es",
		places: ["menu"],
		argumentScreen: true,
	},
	{
		surface: SURFACES.formName,
		lang: "es",
		places: ["form"],
		argumentScreen: true,
	},
	{
		surface: SURFACES.header,
		lang: "es",
		places: ["case-list", "case-detail"],
		argumentScreen: false,
	},
	{
		surface: SURFACES.label,
		lang: "es",
		places: ["search"],
		argumentScreen: true,
	},
	{
		surface: SURFACES.hint,
		lang: "es",
		places: ["search"],
		argumentScreen: false,
	},
	{
		surface: SURFACES.required,
		lang: "es",
		places: ["search"],
		argumentScreen: false,
	},
	{
		surface: SURFACES.validation,
		lang: "es",
		places: ["search"],
		argumentScreen: false,
	},
	{
		surface: SURFACES.title,
		lang: "es",
		places: ["search"],
		argumentScreen: false,
	},
	{
		surface: SURFACES.description,
		lang: "es",
		places: ["search"],
		argumentScreen: false,
	},
	{
		surface: SURFACES.mapping,
		lang: "fr",
		places: ["case-list", "case-detail"],
		argumentScreen: false,
	},
	{
		surface: SURFACES.menuItem,
		lang: "es",
		places: ["case-list"],
		argumentScreen: true,
	},
	{
		surface: SURFACES.register,
		lang: "es",
		places: ["case-list"],
		argumentScreen: true,
	},
];

/**
 * A text Nova knows and knowingly cannot hold is one finding at the text's place, under the
 * entry that says what is wrong with it, never `unrecognized` and never a finding of what holds
 * it: a text a device shows none of (nothing before a carriage return, whose rest defines no app
 * string), a text a device shows with a backslash before `#` (two backslashes then `#` are left
 * by `dumps` and shown by Core as one backslash then `#`, which only a text holding a backslash
 * before `#` spells, and the gate admits none), a `${` a screen of the text's role fills, and a
 * character XML 1.0 cannot carry, which the gate admits in no app text.
 */
describe("an app string Nova's gate admits no spelling of", () => {
	const shapes = [
		{
			title: "a device shows none of",
			text: "\rUno",
			entry: SHOWS_NOTHING_ENTRY,
		},
		{
			title: "a device shows with a backslash before `#`",
			text: "Nombre \\\\#",
			entry: BACKSLASH_ENTRY,
		},
		{
			title: "holding a `${` some screen fills",
			text: `Visitas \${0}`,
			entry: PLACEHOLDER_ENTRY,
		},
		{
			title: "holding a character XML cannot carry",
			text: "Nom\u0001bre",
			entry: CHARACTER_ENTRY,
		},
	] as const;
	for (const shape of shapes)
		for (const one of UNHELD_SURFACES) {
			if (shape.entry === PLACEHOLDER_ENTRY && !one.argumentScreen) continue;
			it(`${shape.title}, in ${one.surface.title}, is one finding at its place under its entry`, async () => {
				const body = exportedBody(one.surface.doc);
				for (const path of one.surface.at) {
					const map = (get(body, path) ?? {}) as Texts;
					set(body, path, { ...map, [one.lang]: shape.text });
				}
				const outcome = readHqApp(await inputFor(body));
				expect(outcome.defects).toEqual([]);
				expect(outcome.kind).toBe("account");
				if (outcome.kind !== "account") return;
				expect(
					outcome.findings.map((finding) => [
						finding.code,
						finding.place.kind,
						finding.detail?.name,
					]),
				).toEqual(one.places.map((place) => [shape.entry, place, shape.text]));
			});
		}
});

/**
 * Android's menu list, its Register button and Search field labels, and every screen title read
 * a menu's or form's name and those labels through Core's argument filler
 * (`Localizer.processArguments`, `localeFile.ts::argumentScreenIssue`), which shows
 * `Visitas ${0}` as `Visitas` there while Web Apps' menu list shows it as stored, so Nova holds
 * no text that shows alike on every screen. Every other app string no screen reads that way.
 */
describe("an app string a screen reads as a placeholder", () => {
	const PLACEHOLDER = `Visitas \${0}`;

	// The field stays in the reading, so the expressions of the other fields that read it bind,
	// and the prompt's other keys are read: the one text is the one finding.
	it("in a Search field's label is one finding at the search, and nothing else the search holds is a finding", async () => {
		const body = exportedBody(PROMPTS);
		for (const path of SURFACES.label.at) {
			const map = (get(body, path) ?? {}) as Texts;
			set(body, path, { ...map, es: PLACEHOLDER });
		}
		const outcome = readHqApp(await inputFor(body));
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		if (outcome.kind !== "account") return;
		expect(
			outcome.findings.map((finding) => [
				finding.code,
				finding.place.kind,
				finding.detail?.name,
			]),
		).toEqual([[PLACEHOLDER_ENTRY, "search", PLACEHOLDER]]);
	});

	it("in a menu's name that starts with a placeholder opener no } follows, which every screen shows as stored, is held as it is", async () => {
		const opening = `\${Visitas`;
		const { body, draft } = await read(PROMPTS, (body) => {
			const path = SURFACES.menuName.at[0];
			set(body, path, { ...((get(body, path) ?? {}) as Texts), es: opening });
		});
		expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(shows(get(republished(draft.doc), SURFACES.menuName.at[0]))).toEqual(
			shows(get(body, SURFACES.menuName.at[0])),
		);
	});

	for (const surface of [
		SURFACES.header,
		SURFACES.hint,
		SURFACES.description,
	] as const)
		it(`in ${surface.title}, which no screen reads as a placeholder, is held as a device shows it`, async () => {
			const { body, draft } = await read(surface.doc, (body) => {
				for (const path of surface.at) {
					const map = (get(body, path) ?? {}) as Texts;
					set(body, path, { ...map, es: PLACEHOLDER });
				}
			});
			expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			const path = surface.at[0];
			expect(surface.shows(get(republished(draft.doc), path))).toEqual(
				surface.shows(get(body, path)),
			);
		});
});

/**
 * A text compared with HQ's default is compared as a device shows it in every language: the
 * Search button's label is `clean_trans` of its map, so a space at its end, the default in a
 * second language or a language the map lacks all show "Search All Cases", which Nova writes as
 * `{en: "Search All Cases"}`. The search screen's title is blank where a device shows it blank,
 * not where JavaScript's trim does.
 */
describe("a Search text compared with what CommCare HQ shows", () => {
	const BUTTON = [...SEARCH, "search_button_label"] as const;
	const buttonRecords = (
		records: readonly { path: string; register: string }[],
	) => records.filter((one) => one.path === pointer(BUTTON));

	it("reads the Search button's default spelled another way as the default, and records the respelling", async () => {
		for (const label of [
			{ en: "Search All Cases " },
			{ es: "Search All Cases", en: "Search All Cases" },
			{ es: "Search All Cases" },
		]) {
			const { draft } = await read(PROMPTS, (body) => {
				set(body, BUTTON, label);
			});
			expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			expect(buttonRecords(draft.facts.sameStateRewrites)).toEqual([
				{
					entry:
						"case-search/search-button-label-hq-default-en-search-all-cases",
					path: pointer(BUTTON),
					register: "list-settings-respelled",
				},
			]);
			// Nova's export shows the default in every language.
			expect(shows(get(republished(draft.doc), BUTTON))).toEqual({
				es: "Search All Cases",
				en: "Search All Cases",
			});
		}
	});

	it("records nothing for the Search button's label as Nova writes it", async () => {
		const { draft } = await read(PROMPTS, () => {});
		expect(buttonRecords(draft.facts.sameStateRewrites)).toEqual([]);
	});

	it("refuses a Search button's label whose rest after a carriage return defines another app string", async () => {
		const body = exportedBody(PROMPTS);
		set(body, BUTTON, { en: "Search All Cases\rmodules.m0=Hacked" });
		const outcome = readHqApp(await inputFor(body));
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		if (outcome.kind !== "account") return;
		expect(
			outcome.findings.map((finding) => [
				finding.code,
				finding.place.kind,
				finding.detail?.name,
			]),
		).toEqual([[LINE_END_ENTRY, "search", "modules.m0"]]);
	});

	it("refuses a search title whose rest after a carriage return defines another app string, a title a device shows blank included", async () => {
		for (const title of [
			{ es: "Buscar\rmodules.m0=Hacked", en: "Search" },
			{ es: "\rmodules.m0=Hacked", en: "" },
		]) {
			const body = exportedBody(PROMPTS);
			set(body, [...SEARCH, "title_label"], title);
			const outcome = readHqApp(await inputFor(body));
			expect(outcome.defects).toEqual([]);
			expect(outcome.kind).toBe("account");
			if (outcome.kind !== "account") return;
			expect(
				outcome.findings.map((finding) => [
					finding.code,
					finding.place.kind,
					finding.detail?.name,
				]),
			).toEqual([[LINE_END_ENTRY, "search", "modules.m0"]]);
		}
	});

	// A title whose line defines no string is no blank title: a device shows the default table's
	// text there, and where the first language's line defines none, that table holds none, so a
	// language whose line defines one fails to load and the rest fail at the search screen. Held as
	// no title, it would print a blank title workers never met; held as no blank, it is one finding.
	for (const { title, finding } of [
		{
			title: { es: "\rUno", en: "\rDos" },
			finding: [SHOWS_NOTHING_ENTRY, "search", "\rDos"],
		},
		{
			title: { es: "Hola", en: "\rDos" },
			finding: [SHOWS_NOTHING_ENTRY, "search", "\rDos"],
		},
		{
			title: { es: "\u0001", en: "\u0001" },
			finding: [CHARACTER_ENTRY, "search", "\u0001"],
		},
	])
		it(`gives one finding for a search title whose line defines no string in some language, ${JSON.stringify(title)}`, async () => {
			const body = exportedBody(PROMPTS);
			set(body, [...SEARCH, "title_label"], title);
			const outcome = readHqApp(await inputFor(body));
			expect(outcome.defects).toEqual([]);
			expect(outcome.kind).toBe("account");
			if (outcome.kind !== "account") return;
			expect(
				outcome.findings.map((one) => [
					one.code,
					one.place.kind,
					one.detail?.name,
				]),
			).toEqual([finding]);
		});

	it("reads a search title a device shows blank in every language as no title, though JavaScript's trim keeps it", async () => {
		const { draft } = await read(PROMPTS, (body) => {
			set(body, [...SEARCH, "title_label"], { es: "\u001f", en: "\u001c" });
		});
		expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const config =
			draft.doc.modules[draft.doc.moduleOrder[0] as string]?.caseSearchConfig;
		expect(
			config !== undefined && "searchScreenTitle" in config
				? config.searchScreenTitle
				: undefined,
		).toEqual(NO_SEARCH_SCREEN_TITLE);
	});

	it("leaves a search title a device shows (U+FEFF) and Nova reads as blank unrecognized, never no title", async () => {
		const body = exportedBody(PROMPTS);
		set(body, [...SEARCH, "title_label"], { es: "﻿", en: "﻿" });
		const outcome = readHqApp(await inputFor(body));
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		if (outcome.kind !== "account") return;
		expect(
			outcome.findings.map((finding) => [
				finding.code,
				finding.place.kind,
				finding.detail?.name,
			]),
		).toEqual([["unrecognized", "search", "schema:CaseSearch.title_label"]]);
	});
});

/**
 * A choice's label folded from an app translation is held as a device shows it, as a text unit's
 * fold is: the two characters `\n` a line break, the text before a carriage return whose rest
 * defines no string, no space at either end. The failure it catches: such a fold refused as
 * wording Nova cannot hold, or folded raw into a document the gate refuses.
 */
describe("an app translation folded over a choice's label", () => {
	const KEY = "m0.case_short.case_stage_1.enum.ka";
	const UNIT = casePropertyOptionTranslationUnitId("patient", "stage", "a");
	const fra = "fra" as LanguageTag;
	const optionDoc = (): BlueprintDoc => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "stage",
							label: "Stage",
							data_type: "single_select",
							options: [{ value: "a", label: "Active" }],
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "single_select",
									id: "stage",
									label: "Stage",
									options: [{ value: "a", label: "Active" }],
									caseWrite: { caseType: "patient", property: "stage" },
								}),
							],
						},
					],
					// A list column over the property is what makes its choices' labels app strings.
					caseListConfig: {
						columns: [
							plainColumn(uuid(1), "case_name", "Name"),
							plainColumn(uuid(2), "stage", "Stage"),
						],
						searchInputs: [],
					},
				},
			],
		});
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
	};
	/** Nova's build of the choice's label under one generated key, the unit's text in each
	 *  language. */
	const optionStrings = (): AppStringTable => ({
		languages: { en: { [KEY]: "Active" }, fr: { [KEY]: "Active" } },
		units: { [KEY]: UNIT },
	});
	const fold = async (value: string) => {
		const body = exportedBody(optionDoc());
		const translations = body.translations as Record<string, JsonObject>;
		translations.fr = { ...translations.fr, [KEY]: value };
		const outcome = readHqApp({
			...(await inputFor(body)),
			appStrings: optionStrings,
		});
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(
				JSON.stringify(outcome.findings.map((one) => [one.code, one.detail])),
			);
		const draft = outcome.draft;
		expect(draft.facts.foldedTranslationKeys).toBe(1);
		expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		return {
			value: (
				draft.doc.localization?.translations[fra] as
					| Record<string, { value: unknown }>
					| undefined
			)?.[UNIT]?.value,
			workerRecords: draft.facts.sameStateRewrites.filter(
				(record) => record.register === "text-spaces-dropped",
			),
		};
	};

	it("over the two characters `\\n` is held as the line break a device shows, which no worker reads otherwise", async () => {
		const read = await fold("Act\\nive");
		expect(read.value).toEqual(proseText("Act\nive"));
		expect(read.workerRecords).toEqual([]);
	});

	it("over a backslash before `#` is held as the `#` a device shows, which no worker reads otherwise", async () => {
		const read = await fold("Act\\#ive");
		expect(read.value).toEqual(proseText("Act#ive"));
		expect(read.workerRecords).toEqual([]);
	});

	it("with a carriage return whose rest defines no string is held as the text before it", async () => {
		const read = await fold("Activo\rtodavía activo");
		expect(read.value).toEqual(proseText("Activo"));
		expect(read.workerRecords).toEqual([]);
	});

	it("with a space at its start is held without it, which workers then read, recorded at the key", async () => {
		const read = await fold(" Activo");
		expect(read.value).toEqual(proseText("Activo"));
		expect(read.workerRecords).toEqual([
			{
				entry:
					"application-and-settings/translations-generated-key-over-one-text",
				path: `/translations/fr/${KEY}`,
				register: "text-spaces-dropped",
			},
		]);
	});
});
