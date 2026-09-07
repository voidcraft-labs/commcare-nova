/** Parsed artifact structure and emitted locale records. Native HQ/Core proof
 * consumes these same admitted scenarios for actual text resolution. */
import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { findAll, textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { makeTranslationUnitId } from "@/lib/domain";
import { compileCcz } from "../compiler";
import { expandDoc } from "../expander";
import {
	localizationScenarios,
	localizationWireFixture,
} from "./localizationWireFixture";

function elements(xml: string, name: string) {
	return findAll(
		(e) => e.name === name,
		parseDocument(xml, { xmlMode: true }).children,
	);
}
function itextValue(node: import("domhandler").Element) {
	return textContent(
		node.children.filter(
			(c) => isTag(c) && c.name === "value" && c.attribs.form === undefined,
		),
	);
}
function serializedRecord(text: string, key: string) {
	return text
		.split("\n")
		.find((line) => line.startsWith(`${key}=`))
		?.slice(key.length + 1);
}
describe("localized emitted artifacts", () => {
	it.each(localizationScenarios)(
		"joins every locale identity across %s artifacts without changing the source",
		(scenario) => {
			const doc = localizationWireFixture(scenario),
				before = structuredClone(doc),
				hq = expandDoc(doc),
				zip = new AdmZip(compileCcz(hq, doc.appName, doc));
			const languages =
				scenario === "mandarin" ? ["en", "cmn-hans", "cmn-hant"] : ["es", "en"];
			expect(hq.langs).toEqual(languages);
			const locales = elements(zip.readAsText("suite.xml"), "locale").filter(
				(e) => e.attribs.language !== undefined,
			);
			expect(locales.map((e) => e.attribs.language)).toEqual([
				"default",
				...languages,
			]);
			for (const locale of locales) {
				const language = locale.attribs.language;
				const resource = locale.children.find(isTag);
				expect(resource && isTag(resource) && resource.attribs).toEqual({
					id: `app_strings_${language}`,
					version: "1",
				});
				const location =
					resource && isTag(resource) && resource.children.find(isTag);
				expect(location && textContent(location)).toBe(
					`./${language}/app_strings.txt`,
				);
				expect(zip.getEntry(`${language}/app_strings.txt`)).not.toBeNull();
			}
			const translations = elements(
				zip.readAsText("modules-0/forms-0.xml"),
				"translation",
			);
			expect(translations.map((e) => e.attribs.lang)).toEqual(languages);
			expect(
				translations
					.filter((e) => "default" in e.attribs)
					.map((e) => e.attribs.lang),
			).toEqual([languages[0]]);
			expect(zip.readAsText("default/app_strings.txt")).toBe(
				zip.readAsText(`${languages[0]}/app_strings.txt`),
			);
			for (const language of languages) {
				const text = zip.readAsText(`${language}/app_strings.txt`);
				expect(serializedRecord(text, "lang.current")).toBe(language);
				for (const code of languages)
					expect(serializedRecord(text, code)).toBe(
						hq.translations[language][code],
					);
				const ids = translations
					.find((t) => t.attribs.lang === language)
					?.children.filter(isTag)
					.map((t) => t.attribs.id);
				expect(new Set(ids).size).toBe(ids?.length);
			}
			expect(doc).toEqual(before);
		},
	);
	it("projects translated and fallback labels to their exact JSON maps and itext IDs", () => {
		const doc = localizationWireFixture("bilingual"),
			hq = expandDoc(doc);
		expect(hq.modules[0].name).toEqual({ es: "Pacientes", en: "Patients" });
		expect(hq.modules[0].forms[0].name).toEqual({
			es: "Registrar",
			en: "Register",
		});
		expect(hq.modules[0].case_details.short.columns[0].header).toEqual({
			es: "Edad",
			en: "Age",
		});
		const xml = new AdmZip(compileCcz(hq, doc.appName, doc)).readAsText(
			"modules-0/forms-0.xml",
		);
		const labels = elements(xml, "translation").map((t) => ({
			lang: t.attribs.lang,
			label: t.children
				.filter(isTag)
				.filter((c) => c.attribs.id === "case_name-label")
				.map(itextValue)
				.join(""),
		}));
		expect(labels).toEqual([
			{ lang: "es", label: "Nombre" },
			{ lang: "en", label: "Name" },
		]);
		const mandarin = expandDoc(localizationWireFixture("mandarin"));
		expect(mandarin.modules[0].name).toEqual({
			en: "Patients",
			"cmn-hans": "Patients",
			"cmn-hant": "Patients",
		});
		expect(mandarin.translations["cmn-hans"]["homescreen.title"]).toBe(
			"健康应用",
		);
		expect(mandarin.translations["cmn-hant"]["homescreen.title"]).toBe(
			"健康應用",
		);
	});
	it("keeps target-only group, hint, help and constraint references attached to their owner", () => {
		const doc = localizationWireFixture("optional"),
			hq = expandDoc(doc),
			xml = new AdmZip(compileCcz(hq, doc.appName, doc)).readAsText(
				"modules-0/forms-0.xml",
			);
		const spanish = elements(xml, "translation").find(
			(t) => t.attribs.lang === "es",
		);
		if (!spanish) throw new Error("Missing Spanish itext");
		const values = Object.fromEntries(
			spanish.children.filter(isTag).map((t) => [t.attribs.id, itextValue(t)]),
		);
		expect(values).toMatchObject({
			"section-label": "Sección",
			"section-name-hint": "Pista",
			"section-name-help": "Ayuda",
			"section-name-constraintMsg": "Obligatorio",
		});
		expect(elements(xml, "group")[0].attribs).toEqual({
			ref: "/data/section",
			appearance: "field-list",
		});
		expect(elements(xml, "hint").map((e) => e.attribs.ref)).toEqual([
			"jr:itext('section-name-hint')",
		]);
		expect(elements(xml, "help").map((e) => e.attribs.ref)).toEqual([
			"jr:itext('section-name-help')",
		]);
		expect(
			elements(xml, "bind").find(
				(b) => b.attribs.nodeset === "/data/section/name",
			)?.attribs["jr:constraintMsg"],
		).toBe("jr:itext('section-name-constraintMsg')");
	});
	it("serializes comment and newline escapes and refuses the ambiguous literal backslash-n", () => {
		const doc = localizationWireFixture("escaped"),
			hq = expandDoc(doc),
			zip = new AdmZip(compileCcz(hq, doc.appName, doc));
		expect(
			serializedRecord(
				zip.readAsText("es/app_strings.txt"),
				"homescreen.title",
			),
		).toBe("Aplicación \\#1\\nSegunda línea");
		const entry =
			doc.localization?.translations.spa?.[
				makeTranslationUnitId("app", "name")
			];
		if (!entry) throw new Error("Missing app title translation");
		entry.value = String.raw`Aplicación \n literal`;
		expect(() => compileCcz(expandDoc(doc), doc.appName, doc)).toThrow(
			/literal sequence \\n/,
		);
	});
	it("emits source fallback for a stale translated title", () => {
		const hq = expandDoc(localizationWireFixture("stale"));
		expect(hq.translations.es["homescreen.title"]).toBe("Health app");
	});
	it("projects complete per-language Search child messages", () => {
		const hq = expandDoc(localizationWireFixture("prompts"));
		const [name, phone, status] = hq.modules[0].search_config.properties;
		expect(name.hint).toEqual({
			es: "Nombre y apellido",
			en: "First and last name",
		});
		expect(phone.required?.text).toEqual({
			es: "Indique un teléfono cuando falte el nombre.",
			en: "Give a phone when the name is blank.",
		});
		expect(status.validations?.[0]?.text.es).toBe(
			"Use solo letras minúsculas. Quite las comillas.",
		);
	});
});
