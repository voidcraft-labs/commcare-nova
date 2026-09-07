/** Shared strictly admitted authoring documents; native HQ/Core consume emitted artifacts. */

import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/doc/types";
import {
	advancedSearchInputDef,
	blueprintDocSchema,
	makeTranslationUnitId,
	plainColumn,
	proseText,
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
import { runValidation } from "../validator/runner";

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
						simpleSearchInputDef(SI_PHONE, "phone", "Phone", "text", "phone", {
							required: {
								when: isBlank(input(SI_NAME)),
								message: "Give a phone when the name is blank.",
							},
						}),
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
				makeTranslationUnitId("search-input", SI_STATUS, "validation-message"),
				"Use solo letras minúsculas.",
			],
			[
				makeTranslationUnitId("system", "search-required", "default"),
				"Complete esta respuesta antes de buscar.",
			],
			[
				makeTranslationUnitId("system", "search-validation", quoteGuard().key),
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
function targetOnlyDoc(): BlueprintDoc {
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
	const input = Object.values(doc.fields).find((field) => field.id === "name");
	if (group === undefined || input === undefined) {
		throw new Error("Expected target-only prose fixture fields.");
	}
	const units = translationUnitsById(doc);
	const targets = new Map<TranslationUnitId, ReturnType<typeof proseText>>([
		[makeTranslationUnitId("field", group.uuid, "label"), proseText("Sección")],
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
		if (unit === undefined) throw new Error(`Missing fixture unit ${unitId}.`);
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

	return doc;
}

export const localizationScenarios = [
	"bilingual",
	"mandarin",
	"optional",
	"escaped",
	"stale",
	"prompts",
] as const;
export type LocalizationScenario = (typeof localizationScenarios)[number];
export function localizationWireFixture(
	scenario: LocalizationScenario,
): BlueprintDoc {
	const doc =
		scenario === "mandarin"
			? mandarinBranchesDoc()
			: scenario === "optional"
				? targetOnlyDoc()
				: scenario === "prompts"
					? bilingualPromptDoc()
					: bilingualDoc();
	if (scenario === "escaped" || scenario === "stale") {
		const entry =
			doc.localization?.translations.spa?.[
				makeTranslationUnitId("app", "name")
			];
		if (!entry) throw new Error("Missing Spanish app name");
		if (scenario === "escaped") entry.value = "Aplicación #1\nSegunda línea";
		else {
			entry.value = "Old translated title";
			entry.sourceFingerprint = "older-fingerprint";
		}
	}
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length)
		throw new Error(JSON.stringify({ scenario, findings }, null, 2));
	return doc;
}
