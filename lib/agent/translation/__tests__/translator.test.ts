/** Pure codec and deterministic grouping tests. Synthetic units isolate the
 * protocol; they do not assert app inventory completeness or translation quality. */
import { describe, expect, it } from "vitest";
import {
	makeTranslationUnitId,
	type ProseTemplate,
	type TranslationUnit,
	translationSourceFingerprint,
	uuidSchema,
} from "@/lib/domain";
import { TranslationMemory } from "../translationMemory";
import {
	boundedGlossary,
	decodeTranslatedValue,
	encodeTranslatedValue,
	encodeTranslationUnit,
	glossaryEntriesFromAcceptedBatch,
	planTranslationBatches,
	translationLanguage,
	translationPromptPayload,
	validateTranslationBatchOutput,
} from "../translator";

const FORM = uuidSchema.parse("11111111-1111-4111-8111-111111111111");
const FIELD = uuidSchema.parse("22222222-2222-4222-8222-222222222222");
const MODULE = uuidSchema.parse("33333333-3333-4333-8333-333333333333");

function textUnit(
	id: string,
	source: string,
	overrides: Partial<TranslationUnit> = {},
): TranslationUnit {
	return {
		id: makeTranslationUnitId(id),
		valueKind: "text",
		role: "field-label",
		source,
		sourceFingerprint: translationSourceFingerprint("text", source),
		contentPolicy: "require-nonblank",
		owner: {
			kind: "field",
			moduleUuid: MODULE,
			formUuid: FORM,
			fieldUuid: FIELD,
		},
		breadcrumb: ["Intake", "Patient name"],
		context: { fieldId: "patient_name", fieldKind: "text" },
		...overrides,
	};
}

describe("translation protocol", () => {
	it("round-trips typed prose references through exact protected tokens", () => {
		const source: ProseTemplate = {
			parts: [
				{ kind: "text" as const, text: "Confirm " },
				{ kind: "field-ref" as const, uuid: FIELD },
				{ kind: "text" as const, text: " before continuing" },
			],
		};
		const unit: TranslationUnit = {
			...textUnit("prose", "unused"),
			valueKind: "prose",
			source,
			sourceFingerprint: translationSourceFingerprint("prose", source),
		};
		const encoded = encodeTranslationUnit(unit);
		expect(encoded.protectedTokens).toHaveLength(1);
		const token = encoded.protectedTokens[0];
		if (token === undefined) throw new Error("protected token missing");
		expect(
			decodeTranslatedValue(encoded, `Avant de continuer, confirmez ${token}.`),
		).toEqual({
			parts: [
				{ kind: "text", text: "Avant de continuer, confirmez " },
				{ kind: "field-ref", uuid: FIELD },
				{ kind: "text", text: "." },
			],
		});
		expect(() => decodeTranslatedValue(encoded, "Avant de continuer.")).toThrow(
			"exactly once",
		);
		expect(() =>
			decodeTranslatedValue(encoded, `${token} puis ${token}`),
		).toThrow("exactly once");
		expect(() =>
			decodeTranslatedValue(encoded, `${token} puis ⟦NOVA_REF_deadbeef00_99⟧`),
		).toThrow("foreign protected token");
	});

	it("protects marker-shaped literal source text without accepting invented markers", () => {
		const literalMarker = "⟦NOVA_REF_user-authored-marker⟧";
		const source: ProseTemplate = {
			parts: [{ kind: "text", text: `Show ${literalMarker} literally` }],
		};
		const unit: TranslationUnit = {
			...textUnit("literal-marker", "unused"),
			valueKind: "prose",
			source,
			sourceFingerprint: translationSourceFingerprint("prose", source),
		};
		const encoded = encodeTranslationUnit(unit);
		expect(encoded.sourceText).not.toContain(literalMarker);
		const protectedLiteral = encoded.protectedTokens[0];
		if (protectedLiteral === undefined) {
			throw new Error("literal marker was not protected");
		}
		expect(
			decodeTranslatedValue(
				encoded,
				`Afficher ${protectedLiteral} littéralement`,
			),
		).toEqual({
			parts: [
				{
					kind: "text",
					text: `Afficher ${literalMarker} littéralement`,
				},
			],
		});
	});

	it("disambiguates a real reference from literal text spelling its generated token", () => {
		const original: TranslationUnit = {
			...textUnit("collision", "unused"),
			valueKind: "prose",
			source: { parts: [{ kind: "field-ref", uuid: FIELD }] },
		};
		const marker = encodeTranslationUnit(original).protectedTokens[0];
		if (!marker) throw new Error("reference token missing");
		const source: ProseTemplate = {
			parts: [
				{ kind: "field-ref", uuid: FIELD },
				{ kind: "text", text: ` and literal ${marker}` },
			],
		};
		const encoded = encodeTranslationUnit({
			...original,
			source,
			sourceFingerprint: translationSourceFingerprint("prose", source),
		});
		expect(encoded.protectedTokens).toHaveLength(2);
		expect(new Set(encoded.protectedTokens).size).toBe(2);
		expect(encoded.protectedTokens).not.toContain(marker);
		expect(
			decodeTranslatedValue(
				encoded,
				`${encoded.protectedTokens[1]} puis ${encoded.protectedTokens[0]}`,
			),
		).toEqual({
			parts: [
				{ kind: "text", text: `${marker} puis ` },
				{ kind: "field-ref", uuid: FIELD },
			],
		});
	});

	it("splits large owning screens without losing units and keeps an indivisible oversized unit alone", () => {
		const units = Array.from({ length: 8 }, (_, index) =>
			textUnit(`large-${index}`, `Instruction ${index}: ${"a".repeat(12000)}`),
		);
		const batches = planTranslationBatches(units);
		expect(batches.length).toBeGreaterThan(1);
		expect(
			batches.every((batch) => batch.length > 0 && batch.length < units.length),
		).toBe(true);
		expect(batches.flat().map((unit) => unit.unitId)).toEqual(
			units.map((unit) => unit.id),
		);
		const giant = textUnit("giant", "b".repeat(100000));
		const isolated = planTranslationBatches([units[0], giant, units[1]]);
		expect(isolated.map((batch) => batch.map((unit) => unit.unitId))).toEqual([
			[units[0].id],
			[giant.id],
			[units[1].id],
		]);
		expect(isolated[1][0].sourceText).toBe(giant.source);
	});

	it("requires exactly one valid result for every requested unit", () => {
		const first = encodeTranslationUnit(textUnit("first", "Name"));
		const second = encodeTranslationUnit(textUnit("second", "Age"));
		expect(
			validateTranslationBatchOutput([first, second], {
				translations: [
					{ unitId: first.unitId, translatedText: "Nombre" },
					{ unitId: second.unitId, translatedText: "Edad" },
				],
			}),
		).toEqual(
			new Map([
				[first.unitId, "Nombre"],
				[second.unitId, "Edad"],
			]),
		);
		expect(() =>
			validateTranslationBatchOutput([first, second], {
				translations: [{ unitId: first.unitId, translatedText: "Nombre" }],
			}),
		).toThrow("omitted");
		expect(() =>
			validateTranslationBatchOutput([first], {
				translations: [
					{ unitId: first.unitId, translatedText: "Nombre" },
					{ unitId: first.unitId, translatedText: "Nombre" },
				],
			}),
		).toThrow("repeated");
		expect(() =>
			validateTranslationBatchOutput([first], {
				translations: [{ unitId: first.unitId, translatedText: "  " }],
			}),
		).toThrow("cannot be blank");
	});

	it("refuses a foreign unit and accepts blank text only when its slot permits blank", () => {
		const unit = encodeTranslationUnit(
			textUnit("requested", "Hint", { contentPolicy: "allow-blank" }),
		);
		expect(
			validateTranslationBatchOutput([unit], {
				translations: [{ unitId: unit.unitId, translatedText: "" }],
			}),
		).toEqual(new Map([[unit.unitId, ""]]));
		expect(() =>
			validateTranslationBatchOutput([unit], {
				translations: [{ unitId: "foreign", translatedText: "Hint" }],
			}),
		).toThrow("unexpected unit");
	});

	it("rejects locale-file-unsafe app strings before accepting a paid batch", () => {
		const app = encodeTranslationUnit(
			textUnit("app-locale-value", "Application", {
				role: "app-name",
				owner: { kind: "app" },
			}),
		);
		for (const translatedText of [
			" Application",
			"Application\r",
			"App\\nName",
		]) {
			expect(() =>
				validateTranslationBatchOutput([app], {
					translations: [{ unitId: app.unitId, translatedText }],
				}),
			).toThrow(`Translation unit ${app.unitId}`);
		}

		const field = encodeTranslationUnit(textUnit("ordinary-label", "Name"));
		expect(
			validateTranslationBatchOutput([field], {
				translations: [{ unitId: field.unitId, translatedText: " Nombre " }],
			}),
		).toEqual(new Map([[field.unitId, " Nombre "]]));
	});

	it("keeps units from one owning form together before moving to another screen", () => {
		const sameForm = textUnit("same-form", "Age", {
			owner: {
				kind: "field",
				moduleUuid: MODULE,
				formUuid: FORM,
				fieldUuid: uuidSchema.parse("44444444-4444-4444-8444-444444444444"),
			},
		});
		const app = textUnit("app", "Application", {
			role: "app-name",
			owner: { kind: "app" },
		});
		const batches = planTranslationBatches([
			textUnit("first", "Name"),
			app,
			sameForm,
		]);
		expect(batches.map((batch) => batch.map((unit) => unit.unitId))).toEqual([
			[makeTranslationUnitId("first"), makeTranslationUnitId("same-form")],
			[makeTranslationUnitId("app")],
		]);
	});

	it("keeps the newest bounded glossary without admitting one oversized entry", () => {
		const glossary = boundedGlossary([
			{ source: "older source", target: "older target" },
			{ source: "x".repeat(6_001), target: "oversized" },
			{ source: "newer source", target: "newer target" },
		]);
		expect(glossary).toEqual([
			{ source: "older source", target: "older target" },
			{ source: "newer source", target: "newer target" },
		]);
		expect(
			glossary.reduce(
				(total, entry) => total + entry.source.length + entry.target.length,
				0,
			),
		).toBeLessThanOrEqual(6_000);

		const numbered = Array.from({ length: 45 }, (_, index) => ({
			source: `source-${index}`,
			target: `target-${index}`,
		}));
		expect(boundedGlossary(numbered)).toEqual(numbered.slice(-40));
	});

	it("retains protected template wording as context and projects moved references into each entry's token alphabet", () => {
		const source: ProseTemplate = {
			parts: [
				{ kind: "text", text: "Item: " },
				{ kind: "case-ref", caseType: "item", property: "case_name" },
				{ kind: "text", text: "\n\nRecorded by: " },
				{ kind: "user-ref", property: "username" },
			],
		};
		const first: TranslationUnit = {
			...textUnit("history-one", "unused", { role: "field-help" }),
			valueKind: "prose",
			source,
			sourceFingerprint: translationSourceFingerprint("prose", source),
		};
		const encoded = encodeTranslationUnit(first);
		const [item, worker] = encoded.protectedTokens;
		const output = {
			translations: [
				{
					unitId: first.id,
					translatedText: `Objeto: ${item}\\n\\nRegistrado por: ${worker}`,
				},
			],
		};
		const value = validateTranslationBatchOutput([encoded], output).get(
			first.id,
		);
		if (value === undefined || typeof value === "string")
			throw new Error("Missing accepted prose value");
		expect(value).toEqual({
			parts: [
				{ kind: "text", text: "Objeto: " },
				{ kind: "case-ref", caseType: "item", property: "case_name" },
				{ kind: "text", text: "\n\nRegistrado por: " },
				{ kind: "user-ref", property: "username" },
			],
		});
		const glossary = glossaryEntriesFromAcceptedBatch([encoded], output);
		expect(glossary).toMatchObject([
			{
				source: encoded.sourceText,
				target: `Objeto: ${item}\n\nRegistrado por: ${worker}`,
				role: "field-help",
				protectedTokens: [item, worker],
			},
		]);
		const memory = new TranslationMemory([]);
		memory.accept(first, value);
		const second = {
			...first,
			id: makeTranslationUnitId("history-two"),
			owner: {
				kind: "field" as const,
				moduleUuid: MODULE,
				formUuid: uuidSchema.parse("55555555-5555-4555-8555-555555555555"),
				fieldUuid: FIELD,
			},
		};
		const remapped = encodeTranslatedValue(
			encodeTranslationUnit(second),
			value,
		);
		expect(remapped).toContain(
			encodeTranslationUnit(second).protectedTokens[0],
		);
		expect(remapped).not.toContain(item);
		memory.accept(second, {
			parts: [{ kind: "text", text: "Artículo: " }, ...value.parts.slice(1)],
		});
		expect(memory.glossary([encodeTranslationUnit(second)])).toMatchObject([
			{
				target: expect.stringContaining("Objeto:"),
				protectedTokens: [item, worker],
			},
			{
				target: expect.stringContaining("Artículo:"),
				protectedTokens: encodeTranslationUnit(second).protectedTokens,
			},
		]);
	});

	it("preserves literal escape instructions and refuses loss of source line breaks", () => {
		const literal = encodeTranslationUnit(
			textUnit("literal-newline", "Type \\n literally\nThen continue"),
		);
		expect(
			decodeTranslatedValue(
				literal,
				"Escriba \\n literalmente\nLuego continúe",
			),
		).toBe("Escriba \\n literalmente\nLuego continúe");
		const multiline = encodeTranslationUnit(
			textUnit("multiline", "First line\nSecond line"),
		);
		expect(() =>
			decodeTranslatedValue(multiline, "Primera línea. Segunda línea."),
		).toThrow("line breaks");
		const paragraphs = encodeTranslationUnit(
			textUnit("paragraphs", "First paragraph\n\nSecond paragraph"),
		);
		expect(() =>
			decodeTranslatedValue(paragraphs, "Primer párrafo\nSegundo párrafo"),
		).toThrow("paragraph breaks");
		const memory = new TranslationMemory([]);
		memory.accept(paragraphs.unit, "Primer párrafo\\n\\nSegundo párrafo");
		expect(memory.glossary([paragraphs])).toEqual([]);
	});

	it("sends Bank and Other with their own workflow/question context alongside distinct accepted wording", () => {
		const option = (id: string, question: string): TranslationUnit => {
			const source: ProseTemplate = {
				parts: [{ kind: "text", text: "Other" }],
			};
			return textUnit(id, "unused", {
				valueKind: "prose",
				source,
				sourceFingerprint: translationSourceFingerprint("prose", source),
				role: "select-option-label",
				breadcrumb: ["Intake", question, "other"],
				context: {
					fieldId: id,
					fieldKind: "single_select",
					optionValue: "other",
				},
				owner: {
					kind: "select-option",
					moduleUuid: MODULE,
					formUuid: FORM,
					fieldUuid: FIELD,
					optionUuid: uuidSchema.parse("66666666-6666-4666-8666-666666666666"),
				},
			});
		};
		const vaccine = option("vaccine", "Which vaccine?");
		const medicine = option("medicine", "Which medicine?");
		const memory = new TranslationMemory([]);
		memory.accept(vaccine, { parts: [{ kind: "text", text: "Otra" }] });
		const finance = textUnit("finance-bank", "Bank", {
			breadcrumb: ["Household finances", "Bank"],
			context: {
				formName: "Household finances",
				fieldKind: "text",
				fieldId: "bank",
			},
		});
		const river = textUnit("river-bank", "Bank", {
			breadcrumb: ["River inspection", "Bank"],
			context: {
				formName: "River inspection",
				fieldKind: "text",
				fieldId: "bank",
			},
		});
		memory.accept(finance, "Banco");
		const units = [
			encodeTranslationUnit(river),
			encodeTranslationUnit(medicine),
		];
		const payload = translationPromptPayload({
			sourceLanguage: translationLanguage({ language: "eng" }),
			targetLanguage: translationLanguage({ language: "spa" }),
			appObjective: "Field collection",
			units,
			glossary: memory.glossary(units),
		});
		// Banco/Otra are prior context; Orilla/Otro require contextual judgment.
		expect(payload.units).toMatchObject([
			{
				unitId: river.id,
				sourceText: "Bank",
				breadcrumb: ["River inspection", "Bank"],
				context: { formName: "River inspection" },
			},
			{
				unitId: medicine.id,
				sourceText: "Other",
				breadcrumb: ["Intake", "Which medicine?", "other"],
				context: { fieldKind: "single_select", optionValue: "other" },
			},
		]);
		expect(payload.glossary).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "Other",
					target: "Otra",
					breadcrumb: ["Intake", "Which vaccine?", "other"],
				}),
				expect.objectContaining({
					source: "Bank",
					target: "Banco",
					breadcrumb: ["Household finances", "Bank"],
				}),
			]),
		);
	});

	it("seeds only current accepted translations and keeps saved navigation names within bounded context", () => {
		const menu = textUnit("saved-menu", "Find an item", {
			role: "module-name",
			owner: { kind: "module", moduleUuid: MODULE },
		});
		const current = (
			status: "ready" | "needs-review" | "out-of-date",
			origin: "ai" | "copied",
		) => ({
			...menu,
			status,
			language: "spa" as const,
			effective: "Buscar un objeto",
			explicit: {
				value: "Buscar un objeto",
				sourceFingerprint: menu.sourceFingerprint,
				origin,
				review: "needs-review" as const,
				translatedFrom: "eng" as const,
			},
		});
		for (const unit of [
			current("out-of-date", "ai"),
			current("needs-review", "copied"),
		]) {
			expect(
				new TranslationMemory([unit]).glossary([encodeTranslationUnit(menu)]),
			).toEqual([]);
		}
		const memory = new TranslationMemory([current("needs-review", "ai")]);
		for (let index = 0; index < 50; index++) {
			memory.accept(
				textUnit(`unrelated-${index}`, `Source ${index}`),
				`Target ${index}`,
			);
		}
		const context = memory.glossary([
			encodeTranslationUnit(textUnit("directions", "Go to Find an item")),
		]);
		expect(context).toContainEqual(
			expect.objectContaining({
				source: "Find an item",
				target: "Buscar un objeto",
				role: "module-name",
			}),
		);
		expect(context.length).toBeLessThanOrEqual(40);
		expect(
			context.reduce((size, entry) => size + JSON.stringify(entry).length, 0),
		).toBeLessThanOrEqual(6000);
	});
});
