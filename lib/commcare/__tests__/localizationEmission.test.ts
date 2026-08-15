import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import type { BlueprintDoc } from "@/lib/doc/types";
import {
	makeTranslationUnitId,
	proseText,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";

function bilingualDoc(): BlueprintDoc {
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
		throw new Error("Bilingual fixture identities did not materialize.");
	}
	const units = translationUnitsById(doc);
	const targets = new Map<
		TranslationUnitId,
		string | ReturnType<typeof proseText>
	>([
		[makeTranslationUnitId("app", "name"), "Aplicación de salud"],
		[makeTranslationUnitId("module", moduleUuid, "name"), "Pacientes"],
		[makeTranslationUnitId("form", formUuid, "name"), "Registrar"],
		[makeTranslationUnitId("field", fieldUuid, "label"), proseText("Nombre")],
		[makeTranslationUnitId("column", columnUuid, "header"), "Edad"],
	]);
	const entries: Record<TranslationUnitId, TranslationEntry> = {};
	for (const [unitId, value] of targets) {
		const unit = units.get(unitId);
		if (unit === undefined) throw new Error(`Missing fixture unit ${unitId}.`);
		entries[unitId] = {
			value,
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "en",
		};
	}
	doc.localization = {
		sourceLanguage: "en",
		defaultLanguage: "es",
		languageOrder: ["es", "en"],
		languages: {
			es: { code: "es", name: "Español", direction: "ltr" },
			en: { code: "en", name: "English", direction: "ltr" },
		},
		translations: { es: entries },
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

	it("writes the default and named app-string tables plus complete XForm itext", () => {
		const doc = bilingualDoc();
		const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
		const defaultStrings = zip.readAsText("default/app_strings.txt");
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
		expect(englishStrings).toContain("homescreen.title=Health app");
		expect(englishStrings).toContain("app.display.name=Health app");
		expect(englishStrings).toContain("modules.m0=Patients");
		expect(englishStrings).toContain("lang.current=en");
		expect(suite).toContain('language="default"');
		expect(suite).toContain('language="en"');
		expect(xform).toContain('<translation lang="es" default="">');
		expect(xform).toContain('<translation lang="en">');
		expect(xform).toContain("<value>Nombre</value>");
		expect(xform).toContain("<value>Name</value>");
	});
});
