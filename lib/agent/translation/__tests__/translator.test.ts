import { describe, expect, it } from "vitest";
import {
	makeTranslationUnitId,
	type ProseTemplate,
	type TranslationUnit,
	translationSourceFingerprint,
	uuidSchema,
} from "@/lib/domain";
import {
	boundedGlossary,
	decodeTranslatedValue,
	encodeTranslationUnit,
	planTranslationBatches,
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
			sameForm,
			app,
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
});
