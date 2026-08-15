import { describe, expect, it } from "vitest";
import {
	makeTranslationUnitId,
	type ProseTemplate,
	type TranslationUnit,
	translationSourceFingerprint,
	uuidSchema,
} from "@/lib/domain";
import {
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
});
