import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { columnSnapshotMutations } from "@/lib/doc/caseListColumnMutations";
import { caseSearchConfigPatchMutations } from "@/lib/doc/caseSearchConfigPatchMutations";
import { applyMutations } from "@/lib/doc/mutations";
import { projectBuilderLanguageMutations } from "@/lib/doc/projectBuilderLanguageMutations";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	collectTranslationUnits,
	effectiveAppLocalization,
	makeTranslationUnitId,
	projectLocalizedModule,
	proseText,
	simpleSearchInputDef,
	type TranslationUnit,
} from "@/lib/domain";

const MODULE = testUuid("localized-builder-module");
const FORM = testUuid("localized-builder-form");
const FIELD = testUuid("localized-builder-field");
const OPTION_OPEN = testUuid("localized-builder-option-open");
const OPTION_CLOSED = testUuid("localized-builder-option-closed");
const OPTION_NEW = testUuid("localized-builder-option-new");
const COLUMN = testUuid("localized-builder-column");
const SEARCH_INPUT = testUuid("localized-builder-search-input");

function spanishValue(unit: TranslationUnit) {
	switch (unit.id) {
		case makeTranslationUnitId("app", "name"):
			return "Clínica";
		case makeTranslationUnitId("module", MODULE, "name"):
			return "Pacientes";
		case makeTranslationUnitId("form", FORM, "name"):
			return "Registro";
		case makeTranslationUnitId("field", FIELD, "label"):
			return proseText("Estado");
		case makeTranslationUnitId("field", FIELD, "hint"):
			return proseText("Elija uno");
		case makeTranslationUnitId("field", FIELD, "option", OPTION_OPEN):
			return proseText("Abierto");
		case makeTranslationUnitId("field", FIELD, "option", OPTION_CLOSED):
			return proseText("Cerrado");
		case makeTranslationUnitId("column", COLUMN, "header"):
			return "Estado";
		case makeTranslationUnitId("column", COLUMN, "mapping", "open"):
			return "Abierto";
		case makeTranslationUnitId("column", COLUMN, "mapping", "closed"):
			return "Cerrado";
		case makeTranslationUnitId("search-input", SEARCH_INPUT, "label"):
			return "Nombre del paciente";
		case makeTranslationUnitId("module", MODULE, "search-title"):
			return "Buscar pacientes";
		case makeTranslationUnitId("module", MODULE, "search-subtitle"):
			return "Use cualquier dato conocido";
		case makeTranslationUnitId("module", MODULE, "search-button"):
			return "Buscar";
		default:
			return unit.source;
	}
}

function fixture(): BlueprintDoc {
	const doc = buildDoc({
		appId: "localized-builder",
		appName: "Clinic",
		modules: [
			{
				uuid: MODULE,
				id: "patients",
				name: "Patients",
				caseType: "patient",
				caseListConfig: resolveCaseListConfig({
					columns: [
						{
							uuid: COLUMN,
							kind: "id-mapping",
							field: "status",
							header: "Status",
							mapping: [
								{ value: "open", label: "Open" },
								{ value: "closed", label: "Closed" },
							],
						},
					],
					searchInputs: [
						simpleSearchInputDef(
							SEARCH_INPUT,
							"patient_name",
							"Patient name",
							"text",
							"case_name",
						),
					],
				}),
				caseSearchConfig: {
					searchScreenSubtitle: "Use any known information",
				},
				forms: [
					{
						uuid: FORM,
						id: "registration",
						name: "Registration",
						type: "survey",
						fields: [
							f({
								uuid: FIELD,
								id: "status",
								kind: "single_select",
								label: "Status",
								hint: "Choose one",
								optionsSource: {
									kind: "inline",
									options: [
										{
											uuid: OPTION_OPEN,
											value: "open",
											label: proseText("Open"),
										},
										{
											uuid: OPTION_CLOSED,
											value: "closed",
											label: proseText("Closed"),
										},
									],
								},
							}),
						],
					},
				],
			},
		],
	});
	const units = collectTranslationUnits(doc);
	doc.localization = {
		sourceLanguage: "en",
		defaultLanguage: "en",
		languageOrder: ["en", "es"],
		languages: {
			en: { code: "en", name: "English", direction: "ltr" },
			es: { code: "es", name: "Español", direction: "ltr" },
		},
		translations: {
			es: Object.fromEntries(
				units.map((unit) => [
					unit.id,
					{
						value: spanishValue(unit),
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human" as const,
						review: "reviewed" as const,
						translatedFrom: "en",
					},
				]),
			),
		},
	};
	return doc;
}

function project(doc: BlueprintDoc, mutations: Mutation[]): Mutation[] {
	const result = projectBuilderLanguageMutations(doc, "es", mutations);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.message);
	return result.mutations;
}

function apply(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

describe("projectBuilderLanguageMutations", () => {
	it("writes app, module, form, and field text only to the selected target", () => {
		const doc = fixture();
		const mutations = project(doc, [
			{ kind: "setAppName", name: "Clínica comunitaria" },
			{ kind: "renameModule", uuid: MODULE, newId: "Clientes" },
			{ kind: "renameForm", uuid: FORM, newId: "Alta" },
			{
				kind: "updateField",
				uuid: FIELD,
				targetKind: "single_select",
				patch: { label: proseText("Situación"), id: "current_status" },
			},
		]);

		expect(mutations.map((mutation) => mutation.kind)).toEqual([
			"updateField",
			"setTranslation",
			"setTranslation",
			"setTranslation",
			"setTranslation",
		]);
		const next = apply(doc, mutations);
		expect(next.appName).toBe("Clinic");
		expect(next.modules[MODULE]?.name).toBe("Patients");
		expect(next.forms[FORM]?.name).toBe("Registration");
		expect(next.fields[FIELD]).toMatchObject({
			label: proseText("Status"),
			id: "current_status",
		});
		expect(
			effectiveAppLocalization(next.localization).translations.es?.[
				makeTranslationUnitId("field", FIELD, "label")
			]?.value,
		).toEqual(proseText("Situación"));
	});

	it("restores existing option source labels while preserving structural and new-option edits", () => {
		const doc = fixture();
		const mutations = project(doc, [
			{
				kind: "updateField",
				uuid: FIELD,
				targetKind: "single_select",
				patch: {
					optionsSource: {
						kind: "inline",
						options: [
							{
								uuid: OPTION_OPEN,
								value: "open_now",
								label: proseText("Abierto ahora"),
							},
							{
								uuid: OPTION_CLOSED,
								value: "closed",
								label: proseText("Cerrado"),
							},
							{
								uuid: OPTION_NEW,
								value: "pending",
								label: proseText("Pending"),
							},
						],
					},
				},
			},
		]);

		expect(mutations.map((mutation) => mutation.kind)).toEqual([
			"updateField",
			"setTranslation",
		]);
		const next = apply(doc, mutations);
		if (!("optionsSource" in next.fields[FIELD])) {
			throw new Error("Expected a select field.");
		}
		expect(next.fields[FIELD].optionsSource).toEqual({
			kind: "inline",
			options: [
				{
					uuid: OPTION_OPEN,
					value: "open_now",
					label: proseText("Open"),
				},
				{
					uuid: OPTION_CLOSED,
					value: "closed",
					label: proseText("Closed"),
				},
				{
					uuid: OPTION_NEW,
					value: "pending",
					label: proseText("Pending"),
				},
			],
		});
		expect(
			effectiveAppLocalization(next.localization).translations.es?.[
				makeTranslationUnitId("field", FIELD, "option", OPTION_OPEN)
			]?.value,
		).toEqual(proseText("Abierto ahora"));
	});

	it("does not promote unchanged localized column snapshots into new human reviews", () => {
		const doc = fixture();
		const localized = projectLocalizedModule(doc, "es", MODULE);
		if (localized?.caseListConfig === undefined) {
			throw new Error("Expected a localized case list.");
		}
		const current = localized.caseListConfig.columns[0];
		const changed = { ...current, field: "current_status" };
		const planned = columnSnapshotMutations(MODULE, current, changed);
		const mutations = project(doc, planned);

		expect(mutations).toHaveLength(1);
		expect(mutations[0]).toMatchObject({
			kind: "updateColumn",
			column: {
				field: "current_status",
				header: "Status",
				mapping: [
					{ value: "open", label: "Open" },
					{ value: "closed", label: "Closed" },
				],
			},
		});
	});

	it("requires a source-lens edit when an ID-mapping key would create a new string", () => {
		const doc = fixture();
		const localized = projectLocalizedModule(doc, "es", MODULE);
		if (localized?.caseListConfig === undefined) {
			throw new Error("Expected a localized case list.");
		}
		const current = localized.caseListConfig.columns[0];
		if (current.kind !== "id-mapping") {
			throw new Error("Expected an ID-mapping column.");
		}
		const planned = columnSnapshotMutations(MODULE, current, {
			...current,
			mapping: [
				{ ...current.mapping[0], value: "open_now" },
				current.mapping[1],
			],
		});

		expect(projectBuilderLanguageMutations(doc, "es", planned)).toEqual({
			ok: false,
			message:
				"Add this worker-facing content in English first, then translate it into Español.",
		});
	});

	it("writes an actual column and derived Search-default edit to target overlays", () => {
		const doc = fixture();
		const localized = projectLocalizedModule(doc, "es", MODULE);
		if (localized?.caseListConfig === undefined) {
			throw new Error("Expected a localized case list.");
		}
		const current = localized.caseListConfig.columns[0];
		const columnMutations = columnSnapshotMutations(MODULE, current, {
			...current,
			header: "Situación",
		});
		const searchMutations = caseSearchConfigPatchMutations(
			MODULE,
			localized.caseSearchConfig,
			{
				...localized.caseSearchConfig,
				searchScreenTitle: "Encontrar pacientes",
			},
		);
		const mutations = project(doc, [...columnMutations, ...searchMutations]);
		const next = apply(doc, mutations);

		expect(next.modules[MODULE]?.caseListConfig?.columns[0]?.header).toBe(
			"Status",
		);
		expect(next.modules[MODULE]?.caseSearchConfig).toEqual({
			searchScreenSubtitle: "Use any known information",
		});
		const translations = effectiveAppLocalization(next.localization)
			.translations.es;
		expect(
			translations?.[makeTranslationUnitId("column", COLUMN, "header")]?.value,
		).toBe("Situación");
		expect(
			translations?.[makeTranslationUnitId("module", MODULE, "search-title")]
				?.value,
		).toBe("Encontrar pacientes");
	});

	it("leaves source-lens mutations canonical and refuses a removed target", () => {
		const doc = fixture();
		const mutation: Mutation = {
			kind: "setAppName",
			name: "Community clinic",
		};
		expect(projectBuilderLanguageMutations(doc, "en", [mutation])).toEqual({
			ok: true,
			mutations: [mutation],
		});
		expect(projectBuilderLanguageMutations(doc, "fr", [mutation])).toEqual({
			ok: false,
			message:
				"The selected worker language fr no longer belongs to this app. Choose another language and try again.",
		});
	});

	it("requires optional worker content to be created in the source language first", () => {
		const doc = fixture();
		expect(
			projectBuilderLanguageMutations(doc, "es", [
				{
					kind: "updateField",
					uuid: FIELD,
					targetKind: "single_select",
					patch: { help: proseText("Ayuda") },
				},
			]),
		).toEqual({
			ok: false,
			message:
				"Add this worker-facing content in English first, then translate it into Español.",
		});
	});

	it("refuses target prose that drops a protected reference", () => {
		const doc = fixture();
		const protectedField = doc.fields[FIELD];
		if (!("label" in protectedField)) {
			throw new Error("Expected a visible field.");
		}
		protectedField.label = {
			parts: [
				{ kind: "text", text: "Status for " },
				{ kind: "case-ref", caseType: "patient", property: "case_name" },
			],
		};
		const unit = collectTranslationUnits(doc).find(
			(candidate) =>
				candidate.id === makeTranslationUnitId("field", FIELD, "label"),
		);
		if (unit === undefined) throw new Error("Expected the protected unit.");
		const localization = structuredClone(doc.localization);
		if (localization === undefined) {
			throw new Error("Expected persisted localization.");
		}
		doc.localization = {
			...localization,
			translations: {
				...localization.translations,
				es: {
					...localization.translations.es,
					[unit.id]: {
						value: unit.source,
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
					},
				},
			},
		};

		expect(
			projectBuilderLanguageMutations(doc, "es", [
				{
					kind: "updateField",
					uuid: FIELD,
					targetKind: "single_select",
					patch: { label: proseText("Estado") },
				},
			]),
		).toEqual({
			ok: false,
			message:
				"This translation must preserve every referenced answer, case value, and worker value. Edit it in Languages to repair the protected references.",
		});
	});
});
