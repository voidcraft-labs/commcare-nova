/** Parsed artifact structure and emitted locale records. Native HQ/Core proof
 * consumes these same admitted scenarios for actual text resolution. */
import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { findAll, textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { orderedFormUuids } from "@/lib/doc/fieldWalk";
import {
	makeTranslationUnitId,
	printProseTemplate,
	projectedModulePreorder,
	snapshotTranslationUnits,
	TRANSLATION_FILL_ROLES,
} from "@/lib/domain";
import { formWireName } from "@/lib/domain/formWireName";
import { proseText } from "@/lib/domain/prose";
import { compileCcz } from "../compiler";
import { emissionPlan } from "../emissionPlan";
import { expandDoc } from "../expander";
import { commCareLocalization } from "../localization";
import { validateXForm } from "../validator/xformOracle";
import { manifestFor } from "./compilerEvidence";
import { emissionFixtures } from "./emissionFixtures";
import {
	localizationScenarios,
	localizationWireFixture,
} from "./localizationWireFixture";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

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
				zip = new AdmZip(
					compileCcz(hq, doc.appName, doc, {
						runtimeTarget: TEST_RUNTIME_TARGET,
					}),
				);
			const languages =
				scenario === "mandarin" ? ["en", "zho", "cmn-hant"] : ["es", "en"];
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
						hq.translations?.[language]?.[code],
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
		const xml = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		).readAsText("modules-0/forms-0.xml");
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
			zho: "Patients",
			"cmn-hant": "Patients",
		});
		expect(mandarin.translations?.zho?.["homescreen.title"]).toBe("健康应用");
		expect(mandarin.translations?.["cmn-hant"]?.["homescreen.title"]).toBe(
			"健康應用",
		);
	});
	it("keeps target-only group, hint, help and constraint references attached to their owner", () => {
		const doc = localizationWireFixture("optional"),
			hq = expandDoc(doc),
			xml = new AdmZip(
				compileCcz(hq, doc.appName, doc, {
					runtimeTarget: TEST_RUNTIME_TARGET,
				}),
			).readAsText("modules-0/forms-0.xml");
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
			zip = new AdmZip(
				compileCcz(hq, doc.appName, doc, {
					runtimeTarget: TEST_RUNTIME_TARGET,
				}),
			);
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
		expect(() =>
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		).toThrow(/literal sequence \\n/);
	});
	it("leaves a stale translated title to HQ's build, and the archive's strings at the app's name", () => {
		const doc = localizationWireFixture("stale");
		const hq = expandDoc(doc);
		// A language whose name falls back to the app's name stores neither
		// app-name key: HQ's build writes both at the app's name itself.
		for (const key of ["homescreen.title", "app.display.name"])
			expect(Object.hasOwn(hq.translations?.es ?? {}, key)).toBe(false);
		const zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		);
		for (const key of ["homescreen.title", "app.display.name"])
			expect(serializedRecord(zip.readAsText("es/app_strings.txt"), key)).toBe(
				"Health app",
			);
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

function formSource(hq: ReturnType<typeof expandDoc>, moduleIndex = 0) {
	const source =
		hq._attachments[`${hq.modules[moduleIndex].forms[0].unique_id}.xml`];
	if (typeof source !== "string") throw new Error("Missing form source");
	return source;
}
function titleAndName(xml: string) {
	const [title] = elements(xml, "h:title");
	const [data] = elements(xml, "data").filter(
		(element) =>
			element.parent !== null &&
			isTag(element.parent) &&
			element.parent.name === "instance",
	);
	return { title: textContent(title), name: data?.attribs.name };
}

describe("the form's name in its own XForm", () => {
	it("is the default language's name in the title and the data node, where the source language is another", () => {
		const doc = localizationWireFixture("bilingual");
		const xml = formSource(expandDoc(doc));
		expect(titleAndName(xml)).toEqual({
			title: "Registrar",
			name: "Registrar",
		});
	});

	it("keeps a name holding markup characters, quotes and a no-break space as written", () => {
		const name = `R&D <alpha> "q" 'r'\u00a0x`;
		const doc = buildDoc({
			appName: "Names",
			modules: [
				{
					name: "M",
					forms: [
						{
							name,
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: proseText("Q") })],
						},
					],
				},
			],
		});
		const xml = formSource(expandDoc(doc));
		expect(titleAndName(xml)).toEqual({ title: name, name });
		expect(validateXForm(xml, name, "M")).toEqual([]);
	});

	it("falls back to the source text where the default language has no name", () => {
		const doc = localizationWireFixture("bilingual");
		const formUuid = doc.formOrder[doc.moduleOrder[0]]?.[0];
		if (formUuid === undefined) throw new Error("Missing form");
		const localization = doc.localization;
		if (localization === undefined) throw new Error("Missing localization");
		const formName = makeTranslationUnitId("form", formUuid, "name");
		doc.localization = {
			...localization,
			translations: {
				spa: Object.fromEntries(
					Object.entries(localization.translations.spa ?? {}).filter(
						([unitId]) => unitId !== formName,
					),
				),
			},
		};
		const hq = expandDoc(doc);
		expect(formWireName(doc, formUuid)).toBe(doc.forms[formUuid].name);
		expect(titleAndName(formSource(hq))).toEqual({
			title: doc.forms[formUuid].name,
			name: doc.forms[formUuid].name,
		});
		expect(hq.modules[0].forms[0].name[hq.langs[0]]).toBe(
			doc.forms[formUuid].name,
		);
	});

	it.each(
		emissionFixtures().map(
			({ name, doc, assets }) => [name, doc, assets] as const,
		),
	)(
		"equals HQ's form name in the app's first language across %s",
		(_, doc, assets) => {
			const hq = expandDoc(doc, { assets });
			const wire = emissionPlan(doc).doc;
			projectedModulePreorder(wire).forEach((moduleUuid, moduleIndex) => {
				orderedFormUuids(wire, moduleUuid).forEach((formUuid, formIndex) => {
					expect(formWireName(doc, formUuid)).toBe(
						hq.modules[moduleIndex].forms[formIndex].name[hq.langs[0]],
					);
				});
			});
		},
	);
});

describe("a leaf label blank in every language", () => {
	const blankLabelDoc = (withMedia: boolean) =>
		buildDoc({
			appName: "Blank labels",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "q",
									label: proseText(""),
									...(withMedia && {
										label_media: { image: testMediaAssetId("blank-label") },
									}),
								}),
							],
						},
					],
				},
			],
		});

	it("writes no label and no item, as HQ's form builder leaves it", () => {
		const xml = formSource(expandDoc(blankLabelDoc(false)));
		const [input] = elements(xml, "input");
		expect(input.children.filter(isTag).map((e) => e.name)).toEqual([]);
		expect(
			elements(xml, "text").filter((e) => e.attribs.id === "q-label"),
		).toEqual([]);
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});

	it("keeps its item and label where the label carries media", () => {
		const doc = blankLabelDoc(true);
		const xml = formSource(expandDoc(doc, { assets: manifestFor(doc) }));
		const [input] = elements(xml, "input");
		expect(input.children.filter(isTag).map((e) => e.name)).toEqual(["label"]);
		const items = elements(xml, "text").filter(
			(e) => e.attribs.id === "q-label",
		);
		expect(items).toHaveLength(1);
		expect(itextValue(items[0])).toBe("");
		expect(
			items[0].children.filter(isTag).map((e) => e.attribs.form ?? "text"),
		).toEqual(["text", "markdown", "image"]);
	});
});

describe("a translation blank beside text in another language", () => {
	/** Each `<text>`'s plain or markdown value, by item, form and language. */
	function valuesByItem(xml: string) {
		const out = new Map<string, Map<string, string>>();
		for (const translation of elements(xml, "translation")) {
			const lang = translation.attribs.lang;
			for (const item of findAll(
				(e) => e.name === "text",
				translation.children,
			)) {
				for (const value of item.children.filter(isTag)) {
					const form = value.attribs.form;
					if (value.name !== "value") continue;
					if (form !== undefined && form !== "markdown") continue;
					const key = `${item.attribs.id} ${form ?? "text"}`;
					const byLang = out.get(key) ?? new Map<string, string>();
					byLang.set(lang, textContent(value));
					out.set(key, byLang);
				}
			}
		}
		return out;
	}

	it.each(localizationScenarios)(
		"writes no blank value beside another language's text in the %s scenario",
		(scenario) => {
			const xml = formSource(expandDoc(localizationWireFixture(scenario)));
			const mixed = [...valuesByItem(xml)].filter(([, byLang]) => {
				const values = [...byLang.values()];
				return (
					values.some((value) => value.trim() === "") &&
					values.some((value) => value.trim() !== "")
				);
			});
			expect(mixed).toEqual([]);
		},
	);

	it("fills the source language's blank with the default language's text, in both forms", () => {
		const xml = formSource(expandDoc(localizationWireFixture("optional")));
		const values = valuesByItem(xml);
		for (const form of ["text", "markdown"]) {
			expect(
				Object.fromEntries(values.get(`section-name-hint ${form}`) ?? []),
			).toEqual({ es: "Pista", en: "Pista" });
			expect(
				Object.fromEntries(values.get(`section-label ${form}`) ?? []),
			).toEqual({ es: "Sección", en: "Sección" });
		}
	});

	it("answers one filled value for a form's itext unit on every lookup", () => {
		const doc = localizationWireFixture("optional");
		const localization = commCareLocalization(doc);
		const itext = [...snapshotTranslationUnits(doc).values()].filter((unit) =>
			TRANSLATION_FILL_ROLES.has(unit.role),
		);
		expect(itext.length).toBeGreaterThan(0);
		for (const unit of itext) {
			const printed = Object.fromEntries(
				localization.languages.map((code) => [
					code,
					printProseTemplate(localization.prose(code, unit.id), doc),
				]),
			);
			expect(localization.proseTextMap(unit.id)).toEqual(printed);
			for (const code of localization.languages) {
				expect(localization.wireText(code, unit.id)).toBe(printed[code]);
			}
		}
	});

	it("writes no hint and no item for a hint blank in every language", () => {
		const doc = buildDoc({
			appName: "Blank hints",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "q", label: "Q", hint: { parts: [] } }),
							],
						},
					],
				},
			],
		});
		doc.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "spa",
			languageOrder: ["spa", "eng"],
			wireCodes: { spa: "es", eng: "en" },
			translations: {},
		};
		const xml = formSource(expandDoc(doc));
		const [input] = elements(xml, "input");
		expect(input.children.filter(isTag).map((e) => e.name)).toEqual(["label"]);
		expect(
			elements(xml, "text").filter((e) => e.attribs.id === "q-hint"),
		).toEqual([]);
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});
});
