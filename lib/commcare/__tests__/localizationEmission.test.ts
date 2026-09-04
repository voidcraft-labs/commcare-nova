import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import type { BlueprintDoc } from "@/lib/doc/types";
import {
	advancedSearchInputDef,
	makeTranslationUnitId,
	plainColumn,
	proseText,
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	simpleSearchInputDef,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import {
	eq,
	input,
	isBlank,
	matchesPattern,
	prop,
	whenInput,
} from "@/lib/domain/predicate";
import { searchRuntimeValidationMessage } from "@/lib/domain/searchRuntimeValidationMessages";

interface HealthDocFixture {
	readonly doc: BlueprintDoc;
	readonly moduleUuid: string;
	readonly formUuid: string;
	readonly fieldUuid: string;
	readonly columnUuid: string;
}

function healthDoc(): HealthDocFixture {
	const doc = buildDoc({
		appName: "Health app",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([{ field: "age", header: "Age" }]),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: {
									caseType: "patient",
									property: "case_name",
								},
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "age", label: proseText("Age"), data_type: "int" },
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid]?.[0];
	const fieldUuid =
		formUuid === undefined ? undefined : doc.fieldOrder[formUuid]?.[0];
	const columnUuid = doc.modules[moduleUuid]?.caseListConfig?.columns[0]?.uuid;
	if (
		formUuid === undefined ||
		fieldUuid === undefined ||
		columnUuid === undefined
	) {
		throw new Error("Health fixture identities did not materialize.");
	}
	return { doc, moduleUuid, formUuid, fieldUuid, columnUuid };
}

function entriesFor(
	doc: BlueprintDoc,
	targets: ReadonlyMap<
		TranslationUnitId,
		string | ReturnType<typeof proseText>
	>,
): Record<TranslationUnitId, TranslationEntry> {
	const units = translationUnitsById(doc);
	const entries: Record<TranslationUnitId, TranslationEntry> = {};
	for (const [unitId, value] of targets) {
		const unit = units.get(unitId);
		if (unit === undefined) throw new Error(`Missing fixture unit ${unitId}.`);
		entries[unitId] = {
			value,
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
		};
	}
	return entries;
}

function bilingualDoc(): BlueprintDoc {
	const { doc, moduleUuid, formUuid, fieldUuid, columnUuid } = healthDoc();
	const entries = entriesFor(
		doc,
		new Map<TranslationUnitId, string | ReturnType<typeof proseText>>([
			[makeTranslationUnitId("app", "name"), "Aplicación de salud"],
			[makeTranslationUnitId("module", moduleUuid, "name"), "Pacientes"],
			[makeTranslationUnitId("form", formUuid, "name"), "Registrar"],
			[makeTranslationUnitId("field", fieldUuid, "label"), proseText("Nombre")],
			[makeTranslationUnitId("column", columnUuid, "header"), "Edad"],
		]),
	);
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "spa",
		languageOrder: ["spa", "eng"],
		translations: { spa: entries },
	};
	return doc;
}

/**
 * English source plus both Mandarin writing systems. The two branches widen
 * to one Classic Chinese row, so this is the app shape that exercises the
 * wire plan's collision suffixing on every emission surface at once.
 */
function mandarinBranchesDoc(): BlueprintDoc {
	const { doc, fieldUuid } = healthDoc();
	const simplified = entriesFor(
		doc,
		new Map<TranslationUnitId, string | ReturnType<typeof proseText>>([
			[makeTranslationUnitId("app", "name"), "健康应用"],
			[makeTranslationUnitId("field", fieldUuid, "label"), proseText("名称")],
		]),
	);
	const traditional = entriesFor(
		doc,
		new Map<TranslationUnitId, string | ReturnType<typeof proseText>>([
			[makeTranslationUnitId("app", "name"), "健康應用"],
			[makeTranslationUnitId("field", fieldUuid, "label"), proseText("名稱")],
		]),
	);
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "cmn-Hans", "cmn-Hant"],
		translations: { "cmn-Hans": simplified, "cmn-Hant": traditional },
	};
	return doc;
}

describe("multilingual CommCare emission", () => {
	it("projects complete language maps into HQ JSON", () => {
		const doc = bilingualDoc();
		const hq = expandDoc(doc);

		expect(hq.langs).toEqual(["es", "en"]);
		expect(hq.modules[0].name).toEqual({ es: "Pacientes", en: "Patients" });
		expect(hq.modules[0].forms[0].name).toEqual({
			es: "Registrar",
			en: "Register",
		});
		expect(hq.modules[0].case_details.short.columns[0].header).toEqual({
			es: "Edad",
			en: "Age",
		});
		expect(hq.translations.es["homescreen.title"]).toBe("Aplicación de salud");
		expect(hq.translations.en["homescreen.title"]).toBe("Health app");
		expect(hq.translations.es).toMatchObject({ es: "Español", en: "English" });
		expect(hq.translations.en).toMatchObject({ es: "Español", en: "English" });
	});

	it("writes the default and every named app-string table plus complete XForm itext", () => {
		const doc = bilingualDoc();
		const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
		const defaultStrings = zip.readAsText("default/app_strings.txt");
		const spanishStrings = zip.readAsText("es/app_strings.txt");
		const englishStrings = zip.readAsText("en/app_strings.txt");
		const suite = zip.readAsText("suite.xml");
		const xform = zip.readAsText("modules-0/forms-0.xml");

		expect(defaultStrings).toContain("homescreen.title=Aplicación de salud");
		expect(defaultStrings).toContain("app.display.name=Aplicación de salud");
		expect(defaultStrings).not.toContain("app.name=");
		expect(defaultStrings).toContain("modules.m0=Pacientes");
		expect(defaultStrings).toContain("forms.m0f0=Registrar");
		expect(defaultStrings).toContain("lang.current=es");
		expect(defaultStrings).toContain("es=Español");
		expect(spanishStrings).toBe(defaultStrings);
		expect(englishStrings).toContain("homescreen.title=Health app");
		expect(englishStrings).toContain("app.display.name=Health app");
		expect(englishStrings).toContain("modules.m0=Patients");
		expect(englishStrings).toContain("lang.current=en");
		expect(suite).toContain('language="default"');
		expect(suite).toContain('language="es"');
		expect(suite).toContain('language="en"');
		expect(suite).toContain('<resource id="app_strings_default" version="1">');
		expect(suite).toContain('<resource id="app_strings_es" version="1">');
		expect(xform).toContain('<translation lang="es" default="">');
		expect(xform).toContain('<translation lang="en">');
		expect(xform).toContain("<value>Nombre</value>");
		expect(xform).toContain("<value>Name</value>");
	});

	it("spells collision-suffixed Mandarin branches on every wire surface", () => {
		const doc = mandarinBranchesDoc();
		const hq = expandDoc(doc);

		expect(hq.langs).toEqual(["en", "cmn-hans", "cmn-hant"]);
		expect(hq.translations.en["homescreen.title"]).toBe("Health app");
		expect(hq.translations["cmn-hans"]["homescreen.title"]).toBe("健康应用");
		expect(hq.translations["cmn-hant"]["homescreen.title"]).toBe("健康應用");
		for (const wireCode of ["en", "cmn-hans", "cmn-hant"]) {
			// Device-picker name rows ride in every language's bag, from the
			// registry's baked labels — the two branches stay distinguishable.
			expect(hq.translations[wireCode]).toMatchObject({
				en: "English",
				"cmn-hans": "简体中文",
				"cmn-hant": "繁體中文",
			});
		}
		// The untranslated module name falls back to the canonical source in
		// both branches rather than dropping out of their maps.
		expect(hq.modules[0].name).toEqual({
			en: "Patients",
			"cmn-hans": "Patients",
			"cmn-hant": "Patients",
		});

		const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
		const suite = zip.readAsText("suite.xml");
		for (const dir of ["default", "en", "cmn-hans", "cmn-hant"]) {
			expect(suite).toContain(
				`<locale language="${dir}"><resource id="app_strings_${dir}" version="1"><location authority="local">./${dir}/app_strings.txt</location></resource></locale>`,
			);
		}

		const defaultStrings = zip.readAsText("default/app_strings.txt");
		const englishStrings = zip.readAsText("en/app_strings.txt");
		const hansStrings = zip.readAsText("cmn-hans/app_strings.txt");
		const hantStrings = zip.readAsText("cmn-hant/app_strings.txt");
		expect(englishStrings).toBe(defaultStrings);
		expect(defaultStrings).toContain("lang.current=en");
		expect(defaultStrings).toContain("homescreen.title=Health app");
		expect(hansStrings).toContain("lang.current=cmn-hans");
		expect(hansStrings).toContain("homescreen.title=健康应用");
		expect(hansStrings).toContain("app.display.name=健康应用");
		expect(hansStrings).toContain("modules.m0=Patients");
		expect(hantStrings).toContain("lang.current=cmn-hant");
		expect(hantStrings).toContain("homescreen.title=健康應用");
		for (const table of [defaultStrings, hansStrings, hantStrings]) {
			expect(table).toContain("en=English");
			expect(table).toContain("cmn-hans=简体中文");
			expect(table).toContain("cmn-hant=繁體中文");
		}

		const xform = zip.readAsText("modules-0/forms-0.xml");
		expect(xform).toContain('<translation lang="en" default="">');
		expect(xform).toContain('<translation lang="cmn-hans">');
		expect(xform).toContain('<translation lang="cmn-hant">');
		expect(xform).toContain("<value>Name</value>");
		// 名称 / 名稱 — the serializer entity-encodes non-ASCII itext values.
		expect(xform).toContain("<value>&#x540d;&#x79f0;</value>");
		expect(xform).toContain("<value>&#x540d;&#x7a31;</value>");
	});

	it("emits optional itext and body refs when only the target has text", () => {
		const doc = buildDoc({
			appName: "Target-only prose",
			modules: [
				{
					name: "Patients",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "group",
									id: "section",
									label: { parts: [] },
									children: [
										f({
											kind: "text",
											id: "name",
											label: "Name",
											hint: { parts: [] },
											help: { parts: [] },
											validate: ". != ''",
											validate_msg: { parts: [] },
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const group = Object.values(doc.fields).find(
			(field) => field.id === "section",
		);
		const input = Object.values(doc.fields).find(
			(field) => field.id === "name",
		);
		if (group === undefined || input === undefined) {
			throw new Error("Expected target-only prose fixture fields.");
		}
		const units = translationUnitsById(doc);
		const targets = new Map<TranslationUnitId, ReturnType<typeof proseText>>([
			[
				makeTranslationUnitId("field", group.uuid, "label"),
				proseText("Sección"),
			],
			[makeTranslationUnitId("field", input.uuid, "hint"), proseText("Pista")],
			[makeTranslationUnitId("field", input.uuid, "help"), proseText("Ayuda")],
			[
				makeTranslationUnitId("field", input.uuid, "validate_msg"),
				proseText("Obligatorio"),
			],
		]);
		const entries: Record<TranslationUnitId, TranslationEntry> = {};
		for (const [unitId, value] of targets) {
			const unit = units.get(unitId);
			if (unit === undefined)
				throw new Error(`Missing fixture unit ${unitId}.`);
			entries[unitId] = {
				value,
				sourceFingerprint: unit.sourceFingerprint,
				origin: "human",
				review: "reviewed",
				translatedFrom: "eng",
			};
		}
		doc.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "spa",
			languageOrder: ["spa", "eng"],
			translations: { spa: entries },
		};

		const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
		const xform = zip.readAsText("modules-0/forms-0.xml");
		expect(xform).toContain('<text id="section-label">');
		expect(xform).toContain("<value>Secci&#xf3;n</value>");
		expect(xform).toContain(
			'<group ref="/data/section" appearance="field-list"><label ref="jr:itext(&apos;section-label&apos;)"/>',
		);
		expect(xform).toContain('<text id="section-name-hint">');
		expect(xform).toContain("<value>Pista</value>");
		expect(xform).toContain(
			'<hint ref="jr:itext(&apos;section-name-hint&apos;)"/>',
		);
		expect(xform).toContain('<text id="section-name-help">');
		expect(xform).toContain("<value>Ayuda</value>");
		expect(xform).toContain(
			'<help ref="jr:itext(&apos;section-name-help&apos;)"/>',
		);
		expect(xform).toContain('<text id="section-name-constraintMsg">');
		expect(xform).toContain("<value>Obligatorio</value>");
		expect(xform).toContain(
			'jr:constraintMsg="jr:itext(&apos;section-name-constraintMsg&apos;)"',
		);
	});

	it("escapes locale-file comments and line breaks and rejects literal backslash-n", () => {
		const doc = bilingualDoc();
		const appUnit = makeTranslationUnitId("app", "name");
		const appEntry = doc.localization?.translations.spa?.[appUnit];
		if (appEntry === undefined) throw new Error("Expected Spanish app name.");
		appEntry.value = "Aplicación #1\nSegunda línea";
		const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
		const strings = zip.readAsText("default/app_strings.txt");
		expect(strings).toContain(
			"homescreen.title=Aplicación \\#1\\nSegunda línea",
		);
		expect(strings).not.toContain("homescreen.title=Aplicación #1\n");

		appEntry.value = String.raw`Aplicación \n literal`;
		expect(() => compileCcz(expandDoc(doc), doc.appName, doc)).toThrow(
			/literal sequence \\n/,
		);
	});
});

// ── Search prompt children ─────────────────────────────────────────
//
// A prompt's hint, required message, and check message are translation
// units of their own (`search-input/<uuid>/hint`, `/required-message`,
// `/validation-message`). The default required sentence is one app-wide
// system unit (`system/search-required/default`), and the compiler's CSQL
// guard message is another (`system/search-validation/<key>`); when an
// authored check shares Core's one `<validation>` slot with the guard, the
// locale table joins both units PER LANGUAGE, so a translated app never
// mixes an English guard sentence into a Spanish message.

describe("multilingual CommCare emission — search prompt children", () => {
	const SI_NAME = testUuid("55555555-5555-4555-8555-eeeeeeee0001");
	const SI_STATUS = testUuid("55555555-5555-4555-8555-eeeeeeee0002");
	const SI_PHONE = testUuid("55555555-5555-4555-8555-eeeeeeee0003");

	function promptDoc(): BlueprintDoc {
		return buildDoc({
			appName: "Health app",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(
								testUuid("55555555-5555-4555-8555-ffffffff0001"),
								"case_name",
								"Name",
							),
						],
						searchInputs: [
							simpleSearchInputDef(
								SI_NAME,
								"case_name",
								"Name",
								"text",
								"case_name",
								{ hint: "First and last name", required: {} },
							),
							simpleSearchInputDef(
								SI_PHONE,
								"phone",
								"Phone",
								"text",
								"phone",
								{
									required: {
										when: isBlank(input(SI_NAME)),
										message: "Give a phone when the name is blank.",
									},
								},
							),
							advancedSearchInputDef(
								SI_STATUS,
								"status",
								"Status",
								"text",
								whenInput(
									input(SI_STATUS),
									eq(prop("patient", "status"), input(SI_STATUS)),
								),
								{
									validation: {
										rule: matchesPattern(input(SI_STATUS), "^[a-z]+$"),
										message: "Use lowercase letters only.",
									},
								},
							),
						],
					},
					caseSearchConfig: {},
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "phone", label: proseText("Phone"), data_type: "text" },
						{ name: "status", label: proseText("Status"), data_type: "text" },
					],
				},
			],
		});
	}

	function quoteGuard() {
		const message = searchRuntimeValidationMessage(new Set(["quote"]));
		if (message === undefined) {
			throw new Error("The compiler's quote guard message is not catalogued.");
		}
		return message;
	}

	function bilingualPromptDoc(): BlueprintDoc {
		const doc = promptDoc();
		const entries = entriesFor(
			doc,
			new Map<TranslationUnitId, string | ReturnType<typeof proseText>>([
				[
					makeTranslationUnitId("search-input", SI_NAME, "hint"),
					"Nombre y apellido",
				],
				[
					makeTranslationUnitId("search-input", SI_PHONE, "required-message"),
					"Indique un teléfono cuando falte el nombre.",
				],
				[
					makeTranslationUnitId(
						"search-input",
						SI_STATUS,
						"validation-message",
					),
					"Use solo letras minúsculas.",
				],
				[
					makeTranslationUnitId("system", "search-required", "default"),
					"Complete esta respuesta antes de buscar.",
				],
				[
					makeTranslationUnitId(
						"system",
						"search-validation",
						quoteGuard().key,
					),
					"Quite las comillas.",
				],
			]),
		);
		doc.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "spa",
			languageOrder: ["spa", "eng"],
			translations: { spa: entries },
		};
		return doc;
	}

	it("inventories the three prompt units plus the default required sentence", () => {
		const units = translationUnitsById(promptDoc());
		expect(
			units.get(makeTranslationUnitId("search-input", SI_NAME, "hint")),
		).toMatchObject({
			role: "search-input-hint",
			source: "First and last name",
		});
		expect(
			units.get(
				makeTranslationUnitId("search-input", SI_PHONE, "required-message"),
			),
		).toMatchObject({
			role: "search-input-required-message",
			source: "Give a phone when the name is blank.",
		});
		expect(
			units.get(
				makeTranslationUnitId("search-input", SI_STATUS, "validation-message"),
			),
		).toMatchObject({
			role: "search-input-validation-message",
			source: "Use lowercase letters only.",
		});
		expect(
			units.get(makeTranslationUnitId("system", "search-required", "default")),
		).toMatchObject({ source: SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE });
		// The name input uses the default sentence, so it owns no message unit.
		expect(
			units.get(
				makeTranslationUnitId("search-input", SI_NAME, "required-message"),
			),
		).toBeUndefined();
	});

	it("writes the three locale ids per language and joins a composed validation per language", () => {
		const doc = bilingualPromptDoc();
		const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
		const spanish = zip.readAsText("es/app_strings.txt");
		const english = zip.readAsText("en/app_strings.txt");
		const guard = quoteGuard().message;

		expect(spanish).toContain(
			"search_property.m0.case_name.hint=Nombre y apellido",
		);
		expect(english).toContain(
			"search_property.m0.case_name.hint=First and last name",
		);
		expect(spanish).toContain(
			"search_property.m0.case_name.required.text=Complete esta respuesta antes de buscar.",
		);
		expect(english).toContain(
			`search_property.m0.case_name.required.text=${SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE}`,
		);
		expect(spanish).toContain(
			"search_property.m0.phone.required.text=Indique un teléfono cuando falte el nombre.",
		);
		expect(english).toContain(
			"search_property.m0.phone.required.text=Give a phone when the name is blank.",
		);
		expect(spanish).toContain(
			"search_property.m0.status.validation.0.text=Use solo letras minúsculas. Quite las comillas.",
		);
		expect(english).toContain(
			`search_property.m0.status.validation.0.text=Use lowercase letters only. ${guard}`,
		);
	});

	it("projects the same per-language maps into HQ JSON", () => {
		const hq = expandDoc(bilingualPromptDoc());
		const [name, phone, status] = hq.modules[0].search_config.properties;

		expect(name?.hint).toEqual({
			es: "Nombre y apellido",
			en: "First and last name",
		});
		expect(name?.required?.text).toEqual({
			es: "Complete esta respuesta antes de buscar.",
			en: SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
		});
		expect(phone?.required?.text).toEqual({
			es: "Indique un teléfono cuando falte el nombre.",
			en: "Give a phone when the name is blank.",
		});
		expect(status?.validations?.[0]?.text).toEqual({
			es: "Use solo letras minúsculas. Quite las comillas.",
			en: `Use lowercase letters only. ${quoteGuard().message}`,
		});
	});
});
