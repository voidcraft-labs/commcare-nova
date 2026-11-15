import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	collectTranslationUnits,
	proseText,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitIdSchema,
} from "@/lib/domain";
import { translationValueIntegrityIssue } from "@/lib/domain/translationUnits";
import { localizationWireFixture } from "../../__tests__/localizationWireFixture";
import { translationUnitUsesLocaleFile } from "../../localeFile";
import { runValidation } from "../runner";

const ANSWER = testUuid("translation-answer");
function fixture() {
	const doc = buildDoc({
		appName: "Clinic",
		modules: [
			{
				name: "Intake",
				forms: [
					{
						name: "Register",
						type: "survey",
						fields: [
							f({ kind: "text", id: "name", uuid: ANSWER }),
							f({
								kind: "label",
								id: "greeting",
								label: {
									parts: [
										{ kind: "text", text: "Hello " },
										{ kind: "field-ref", uuid: ANSWER },
									],
								},
							}),
						],
					},
				],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const units = collectTranslationUnits(doc);
	const app = units.find((u) => u.role === "app-name"),
		greeting = units.find(
			(u) => u.context.fieldId === "greeting" && u.role === "field-label",
		);
	if (!app || !greeting) throw new Error("Missing translation units");
	return { doc, app, greeting };
}
function overlay(
	doc: BlueprintDoc,
	id: TranslationUnitId,
	value: TranslationEntry["value"],
	fingerprint: string,
) {
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		wireCodes: { eng: "en", spa: "es" },
		translations: {
			spa: {
				[id]: {
					value,
					sourceFingerprint: fingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		},
	};
	blueprintDocSchema.parse(toPersistableDoc(doc));
}
describe("translation overlay commit validation", () => {
	it.each(["unknown", "kind", "reference", "blank", "locale-escape"] as const)(
		"rejects one isolated %s defect from an admitted document",
		(defect) => {
			const { doc, app, greeting } = fixture();
			const id =
				defect === "unknown"
					? translationUnitIdSchema.parse("tu1:orphan")
					: defect === "reference"
						? greeting.id
						: app.id;
			const value =
				defect === "kind"
					? proseText("Clínica")
					: defect === "reference"
						? proseText("Hola")
						: defect === "blank"
							? "  "
							: defect === "locale-escape"
								? String.raw`Clínica \n literal`
								: "Unknown";
			const expected = {
				unknown: "TRANSLATION_UNIT_UNKNOWN",
				kind: "TRANSLATION_VALUE_KIND_MISMATCH",
				reference: "TRANSLATION_PROTECTED_CONTENT_CHANGED",
				blank: "TRANSLATION_REQUIRED_CONTENT_BLANK",
				"locale-escape": "APP_STRING_VALUE_UNREPRESENTABLE",
			};
			overlay(
				doc,
				id,
				value,
				defect === "reference"
					? greeting.sourceFingerprint
					: app.sourceFingerprint,
			);
			const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
			expect(errors.map((e) => e.code)).toEqual([expected[defect]]);
			expect(errors[0].details).toMatchObject({ language: "spa", unitId: id });
		},
	);
	it("admits the same protected-content difference only when its fingerprint is stale", () => {
		const { doc, greeting } = fixture();
		overlay(
			doc,
			greeting.id,
			proseText("Old plain copy"),
			"older-source-fingerprint",
		);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		overlay(
			doc,
			greeting.id,
			proseText("Old plain copy"),
			greeting.sourceFingerprint,
		);
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((e) => e.code),
		).toEqual(["TRANSLATION_PROTECTED_CONTENT_CHANGED"]);
	});
	it("admits a translated template that preserves the actual reference identity", () => {
		const { doc, greeting } = fixture();
		overlay(
			doc,
			greeting.id,
			{
				parts: [
					{ kind: "text", text: "Hola " },
					{ kind: "field-ref", uuid: ANSWER },
				],
			},
			greeting.sourceFingerprint,
		);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});
});

/**
 * Every app string a device shows otherwise than the builder and Preview do is refused at the
 * commit gate (`APP_STRING_VALUE_UNREPRESENTABLE`), over the source text and every
 * translation of every role that lands in the app strings. The sequences are the ones CommCare
 * HQ's build (`commcare_translations.py::dumps`) and Core's locale reader
 * (`LocalizationUtils.parseAndAdd`, `parseValue`) change between them
 * (`lib/commcare/__tests__/localeFile.test.ts` holds each against a device).
 */
describe("an app string a device shows otherwise", () => {
	const SEQUENCES: readonly (readonly [string, string])[] = [
		["a backslash followed by n", String.raw`Clinic \n one`],
		["a backslash followed by #", String.raw`Clinic \#1`],
		["two backslashes followed by #", String.raw`Clinic \\#1`],
		["a carriage return", "Clinic\rone"],
		["a space at the start", " Clinic"],
		["a space at the end", "Clinic "],
		["a line break at the end", "Clinic\n"],
	];
	it.each(SEQUENCES)(
		"is refused where the source's app name holds %s",
		(_, value) => {
			const { doc } = fixture();
			doc.appName = value;
			const found = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
				(e) => e.code === "APP_STRING_VALUE_UNREPRESENTABLE",
			);
			expect(found.map((e) => e.details)).toContainEqual(
				expect.objectContaining({
					language: "source-language",
					role: "app-name",
				}),
			);
		},
	);
	it.each(SEQUENCES)(
		"is refused where a translation of the app name holds %s",
		(_, value) => {
			const { doc, app } = fixture();
			overlay(doc, app.id, value, app.sourceFingerprint);
			expect(
				runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((e) => [
					e.code,
					e.details?.unitId,
				]),
			).toEqual([["APP_STRING_VALUE_UNREPRESENTABLE", app.id]]);
		},
	);

	it("is refused for a backslash before # in a translation of every role that lands in the app strings", () => {
		const doc = localizationWireFixture("prompts");
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const localization = doc.localization;
		if (localization === undefined)
			throw new Error("The prompts fixture holds two languages.");
		const target = localization.languageOrder.find(
			(tag) => tag !== localization.sourceLanguage,
		);
		if (target === undefined) throw new Error("The fixture translates.");
		const roles = new Set<string>();
		const units = collectTranslationUnits(doc).filter((unit) =>
			translationUnitUsesLocaleFile(unit.role),
		);
		for (const unit of units) {
			const value =
				typeof unit.source === "string"
					? String.raw`Texto \#1`
					: proseText(String.raw`Texto \#1`);
			if (translationValueIntegrityIssue(unit, value) !== undefined) continue;
			const candidate = structuredClone(doc);
			const translations = candidate.localization?.translations;
			if (translations === undefined) throw new Error("Translations exist.");
			translations[target] = {
				...translations[target],
				[unit.id]: {
					value,
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: localization.sourceLanguage,
				},
			};
			expect(
				runValidation(candidate, LOOKUP_CONTEXT_UNAVAILABLE)
					.filter((e) => e.code === "APP_STRING_VALUE_UNREPRESENTABLE")
					.map((e) => e.details?.unitId),
				unit.id,
			).toEqual([unit.id]);
			roles.add(unit.role);
		}
		// Every app-string role the fixture holds was checked, not skipped.
		expect([...roles].sort()).toEqual(
			[...new Set(units.map((unit) => unit.role))].sort(),
		);
	});
});

/**
 * A `${` some screen reads through Core's argument filler (`Localizer.processArguments`, which
 * Android's menu list, Register button and Search field labels and every screen title read a
 * menu's or form's name through) is refused in exactly the roles those screens show, in the
 * source text and in a translation, and admitted in every other app string, which no screen
 * reads that way (`lib/commcare/__tests__/localeFile.test.ts` holds each against Core).
 */
describe("a placeholder opener some screen reads", () => {
	const ARGUMENT_ROLES = new Set([
		"module-name",
		"form-name",
		"case-list-menu-item-label",
		"case-list-registration-label",
		"search-input-label",
	]);

	it("is refused in the source's menu and form names", () => {
		const { doc } = fixture();
		for (const module of Object.values(doc.modules))
			module.name = `Visits \${0}`;
		for (const form of Object.values(doc.forms)) form.name = `Visit a\${b`;
		const found = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === "APP_STRING_VALUE_UNREPRESENTABLE",
		);
		expect(found.map((e) => e.details?.role).sort()).toEqual([
			"form-name",
			"module-name",
		]);
		expect(found[0]?.message).toContain("${");
	});

	it("is admitted in the app's name, which no screen reads as a placeholder, and where the screens show it as typed", () => {
		const { doc } = fixture();
		doc.appName = `Clinic \${0}`;
		for (const module of Object.values(doc.modules)) module.name = `\${open`;
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("is refused in a translation of exactly the roles a screen reads as a placeholder", () => {
		const doc = localizationWireFixture("prompts");
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const localization = doc.localization;
		if (localization === undefined)
			throw new Error("The prompts fixture holds two languages.");
		const target = localization.languageOrder.find(
			(tag) => tag !== localization.sourceLanguage,
		);
		if (target === undefined) throw new Error("The fixture translates.");
		const refused = new Set<string>();
		const admitted = new Set<string>();
		for (const unit of collectTranslationUnits(doc)) {
			if (!translationUnitUsesLocaleFile(unit.role)) continue;
			const value =
				typeof unit.source === "string"
					? `Texto \${0}`
					: proseText(`Texto \${0}`);
			if (translationValueIntegrityIssue(unit, value) !== undefined) continue;
			const candidate = structuredClone(doc);
			const translations = candidate.localization?.translations;
			if (translations === undefined) throw new Error("Translations exist.");
			translations[target] = {
				...translations[target],
				[unit.id]: {
					value,
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: localization.sourceLanguage,
				},
			};
			const found = runValidation(candidate, LOOKUP_CONTEXT_UNAVAILABLE)
				.filter((e) => e.code === "APP_STRING_VALUE_UNREPRESENTABLE")
				.map((e) => e.details?.unitId);
			if (ARGUMENT_ROLES.has(unit.role)) {
				expect(found, unit.id).toEqual([unit.id]);
				refused.add(unit.role);
			} else {
				expect(found, unit.id).toEqual([]);
				admitted.add(unit.role);
			}
		}
		// The fixture reaches the roles both ways, so neither side of the rule went unchecked.
		for (const role of ["module-name", "form-name", "search-input-label"])
			expect(refused).toContain(role);
		for (const role of ["app-name", "search-input-hint"])
			expect(admitted).toContain(role);
	});
});
