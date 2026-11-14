/**
 * The one reader of "as typed" (`plainText.ts`).
 *
 * Contract: a label, a choice or a help text shows as typed where its own
 * setting says so or its form's text formatting is off; the form's switch
 * reaches every one of them whatever their own setting, and a text's own
 * setting is kept (the readers never change it). `formSwitchedTexts` lists
 * every label, inline choice and help text of one form in every language the
 * app holds, and no hint, validation message, other form's text, or text whose
 * own setting already shows it as typed.
 *
 * Plausible failures: the form's switch not reaching a text, a text's own
 * setting ignored while the switch is off, the inventory missing a choice or
 * a translation, listing a hint or another form's label, or listing a text the
 * switch does not change (the builder would then ask before turning
 * formatting off where no worker would see anything change).
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	formSwitchedTexts,
	helpShowsAsTyped,
	labelShowsAsTyped,
	makeTranslationUnitId,
	type ProseTemplate,
	proseTemplateText,
	proseText,
	snapshotTranslationUnits,
} from "@/lib/domain";

describe("labelShowsAsTyped and helpShowsAsTyped", () => {
	const ON = {};
	const OFF = { plainText: true } as const;

	it("follows the text's own setting while the form's formatting is on", () => {
		expect(labelShowsAsTyped(ON, {})).toBe(false);
		expect(labelShowsAsTyped(ON, { plainLabel: true })).toBe(true);
		expect(helpShowsAsTyped(ON, {})).toBe(false);
		expect(helpShowsAsTyped(ON, { plainHelp: true })).toBe(true);
	});

	it("shows every text as typed while the form's formatting is off", () => {
		for (const owner of [{}, { plainLabel: true } as const])
			expect(labelShowsAsTyped(OFF, owner)).toBe(true);
		for (const field of [{}, { plainHelp: true } as const])
			expect(helpShowsAsTyped(OFF, field)).toBe(true);
	});

	it("reads a label's and a help's settings apart", () => {
		expect(labelShowsAsTyped(ON, { plainHelp: true } as object)).toBe(false);
		expect(helpShowsAsTyped(ON, { plainLabel: true } as object)).toBe(false);
	});
});

function twoFormDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Text",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								id: "pick",
								label: proseText("**Pick**"),
								hint: proseText("A *hint*"),
								help: proseText("Some _help_"),
								validate: ". != 'b'",
								validate_msg: proseText("Not *that*"),
								options: [
									{ value: "a", label: "**A**", uuid: "switched-a" },
									{ value: "b", label: "B", uuid: "switched-b" },
								],
							}),
						],
					},
					{
						name: "Other",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "elsewhere",
								label: proseText("Elsewhere"),
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

const texts = (templates: readonly ProseTemplate[]) =>
	templates.map(proseTemplateText).sort();

describe("formSwitchedTexts", () => {
	it("lists every label, choice and help text of the form, in every language", () => {
		const doc = twoFormDoc();
		const formUuid = doc.formOrder[doc.moduleOrder[0] ?? ""]?.[0];
		if (formUuid === undefined) throw new Error("The fixture has no form.");
		// No Spanish entry is stored, so each language reads the source.
		expect(texts(formSwitchedTexts(doc, formUuid))).toEqual(
			texts(
				["**Pick**", "Some _help_", "**A**", "B"]
					.flatMap((text) => [text, text])
					.map(proseText),
			),
		);
	});

	it("leaves out a text whose own setting already shows it as typed", () => {
		const doc = twoFormDoc();
		const formUuid = doc.formOrder[doc.moduleOrder[0] ?? ""]?.[0];
		const pick = Object.values(doc.fields).find((field) => field.id === "pick");
		if (
			formUuid === undefined ||
			pick === undefined ||
			pick.kind !== "single_select"
		)
			throw new Error("The fixture has no select.");
		const source = pick.optionsSource;
		if (source.kind !== "inline") throw new Error("The select is not inline.");
		const plain = {
			...doc,
			fields: {
				...doc.fields,
				[pick.uuid]: {
					...pick,
					plainLabel: true,
					plainHelp: true,
					optionsSource: {
						...source,
						options: source.options.map((option) =>
							option.value === "a"
								? { ...option, plainLabel: true as const }
								: option,
						),
					},
				},
			},
		} as BlueprintDoc;
		// Workers already see these three texts' symbols, so turning the form's
		// formatting off changes only the choice that still formats.
		expect(texts(formSwitchedTexts(plain, formUuid))).toEqual(
			texts([proseText("B"), proseText("B")]),
		);
	});

	it("reads a current translation in its own language", () => {
		const doc = twoFormDoc();
		const formUuid = doc.formOrder[doc.moduleOrder[0] ?? ""]?.[0];
		const pick = Object.values(doc.fields).find((field) => field.id === "pick");
		if (formUuid === undefined || pick === undefined)
			throw new Error("The fixture has no form.");
		const unitId = makeTranslationUnitId("field", pick.uuid, "help");
		const unit = snapshotTranslationUnits(doc).get(unitId);
		if (unit === undefined) throw new Error("The help has no unit.");
		const translated = {
			...doc,
			localization: {
				...doc.localization,
				translations: {
					spa: {
						[unitId]: {
							value: proseText("Una *ayuda*"),
							sourceFingerprint: unit.sourceFingerprint,
							origin: "human",
							review: "reviewed",
							translatedFrom: "eng",
						},
					},
				},
			},
		} as unknown as BlueprintDoc;
		expect(texts(formSwitchedTexts(translated, formUuid))).toContain(
			"Una *ayuda*",
		);
	});
});
