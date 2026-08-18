import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	f,
	resolveCaseListConfig,
} from "@/lib/__tests__/docHelpers";
import {
	appLocalizationSchema,
	collectLocalizedTranslationUnits,
	collectTranslationCoverageDiagnostics,
	collectTranslationUnits,
	effectiveAppLocalization,
	type LookupColumnId,
	type LookupTableId,
	languageTag,
	languageTagSchema,
	makeTranslationUnitId,
	parseLanguageTag,
	proseText,
	simpleSearchInputDef,
	translationValueIntegrityIssue,
} from "@/lib/domain";

describe("app localization vocabulary", () => {
	it("derives the absent English-only state without persisting a duplicate overlay", () => {
		const state = effectiveAppLocalization(undefined);
		expect(state).toMatchObject({
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng"],
			translations: {},
		});
	});

	it("admits only the canonical tag grammar", () => {
		for (const tag of ["eng", "spa-MX", "cmn-Hans", "cmn-Hans-CN"]) {
			expect(languageTagSchema.safeParse(tag).success).toBe(true);
		}
		for (const tag of [
			"en",
			"zh-Hans",
			"cmn-hans",
			"CMN",
			"cmn-Hans-cn",
			"cmn-CN-Hans",
			"es-mx",
		]) {
			expect(languageTagSchema.safeParse(tag).success).toBe(false);
		}
	});

	it("inverts languageTag and parseLanguageTag over every identity shape", () => {
		const identities = [
			{ language: "eng" },
			{ language: "spa", region: "MX" },
			{ language: "cmn", script: "Hans" },
			{ language: "cmn", script: "Hant", region: "TW" },
		];
		for (const identity of identities) {
			expect(parseLanguageTag(languageTag(identity))).toEqual(identity);
		}
		expect(languageTag({ language: "cmn", script: "Hans", region: "CN" })).toBe(
			"cmn-Hans-CN",
		);
	});

	it("requires a closed ordered catalog with no source overlay", () => {
		const valid = {
			sourceLanguage: "eng",
			defaultLanguage: "spa",
			languageOrder: ["spa", "eng"],
			translations: { spa: {} },
		} as const;
		expect(appLocalizationSchema.safeParse(valid).success).toBe(true);
		expect(
			appLocalizationSchema.safeParse({
				...valid,
				translations: { ...valid.translations, eng: {} },
			}).success,
		).toBe(false);
		expect(
			appLocalizationSchema.safeParse({
				...valid,
				languageOrder: ["eng", "spa"],
			}).success,
		).toBe(false);
		expect(
			appLocalizationSchema.safeParse({
				...valid,
				languageOrder: ["spa", "eng", "spa"],
			}).success,
		).toBe(false);
	});

	it("builds injective unit identities from arbitrary semantic keys", () => {
		expect(makeTranslationUnitId("a", "bc")).not.toBe(
			makeTranslationUnitId("ab", "c"),
		);
	});
});

describe("translation unit inventory", () => {
	function fixture() {
		const option = testUuid("localization-option");
		const doc = buildDoc({
			appName: "Clinic",
			modules: [
				{
					uuid: "localization-module",
					name: "Patients",
					forms: [
						{
							uuid: "localization-form",
							name: "Intake",
							type: "survey",
							fields: [
								f({
									uuid: "localization-field",
									kind: "single_select",
									id: "status",
									label: "Status",
									hint: "Choose one",
									help: "Ask the patient",
									validate_msg: "Choose a status",
									optionsSource: {
										kind: "inline",
										options: [
											{ uuid: option, value: "open", label: proseText("Open") },
											{
												uuid: testUuid("localization-option-2"),
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
		return { doc, option };
	}

	it("enumerates stable app, hierarchy, field, and inline-option units", () => {
		const { doc, option } = fixture();
		const units = collectTranslationUnits(doc);
		expect(units.map((unit) => unit.role)).toEqual(
			expect.arrayContaining([
				"app-name",
				"module-name",
				"form-name",
				"field-label",
				"field-hint",
				"field-help",
				"field-validation-message",
				"select-option-label",
			]),
		);
		expect(units.find((unit) => unit.id.includes(option))?.breadcrumb).toEqual([
			"Clinic",
			"Patients",
			"Intake",
			"Status",
			"open",
		]);
	});

	it("gives repeated case-property values injective option-label units", () => {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "status",
							label: "Status",
							data_type: "multi_select",
							options: [
								{ value: "same", label: "First label" },
								{ value: "same", label: "Second label" },
							],
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "status", header: "Status" },
					]),
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
			],
		});
		const units = collectTranslationUnits(doc).filter(
			(unit) => unit.role === "case-property-option-label",
		);
		expect(units).toHaveLength(2);
		expect(new Set(units.map((unit) => unit.id)).size).toBe(2);
		expect(units.map((unit) => unit.owner)).toMatchObject([
			{ kind: "case-property-option", value: "same", occurrence: 0 },
			{ kind: "case-property-option", value: "same", occurrence: 1 },
		]);
	});

	it("falls back to current source when a stored target becomes stale", () => {
		const { doc } = fixture();
		const unit = collectTranslationUnits(doc).find(
			(candidate) => candidate.role === "app-name",
		);
		expect(unit).toBeDefined();
		if (unit === undefined) return;
		doc.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			translations: {
				spa: {
					[unit.id]: {
						value: "Clínica",
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
					},
				},
			},
		};
		doc.appName = "Health clinic";
		const localized = collectLocalizedTranslationUnits(doc, "spa").find(
			(candidate) => candidate.id === unit.id,
		);
		expect(localized).toMatchObject({
			status: "out-of-date",
			effective: "Health clinic",
			explicit: { value: "Clínica" },
		});
	});

	it("treats prose references as protected, reorderable tokens", () => {
		const source = {
			parts: [
				{ kind: "text" as const, text: "Hello " },
				{ kind: "field-ref" as const, uuid: testUuid("prose-ref") },
			],
		};
		const unit = {
			id: makeTranslationUnitId("test"),
			valueKind: "prose" as const,
			role: "field-label" as const,
			source,
			sourceFingerprint: "source",
			contentPolicy: "allow-blank" as const,
			owner: { kind: "app" as const },
			breadcrumb: ["test"],
			context: {},
		};
		expect(
			translationValueIntegrityIssue(unit, {
				parts: [
					{ kind: "field-ref", uuid: testUuid("prose-ref") },
					{ kind: "text", text: " hola" },
				],
			}),
		).toBeUndefined();
		expect(translationValueIntegrityIssue(unit, proseText("Hola"))).toBe(
			"protected-content",
		);
	});

	it("carries slot-specific blank-content policy into integrity checks", () => {
		const { doc } = fixture();
		doc.modules[doc.moduleOrder[0]].caseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [
				simpleSearchInputDef(
					testUuid("localization-search-input"),
					"patient_name",
					"Patient name",
					"text",
					"case_name",
				),
			],
		});
		const appName = collectTranslationUnits(doc).find(
			(unit) => unit.role === "app-name",
		);
		const searchInput = collectTranslationUnits(doc).find(
			(unit) => unit.role === "search-input-label",
		);
		const hint = collectTranslationUnits(doc).find(
			(unit) => unit.role === "field-hint",
		);
		expect(appName?.contentPolicy).toBe("require-nonblank");
		expect(searchInput?.contentPolicy).toBe("require-nonblank");
		expect(hint?.contentPolicy).toBe("allow-blank");
		if (
			appName === undefined ||
			searchInput === undefined ||
			hint === undefined
		)
			return;
		expect(translationValueIntegrityIssue(appName, "  ")).toBe("blank-content");
		expect(translationValueIntegrityIssue(searchInput, "  ")).toBe(
			"blank-content",
		);
		expect(translationValueIntegrityIssue(hint, proseText(""))).toBeUndefined();
	});

	it("reports carriers that cannot honestly count toward static coverage", () => {
		const doc = buildDoc({
			appName: "Clinic",
			modules: [
				{
					uuid: "localization-diagnostics-module",
					name: "Patients",
					forms: [
						{
							uuid: "localization-diagnostics-form",
							name: "Intake",
							type: "survey",
							fields: [
								f({
									uuid: "localization-diagnostics-field",
									kind: "single_select",
									id: "facility",
									label: "Facility",
									optionsSource: {
										kind: "lookup",
										tableId:
											"018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId,
										valueColumnId:
											"018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId,
										labelColumnId:
											"018f3e8a-7b2c-7def-8abc-1234567890ae" as LookupColumnId,
									},
								}),
							],
						},
					],
				},
			],
		});

		expect(collectTranslationCoverageDiagnostics(doc)).toEqual([
			expect.objectContaining({
				code: "lookup-labels-need-localized-data",
				affectedCount: 1,
			}),
		]);
	});
});
