import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	f,
	resolveCaseListConfig,
} from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import {
	appLocalizationSchema,
	collectLocalizedTranslationUnits,
	collectTranslationCoverageDiagnostics,
	collectTranslationUnits,
	effectiveAppLocalization,
	isEnglishOnlyLocalization,
	languageTag,
	languageTagSchema,
	languageWireCodeSchema,
	localizeTranslationUnit,
	makeTranslationUnitId,
	parseLanguageTag,
	projectLocalizedField,
	projectLocalizedFields,
	proseText,
	simpleSearchInputDef,
	translationSourceFingerprint,
	translationSourceFingerprintsEqual,
	translationValueIntegrityIssue,
} from "@/lib/domain";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { lookupColumnIdSchema, lookupTableIdSchema } from "../lookupIds";

const TABLE = lookupTableIdSchema.parse("018f3e8a-7b2c-7def-8abc-1234567890ab");
const VALUE = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ad",
);
const LABEL = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ae",
);
const lookupContext: LookupValidationContext = {
	kind: "available",
	projectId: "localization-project",
	projectRevision: parseLookupRevision("1"),
	definitions: [
		{
			id: TABLE,
			name: "Facilities",
			tag: "facilities",
			definitionRevision: parseLookupRevision("1"),
			columns: [
				{ id: VALUE, wireName: "code", label: "Code", dataType: "text" },
				{ id: LABEL, wireName: "name", label: "Name", dataType: "text" },
			],
		},
	],
};

describe("app localization vocabulary", () => {
	it("binds source identity to schema values across legacy JSON key orders", () => {
		const source = {
			parts: [
				{ kind: "text" as const, text: "Repairing " },
				{
					kind: "case-ref" as const,
					caseType: "repair",
					property: "case_name",
				},
			],
		};
		const stored = {
			parts: [
				{ text: "Repairing ", kind: "text" as const },
				{
					caseType: "repair",
					property: "case_name",
					kind: "case-ref" as const,
				},
			],
		};
		const current = translationSourceFingerprint("prose", source);
		const legacy = `source-v1:prose:${JSON.stringify(stored)}`;
		expect(legacy).not.toBe(current);
		expect(translationSourceFingerprint("prose", stored)).toBe(current);
		expect(translationSourceFingerprintsEqual(legacy, current)).toBe(true);
		for (const changed of [
			{ parts: [...source.parts].reverse() },
			{
				parts: [
					{ kind: "text" as const, text: "Collecting " },
					source.parts[1],
				],
			},
			{
				parts: [
					source.parts[0],
					{
						kind: "case-ref" as const,
						caseType: "other",
						property: "case_name",
					},
				],
			},
			{
				parts: [
					source.parts[0],
					{
						kind: "case-ref" as const,
						caseType: "repair",
						property: "external_id",
					},
				],
			},
		])
			expect(
				translationSourceFingerprintsEqual(
					legacy,
					`source-v1:prose:${JSON.stringify(changed)}`,
				),
			).toBe(false);
		for (const invalid of [
			"unknown",
			'source-v2:text:"Hello"',
			"source-v1:text:3",
			'source-v1:prose:"Hello"',
			"source-v1:prose:{",
			'source-v1:prose:{"parts":[],"extra":true}',
			'source-v1:prose:{"parts":[{"kind":"case-ref","caseType":"repair"}]}',
		])
			expect(translationSourceFingerprintsEqual(invalid, invalid)).toBe(false);
		expect(
			translationSourceFingerprintsEqual(
				'source-v1:text:"Hello"',
				'source-v1:text:"Hello"',
			),
		).toBe(true);
		expect(
			translationSourceFingerprintsEqual(
				'source-v1:text:"Hello"',
				'source-v1:text:"Hello "',
			),
		).toBe(false);
	});
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

	it("prints and parses the authored language identity examples", () => {
		const examples = [
			{ identity: { language: "eng" }, tag: "eng" },
			{ identity: { language: "spa", region: "MX" }, tag: "spa-MX" },
			{ identity: { language: "cmn", script: "Hans" }, tag: "cmn-Hans" },
			{
				identity: { language: "cmn", script: "Hant", region: "TW" },
				tag: "cmn-Hant-TW",
			},
		];
		for (const { identity, tag } of examples) {
			expect(languageTag(identity)).toBe(tag);
			expect(parseLanguageTag(tag)).toEqual(identity);
		}
	});

	it("requires a closed ordered catalog with no source overlay", () => {
		const valid = {
			sourceLanguage: "eng",
			defaultLanguage: "spa",
			languageOrder: ["spa", "eng"],
			translations: { spa: {} },
			wireCodes: { spa: "es", eng: "en" },
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

	it("requires one distinct CommCare code for every app language and no other", () => {
		const valid = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "cmn-Hans", "cmn-Hant"],
			translations: { "cmn-Hans": {}, "cmn-Hant": {} },
			wireCodes: { eng: "en", "cmn-Hans": "zho", "cmn-Hant": "cmn-hant" },
		} as const;
		expect(appLocalizationSchema.safeParse(valid).success).toBe(true);
		const refused = (wireCodes: Record<string, string>) =>
			appLocalizationSchema.safeParse({ ...valid, wireCodes }).success;
		// A language with no code.
		expect(refused({ eng: "en", "cmn-Hans": "zho" })).toBe(false);
		// A code for a language the app does not hold.
		expect(refused({ ...valid.wireCodes, spa: "es" })).toBe(false);
		// Two languages sharing one code.
		expect(refused({ eng: "en", "cmn-Hans": "zho", "cmn-Hant": "zho" })).toBe(
			false,
		);
		// A code outside CommCare HQ's grammar.
		expect(
			refused({ eng: "EN", "cmn-Hans": "zho", "cmn-Hant": "cmn-hant" }),
		).toBe(false);
		expect(languageWireCodeSchema.safeParse("cmn-hant").success).toBe(true);
		expect(languageWireCodeSchema.safeParse("yue-").success).toBe(true);
		for (const code of ["e", "engl", "cmn-Hant", "cmn-ha-nt", "zh_cn"]) {
			expect(languageWireCodeSchema.safeParse(code).success).toBe(false);
		}
	});

	it("reads the absent root as English under the code en", () => {
		expect(effectiveAppLocalization(undefined).wireCodes).toEqual({
			eng: "en",
		});
		const englishOnly = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng"],
			translations: {},
			wireCodes: { eng: "en" },
		};
		expect(isEnglishOnlyLocalization(englishOnly)).toBe(true);
		// A root whose English holds a suffixed code keeps that code, which the
		// absent root could not spell.
		expect(
			isEnglishOnlyLocalization({
				...englishOnly,
				wireCodes: { eng: "eng-" },
			}),
		).toBe(false);
	});

	it("keeps ambiguous concatenations, separators, blanks, and Unicode distinct", () => {
		const keys = [
			["a", "bc"],
			["ab", "c"],
			["a:b", "c"],
			["a", "b:c"],
			["", "a"],
			["a", ""],
			["😀", "x"],
			["😀x"],
		];
		expect(new Set(keys.map((key) => makeTranslationUnitId(...key))).size).toBe(
			keys.length,
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
		expectAdmittedDoc(doc);
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

	it("includes menu ancestry in submenu-owned translation paths", () => {
		const { doc, option } = fixture();
		const childUuid = doc.moduleOrder[0];
		const parentUuid = testUuid("localization-parent-menu");
		doc.modules[parentUuid] = {
			uuid: parentUuid,
			id: "care",
			name: "Care",
		};
		doc.modules[childUuid].parentModuleUuid = parentUuid;
		doc.moduleOrder.unshift(parentUuid);
		const parentForm = testUuid("localization-parent-form");
		const parentField = testUuid("localization-parent-field");
		doc.forms[parentForm] = {
			uuid: parentForm,
			id: "overview",
			name: "Overview",
			type: "survey",
		};
		doc.fields[parentField] = {
			uuid: parentField,
			id: "note",
			kind: "text",
			label: proseText("Note"),
		};
		doc.formOrder[parentUuid] = [parentForm];
		doc.fieldOrder[parentForm] = [parentField];
		doc.fieldParent[parentField] = parentForm;
		expectAdmittedDoc(doc);

		expect(
			collectTranslationUnits(doc).find((unit) => unit.id.includes(option))
				?.breadcrumb,
		).toEqual(["Clinic", "Care", "Patients", "Intake", "Status", "open"]);
	});

	it("gives a stored document's repeated case-property values injective option-label units", () => {
		// The gate refuses a repeated value (CASE_PROPERTY_OPTION_VALUE_DUPLICATE),
		// and a document stored before that holds one until the cutover's
		// option-values step renames it, moving each entry by this key.
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "visit_state",
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
						{ field: "visit_state", header: "Status" },
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
		if (unit === undefined) throw new Error("Missing app-name unit");
		doc.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			wireCodes: { eng: "en", spa: "es" },
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
		expectAdmittedDoc(doc);
		expect(
			collectLocalizedTranslationUnits(doc, "spa").find(
				(candidate) => candidate.id === unit.id,
			),
		).toMatchObject({ status: "ready", effective: "Clínica" });
		doc.appName = "Health clinic";
		expectAdmittedDoc(doc);
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
		const NAME = testUuid("prose-ref");
		const QUESTION = testUuid("translated-question");
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Intake",
							type: "survey",
							fields: [
								f({ uuid: NAME, id: "name", kind: "text", label: "Name" }),
								f({
									uuid: QUESTION,
									id: "greeting",
									kind: "text",
									label: {
										parts: [
											{ kind: "text", text: "Hello " },
											{ kind: "field-ref", uuid: NAME },
										],
									},
								}),
							],
						},
					],
				},
			],
		});
		expectAdmittedDoc(doc);
		const unit = collectTranslationUnits(doc).find(
			(candidate) =>
				candidate.owner.kind === "field" &&
				candidate.owner.fieldUuid === QUESTION &&
				candidate.role === "field-label",
		);
		if (!unit) throw new Error("Missing protected prose fixture");
		const translated = {
			parts: [
				{ kind: "text" as const, text: "Hola " },
				{ kind: "field-ref" as const, uuid: NAME },
			],
		};
		doc.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			wireCodes: { eng: "en", spa: "es" },
			translations: {
				spa: {
					[unit.id]: {
						value: translated,
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
						sourceFingerprint: `source-v1:prose:${JSON.stringify({
							parts: [
								{ text: "Hello ", kind: "text" },
								{ uuid: NAME, kind: "field-ref" },
							],
						})}`,
					},
				},
			},
		};
		expectAdmittedDoc(doc);
		expect(
			collectLocalizedTranslationUnits(doc, "spa").find(
				(candidate) => candidate.id === unit.id,
			),
		).toMatchObject({
			status: "ready",
			effective: translated,
			explicit: { review: "reviewed" },
		});

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
		expect(
			translationValueIntegrityIssue(unit, {
				parts: [
					{ kind: "field-ref", uuid: NAME },
					{ kind: "field-ref", uuid: NAME },
				],
			}),
		).toBe("protected-content");
		expect(
			translationValueIntegrityIssue(unit, {
				parts: [{ kind: "field-ref", uuid: QUESTION }],
			}),
		).toBe("protected-content");
		expect(translationValueIntegrityIssue(unit, "Hola")).toBe("value-kind");
	});

	it("carries slot-specific blank-content policy into integrity checks", () => {
		const { doc: original } = fixture();
		const doc = { ...original, modules: structuredClone(original.modules) };
		doc.caseTypes = [{ name: "patient", properties: [] }];
		doc.modules[doc.moduleOrder[0]].caseType = "patient";
		doc.modules[doc.moduleOrder[0]].caseListConfig = resolveCaseListConfig({
			columns: caseListConfig([{ field: "case_name", header: "Name" }]).columns,
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
		expectAdmittedDoc(doc);
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
			throw new Error("Missing translation unit fixture");
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
										tableId: TABLE,
										valueColumnId: VALUE,
										labelColumnId: LABEL,
									},
								}),
							],
						},
					],
				},
			],
		});

		expectAdmittedDoc(doc, lookupContext);
		expect(collectTranslationCoverageDiagnostics(doc)).toEqual([
			expect.objectContaining({
				code: "lookup-labels-need-localized-data",
				affectedCount: 1,
			}),
		]);
	});
	it("reports lookup-backed Search choices outside the static translation inventory", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "facility", label: "Facility", data_type: "text" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						searchInputs: [
							simpleSearchInputDef(
								testUuid("localized-choice-search"),
								"facility",
								"Facility",
								"select",
								"facility",
								{
									options: {
										kind: "lookup",
										tableId: TABLE,
										valueColumnId: VALUE,
										labelColumnId: LABEL,
									},
								},
							),
						],
					},
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
			],
		});
		expectAdmittedDoc(doc, lookupContext);
		expect(collectTranslationCoverageDiagnostics(doc)).toEqual([
			expect.objectContaining({
				code: "lookup-labels-need-localized-data",
				affectedCount: 1,
			}),
		]);
	});
});

describe("blank translations", () => {
	const FIELD = testUuid("blank-translation-field");

	/** An English-source app with a Spanish target whose question label and
	 * hint the test translates. */
	function fixture(hint: string) {
		const doc = buildDoc({
			appName: "Clinic",
			modules: [
				{
					name: "Patients",
					forms: [
						{
							name: "Intake",
							type: "survey",
							fields: [
								f({
									uuid: "blank-translation-field",
									kind: "text",
									id: "name",
									label: "Name",
									hint,
								}),
							],
						},
					],
				},
			],
		});
		doc.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			wireCodes: { eng: "en", spa: "es" },
			translations: { spa: {} },
		};
		return doc;
	}

	function translate(
		doc: ReturnType<typeof fixture>,
		slot: "label" | "hint",
		text: string,
	) {
		const unit = collectTranslationUnits(doc).find(
			(candidate) =>
				candidate.id === makeTranslationUnitId("field", FIELD, slot),
		);
		if (unit === undefined || doc.localization === undefined) {
			throw new Error(`No ${slot} unit`);
		}
		const spa = doc.localization.translations.spa ?? {};
		spa[unit.id] = {
			value: proseText(text),
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
		};
		return unit;
	}

	it("projects a worker's filled text only when asked, in the source language too", () => {
		const doc = fixture("");
		translate(doc, "label", "");
		translate(doc, "hint", "Nombre completo");
		expectAdmittedDoc(doc);

		const stored = projectLocalizedFields(doc, "spa")[FIELD];
		const filled = projectLocalizedFields(doc, "spa", { filled: true })[FIELD];
		expect(stored).toMatchObject({
			label: proseText(""),
			hint: proseText("Nombre completo"),
		});
		expect(filled).toMatchObject({
			label: proseText("Name"),
			hint: proseText("Nombre completo"),
		});

		// The English hint is blank beside a Spanish one: a worker reading
		// English sees the Spanish text, and the stored English stays blank.
		expect(projectLocalizedFields(doc, "eng")[FIELD]).toMatchObject({
			hint: proseText(""),
		});
		expect(
			projectLocalizedFields(doc, "eng", { filled: true })[FIELD],
		).toMatchObject({ hint: proseText("Nombre completo") });
	});

	it("gives the stored field itself where the fill changes nothing", () => {
		// One language: nothing can be filled, so a worker reads the stored
		// field, by reference.
		const single = fixture("");
		single.localization = undefined;
		expectAdmittedDoc(single);
		expect(
			projectLocalizedField(single, "eng", FIELD, undefined, { filled: true }),
		).toBe(single.fields[FIELD]);
		expect(projectLocalizedFields(single, "eng", { filled: true })).toBe(
			single.fields,
		);

		// The source language with every slot written: no slot is filled.
		const written = fixture("Full name");
		translate(written, "label", "");
		expectAdmittedDoc(written);
		expect(
			projectLocalizedField(written, "eng", FIELD, undefined, { filled: true }),
		).toBe(written.fields[FIELD]);
		// The same document in Spanish fills the blank label.
		expect(
			projectLocalizedField(written, "spa", FIELD, undefined, { filled: true }),
		).toMatchObject({ label: proseText("Name") });
	});

	it("marks a blank translation beside text missing, naming the language workers read", () => {
		const doc = fixture("Full name");
		const unit = translate(doc, "label", "");
		expectAdmittedDoc(doc);

		expect(localizeTranslationUnit(doc, "spa", unit)).toMatchObject({
			status: "missing",
			filledFrom: "eng",
			effective: proseText(""),
			explicit: { value: proseText(""), review: "reviewed" },
		});
		const statuses = collectLocalizedTranslationUnits(doc, "spa")
			.filter((candidate) => candidate.owner.kind === "field")
			.map((candidate) => [candidate.role, candidate.status]);
		expect(statuses).toEqual([
			["field-label", "missing"],
			["field-hint", "missing"],
		]);
	});

	it("keeps the status of a translation blank in every language", () => {
		const doc = fixture("");
		const unit = translate(doc, "hint", "");
		expectAdmittedDoc(doc);

		const localized = localizeTranslationUnit(doc, "spa", unit);
		expect(localized).toMatchObject({ status: "ready" });
		expect(localized.filledFrom).toBeUndefined();
	});
});
