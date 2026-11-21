/**
 * A menu's and a form's name as CommCare HQ's build shows it, read and
 * printed back.
 *
 * Contract: a reading holds in each language the text HQ's build shows for a
 * name there (`app_strings.py::_create_custom_app_strings` calls
 * `clean_trans(name, [lang] + langs)`, a blank falls back to the `default`
 * locale, and a language's app translations lay their override over its
 * string), so the document's slot holds what the source language shows, and
 * Nova's export of the reading shows every language the same text, held as
 * Nova's gate admits it: a name that shows blank in a language beside a source
 * that does not takes the source's name there, and a space at a name's start
 * is dropped, each recorded under `text-spaces-dropped` because a worker reads
 * another name. A stored map Nova prints back exactly reads exactly and
 * records nothing; any other map is respelled by the first publish, and the
 * reading says so under `names-respelled`. A generated key folded over a name
 * in one language changes another language's text only where HQ's build
 * changes it too. The name checked for an `instance('…')` read is the one
 * `formWireName` writes into the form's source once the generated keys are
 * decided: the first language's, whatever the source language, an app
 * translation's wording there where one folds.
 *
 * Plausible failures: a name the source language lacks or holds blank read as
 * blank, so the builder shows a blank name every device shows text for; a
 * name of spaces read as a translation Nova's gate refuses; a source-language
 * override that becomes the text of a language that showed its own; a
 * respelling recorded nowhere, or a change workers see recorded as none; a
 * form refused for text its source never holds, or a form whose source would
 * hold an instance read read with no finding.
 */
import { describe, expect, it } from "vitest";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import { expandDoc } from "../../expander";
import { commCareLocalization } from "../../localization";
import { runValidation } from "../../validator/runner";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { cleanTrans } from "../hqText";
import { matchingResolver } from "../identity";
import { externalIdentityMap } from "../identityMap";
import { readHqApp } from "../index";
import type { AppStringTable } from "../types";
import { exportedBody, inputFor } from "./novaExport";

/** English the source, Spanish first: `langs` is `["es", "en"]`. */
const DOC = localizationWireFixture("bilingual");
const LANGS = ["es", "en"] as const;
const MODULE = DOC.moduleOrder[0] as Uuid;
const FORM = DOC.formOrder[MODULE]?.[0] as Uuid;

type Overrides = Readonly<Record<string, string | undefined>>;
type JsonObject = Record<string, unknown>;

/**
 * What each language of HQ's build shows for a name stored as `stored`, with
 * `overrides` the app translations' value of its key in each language
 * (`app_strings.py`): a language's own string is its non-empty override, else
 * `clean_trans(name, [lang] + langs)` (`SelectKnownAppStrings.app_strings_parts`
 * lays `non_empty_only(app.translations[lang])` last); a blank one is left to
 * the `default` locale (`create_custom_app_strings`' `non_empty_only`), which
 * holds the first language's own string that is not blank
 * (`create_default_app_strings`). Without overrides this is `shownText`.
 */
function hqShows(
	stored: unknown,
	overrides: Overrides = {},
): Record<string, string> {
	const own = (lang: string): string => {
		const override = overrides[lang];
		if (override !== undefined && override !== "") return override;
		const text = cleanTrans(stored, [lang, ...LANGS]);
		if (!text.ok) throw new Error("The test's maps hold text and null only.");
		return text.text;
	};
	const fallback = LANGS.map(own).find((text) => text !== "") ?? "";
	return Object.fromEntries(
		LANGS.map((lang) => [lang, own(lang) === "" ? fallback : own(lang)]),
	);
}

/** Nova's build of a document's names, in each language, through the production projection. */
function nameStrings(doc: BlueprintDoc): AppStringTable {
	const local = commCareLocalization(doc);
	const module = doc.moduleOrder[0] as Uuid;
	const form = doc.formOrder[module]?.[0] as Uuid;
	const moduleUnit = makeTranslationUnitId("module", module, "name");
	const formUnit = makeTranslationUnitId("form", form, "name");
	const moduleNames = local.textMap(moduleUnit);
	const formNames = local.textMap(formUnit);
	return {
		languages: Object.fromEntries(
			LANGS.map((lang) => [
				lang,
				{ "modules.m0": moduleNames[lang], "forms.m0f0": formNames[lang] },
			]),
		),
		units: { "modules.m0": moduleUnit, "forms.m0f0": formUnit },
	};
}

/** The fixture's export with its first menu's and form's name maps as given, and `overrides`
 *  laid over each language's app translations by key. */
function bodyWith(
	names: { readonly menu?: unknown; readonly form?: unknown },
	overrides: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
): JsonObject {
	const body = exportedBody(DOC, {
		modules: (modules) => {
			const menu = modules[0] as JsonObject;
			const form = (menu.forms as JsonObject[])[0] as JsonObject;
			if (names.menu !== undefined) menu.name = names.menu;
			if (names.form !== undefined) form.name = names.form;
			return modules;
		},
	});
	const translations = { ...(body.translations as Record<string, JsonObject>) };
	for (const [lang, keys] of Object.entries(overrides))
		translations[lang] = { ...translations[lang], ...keys };
	return { ...body, translations };
}

async function read(body: JsonObject) {
	const outcome = readHqApp(
		await inputFor(body, {
			resolver: matchingResolver(
				"app-1",
				externalIdentityMap(DOC, DERIVED_WIRE_IDENTITY),
			),
			recordDialect: recordDialectRoundTrip,
			appStrings: nameStrings,
		}),
	);
	expect(outcome.defects).toEqual([]);
	return outcome;
}

async function readDoc(body: JsonObject) {
	const outcome = await read(body);
	if (outcome.kind !== "read")
		throw new Error(
			`The app read to an account: ${outcome.findings.map((one) => one.code).join(", ")}`,
		);
	return outcome.draft;
}

/** The first menu's and form's name maps, and their keys' app translations, in `body`. */
function storedNames(body: JsonObject) {
	const menu = (body.modules as JsonObject[])[0] as JsonObject;
	const form = (menu.forms as JsonObject[])[0] as JsonObject;
	const translations = (body.translations ?? {}) as Record<string, JsonObject>;
	const overrides = (key: string): Overrides =>
		Object.fromEntries(
			LANGS.map((lang) => [
				lang,
				typeof translations[lang]?.[key] === "string"
					? (translations[lang]?.[key] as string)
					: undefined,
			]),
		);
	return {
		menu: { stored: menu.name, overrides: overrides("modules.m0") },
		form: { stored: form.name, overrides: overrides("forms.m0f0") },
	};
}

/** Nova's export of a reading's document, as HQ's import stores it. */
function republished(doc: BlueprintDoc): JsonObject {
	return JSON.parse(JSON.stringify(expandDoc(doc))) as JsonObject;
}

/** The register each name map's rewrite is recorded under, by its pointer. */
const nameRecords = (draft: {
	facts: { sameStateRewrites: readonly unknown[] };
}) =>
	draft.facts.sameStateRewrites.filter((one) =>
		["names-respelled", "text-spaces-dropped"].includes(
			(one as { register: string }).register,
		),
	);

/**
 * What a device or Web Apps shows for an app string HQ's build writes as
 * `text`, `""` for one that shows blank: `commcare_translations.py::dumps`
 * writes a text Python strips to nothing as one non-breaking space, and Core's
 * `LocalizationUtils.parseAndAdd` trims the line, dropping every character up
 * to U+0020 at the text's end. The test's texts hold ASCII spaces only.
 */
function onDevice(text: string): string {
	if (text.trim() === "") return "";
	let end = text.length;
	while (end > 0 && text.charCodeAt(end - 1) <= 0x20) end -= 1;
	return text.slice(0, end);
}

const onDevices = (shows: Readonly<Record<string, string>>) =>
	Object.fromEntries(
		Object.entries(shows).map(([lang, text]) => [lang, onDevice(text)]),
	);

describe("a menu's and a form's name map", () => {
	const cases: readonly {
		readonly title: string;
		readonly stored: JsonObject;
		/** What each language's devices show from the stored map. */
		readonly shows: Readonly<Record<string, string>>;
		/** What they show from Nova's export of the reading, where a worker reads another name. */
		readonly novaShows?: Readonly<Record<string, string>>;
		/** The register the first publish's rewrite of the map is recorded under, if any. */
		readonly register?: "names-respelled" | "text-spaces-dropped";
	}[] = [
		{
			title: "lacking the source language",
			stored: { es: "Pacientes" },
			shows: { es: "Pacientes", en: "Pacientes" },
			register: "names-respelled",
		},
		{
			title: "held only under a language the app no longer lists",
			stored: { fr: "Patients FR" },
			shows: { es: "Patients FR", en: "Patients FR" },
			register: "names-respelled",
		},
		{
			title: "holding null in the source language",
			stored: { es: "Pacientes", en: null },
			shows: { es: "Pacientes", en: "Pacientes" },
			register: "names-respelled",
		},
		{
			title: "blank in a language beside the source's text",
			stored: { es: "", en: "Patients" },
			shows: { es: "Patients", en: "Patients" },
			register: "names-respelled",
		},
		{
			title: "blank in the source language beside another language's text",
			stored: { es: "Pacientes", en: "" },
			shows: { es: "Pacientes", en: "Pacientes" },
			register: "names-respelled",
		},
		{
			title: "with spaces at the end of a language's name",
			stored: { es: "Pacientes  ", en: "Patients " },
			shows: { es: "Pacientes", en: "Patients" },
			register: "names-respelled",
		},
		{
			title: "only spaces in a language beside the source's text",
			stored: { es: "  ", en: "Patients" },
			shows: { es: "", en: "Patients" },
			novaShows: { es: "Patients", en: "Patients" },
			register: "text-spaces-dropped",
		},
		{
			title: "with a space at the start of a language's name",
			stored: { es: " Pacientes", en: "Patients" },
			shows: { es: " Pacientes", en: "Patients" },
			novaShows: { es: "Pacientes", en: "Patients" },
			register: "text-spaces-dropped",
		},
		{
			title: "only spaces in every language",
			stored: { es: " ", en: " " },
			shows: { es: "", en: "" },
		},
		{
			title: "as Nova prints it",
			stored: { es: "Pacientes", en: "Patients" },
			shows: { es: "Pacientes", en: "Patients" },
		},
	];

	for (const { title, stored, shows, novaShows, register } of cases)
		it(`${title} reads as what CommCare HQ's build shows, held as Nova's gate admits it`, async () => {
			const body = bodyWith({ menu: stored, form: stored });
			expect(onDevices(hqShows(stored))).toEqual(shows);
			const draft = await readDoc(body);
			expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			/* The slot holds what the source language shows, and Spanish a translation exactly where
			 * what it shows differs. */
			const spanish = (novaShows ?? shows).es;
			for (const [name, unit] of [
				[
					draft.doc.modules[MODULE]?.name,
					makeTranslationUnitId("module", MODULE, "name"),
				],
				[
					draft.doc.forms[FORM]?.name,
					makeTranslationUnitId("form", FORM, "name"),
				],
			] as const) {
				expect(onDevice(name ?? "")).toBe(shows.en);
				expect(draft.doc.localization?.translations.spa?.[unit]?.value).toBe(
					spanish === shows.en ? undefined : spanish,
				);
			}
			const again = storedNames(republished(draft.doc));
			for (const one of [again.menu, again.form])
				expect(onDevices(hqShows(one.stored, one.overrides))).toEqual(
					novaShows ?? shows,
				);
			expect(nameRecords(draft)).toEqual(
				register === undefined
					? []
					: [
							{
								entry: "menus-and-case-lists/modulebase-name",
								path: "/modules/0/name",
								register,
							},
							{
								entry: "forms-and-case-writes/name-lang",
								path: "/modules/0/forms/0/name",
								register,
							},
						],
			);
			/* A rewrite is recorded exactly where Nova's export stores another map. */
			expect(JSON.stringify(again.menu.stored) !== JSON.stringify(stored)).toBe(
				register !== undefined,
			);
		});

	it("lacking the source language holds the text HQ shows there in the document's own slot", async () => {
		const draft = await readDoc(
			bodyWith({ menu: { es: "Pacientes" }, form: { es: "Registrar" } }),
		);
		expect(draft.doc.modules[MODULE]?.name).toBe("Pacientes");
		expect(draft.doc.forms[FORM]?.name).toBe("Registrar");
		expect(
			draft.doc.localization?.translations.spa?.[
				makeTranslationUnitId("form", FORM, "name")
			],
		).toBeUndefined();
	});
});

describe("a generated key folded over a name", () => {
	it("in the source language leaves a language that showed its own text at that text", async () => {
		const body = bodyWith(
			{ menu: { en: "Patients" } },
			{ en: { "modules.m0": "Registration" } },
		);
		const before = storedNames(body).menu;
		expect(hqShows(before.stored, before.overrides)).toEqual({
			es: "Patients",
			en: "Registration",
		});
		const draft = await readDoc(body);
		expect(draft.facts.foldedTranslationKeys).toHaveLength(1);
		expect(draft.doc.modules[MODULE]?.name).toBe("Registration");
		const after = storedNames(republished(draft.doc)).menu;
		expect(hqShows(after.stored, after.overrides)).toEqual({
			es: "Patients",
			en: "Registration",
		});
	});

	it("in the source language reaches a language whose own text is blank, as HQ's default locale does", async () => {
		const body = bodyWith(
			{ menu: { es: "", en: "Patients" } },
			{ en: { "modules.m0": "Registration" } },
		);
		const before = storedNames(body).menu;
		expect(hqShows(before.stored, before.overrides)).toEqual({
			es: "Registration",
			en: "Registration",
		});
		const draft = await readDoc(body);
		const after = storedNames(republished(draft.doc)).menu;
		expect(hqShows(after.stored, after.overrides)).toEqual({
			es: "Registration",
			en: "Registration",
		});
	});

	it("in another language reaches the source language where its own text is blank", async () => {
		const body = bodyWith(
			{ menu: { es: "Pacientes", en: "" } },
			{ es: { "modules.m0": "Clientes" } },
		);
		const before = storedNames(body).menu;
		expect(hqShows(before.stored, before.overrides)).toEqual({
			es: "Clientes",
			en: "Clientes",
		});
		const draft = await readDoc(body);
		expect(draft.doc.modules[MODULE]?.name).toBe("Clientes");
		const after = storedNames(republished(draft.doc)).menu;
		expect(hqShows(after.stored, after.overrides)).toEqual({
			es: "Clientes",
			en: "Clientes",
		});
	});

	it("that words a name as only spaces gives that language the source's name, which workers then read", async () => {
		const body = bodyWith(
			{ menu: { es: "Pacientes", en: "Patients" } },
			{ es: { "modules.m0": "  " } },
		);
		const before = storedNames(body).menu;
		expect(onDevices(hqShows(before.stored, before.overrides))).toEqual({
			es: "",
			en: "Patients",
		});
		const draft = await readDoc(body);
		expect(draft.facts.foldedTranslationKeys).toHaveLength(1);
		expect(runValidation(draft.doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(nameRecords(draft)).toEqual([
			{
				entry: "menus-and-case-lists/modulebase-name",
				path: "/modules/0/name",
				register: "text-spaces-dropped",
			},
		]);
		const after = storedNames(republished(draft.doc)).menu;
		expect(onDevices(hqShows(after.stored, after.overrides))).toEqual({
			es: "Patients",
			en: "Patients",
		});
	});

	it("in the first language over a form's name that would hold an instance read is that form's finding", async () => {
		const outcome = await read(
			bodyWith({}, { es: { "forms.m0f0": "Visita instance('casedb')" } }),
		);
		if (outcome.kind !== "account")
			throw new Error("The folded form name should keep the app out.");
		expect(outcome.findings).toEqual([
			expect.objectContaining({
				code: "forms-and-case-writes/form-name-read-as-an-instance",
				place: expect.objectContaining({ kind: "form", menu: 0, form: 0 }),
				detail: { name: "instance('casedb')" },
			}),
		]);
	});
});

describe("a form's name read as an instance", () => {
	it("is the first language's, the one the form's source holds, where the source language is another", async () => {
		const outcome = await read(
			bodyWith({ form: { es: "Visita instance('casedb')", en: "Visit" } }),
		);
		if (outcome.kind !== "account")
			throw new Error("The form's name should keep the app out.");
		expect(outcome.findings).toEqual([
			expect.objectContaining({
				code: "forms-and-case-writes/form-name-read-as-an-instance",
				detail: { name: "instance('casedb')" },
			}),
		]);
	});

	it("is the first language's app translation where one words the name, which the source then holds", async () => {
		const body = bodyWith(
			{ form: { es: "Visita instance('casedb')", en: "Visit" } },
			{ es: { "forms.m0f0": "Visita" } },
		);
		const before = storedNames(body).form;
		expect(hqShows(before.stored, before.overrides)).toEqual({
			es: "Visita",
			en: "Visit",
		});
		const draft = await readDoc(body);
		expect(draft.facts.foldedTranslationKeys).toHaveLength(1);
		expect(draft.doc.forms[FORM]?.name).toBe("Visit");
		expect(
			draft.doc.localization?.translations.spa?.[
				makeTranslationUnitId("form", FORM, "name")
			]?.value,
		).toBe("Visita");
		const after = storedNames(republished(draft.doc)).form;
		expect(hqShows(after.stored, after.overrides)).toEqual({
			es: "Visita",
			en: "Visit",
		});
	});

	it("is the stored first-language name where the app translation over it does not fold, beside the finding that keeps it", async () => {
		const body = bodyWith(
			{ form: { es: "Visita instance('casedb')", en: "Visit" } },
			{ es: { "forms.m0f0": "Visita" } },
		);
		const menu = (body.modules as JsonObject[])[0] as JsonObject;
		((menu.forms as JsonObject[])[0] as JsonObject).nova_unknown_key = 1;
		const outcome = await read(body);
		if (outcome.kind !== "account")
			throw new Error("The form's name should keep the app out.");
		expect(outcome.findings.map((one) => one.code)).toContain(
			"forms-and-case-writes/form-name-read-as-an-instance",
		);
	});

	it("is not the source language's where the first language holds a name of its own", async () => {
		const draft = await readDoc(
			bodyWith({ form: { es: "Visita", en: "Visit instance('casedb')" } }),
		);
		expect(draft.doc.forms[FORM]?.name).toBe("Visit instance('casedb')");
		expect(draft.doc.localization?.sourceLanguage).toBe("eng");
	});
});
