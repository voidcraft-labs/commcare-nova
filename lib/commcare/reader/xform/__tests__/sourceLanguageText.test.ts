/**
 * A form's text read in an app whose source language is not its first.
 *
 * Contract: where the reading's source language is not HQ's first language
 * (the first translates one of Nova's own sentences, so the source is the
 * next language that holds them all), each slot of a form (a question's
 * label, hint, help text and validation message, a choice's label) holds the
 * source language's text, every other language's text is its translation,
 * the first included, and the media of a label, a help text and a choice is
 * read whatever the language. Nova's export of such a document reads back to
 * the same text in every language, with no finding.
 *
 * Plausible failures: the first language's text read into the slots of a
 * document sourced in another, which then prints the first language's text
 * where the source's stood; the source language's text written as a
 * translation of itself; a blank rule keyed to the source rather than to the
 * default language the form builder fills from.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	effectiveAppLocalization,
	type LocalizedValue,
	makeTranslationUnitId,
	plainColumn,
	proseText,
	simpleSearchInputDef,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import {
	snapshotTranslationUnits,
	storedTranslationValue,
} from "@/lib/domain/translationUnits";
import { runValidation } from "../../../validator/runner";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { readHqApp } from "../../index";
import type { ReaderMediaResolution } from "../../types";

const NAME_INPUT = testUuid("6a6a6a6a-6a6a-4a6a-8a6a-000000000001");
const PICTURE = asMediaAssetId(
	testUuid("6a6a6a6a-6a6a-4a6a-8a6a-0000000000a1"),
);
const SOUND = asMediaAssetId(testUuid("6a6a6a6a-6a6a-4a6a-8a6a-0000000000a2"));
/* One file per kind: the test manifest gives two assets of one kind the same bytes, so the same
 * path. */
const CHOICE_VIDEO = asMediaAssetId(
	testUuid("6a6a6a6a-6a6a-4a6a-8a6a-0000000000a3"),
);

/** Spanish first, English the source: Spanish translates the required message Nova writes for
 *  a Search field with none of its own, so a reading takes English as the source. */
function sourcedAfterFirst(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Health app",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(
							testUuid("6a6a6a6a-6a6a-4a6a-8a6a-000000000002"),
							"case_name",
							"Name",
						),
					],
					searchInputs: [
						simpleSearchInputDef(
							NAME_INPUT,
							"case_name",
							"Name",
							"text",
							"case_name",
							{ required: {} },
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
								hint: proseText("First and last name"),
								help: proseText("As written on the card"),
								validate: "string-length(.) > 1",
								validate_msg: proseText("Write two letters or more"),
								label_media: { image: PICTURE },
								help_media: { audio: SOUND },
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "single_select",
								id: "color",
								label: proseText("Color"),
								options: [
									{
										value: "red",
										label: "Red",
										media: { video: CHOICE_VIDEO },
									},
									{ value: "blue", label: "Blue" },
								],
							}),
						],
					},
				],
			},
		],
	});
	const fieldUuid = (id: string) => {
		const found = Object.values(doc.fields).find((field) => field.id === id);
		if (found === undefined) throw new Error(`No field ${id}.`);
		return found.uuid;
	};
	const color = doc.fields[fieldUuid("color")] as {
		optionsSource?: { options?: { uuid: string; value: string }[] };
	};
	const optionUuid = (value: string) => {
		const found = color.optionsSource?.options?.find(
			(one) => one.value === value,
		);
		if (found === undefined) throw new Error(`No choice ${value}.`);
		return found.uuid;
	};
	const name = fieldUuid("case_name");
	const units = translationUnitsById(doc);
	const spanish: Record<TranslationUnitId, TranslationEntry> = {};
	for (const [unitId, value] of new Map<TranslationUnitId, LocalizedValue>([
		[makeTranslationUnitId("field", name, "label"), proseText("Nombre")],
		[
			makeTranslationUnitId("field", name, "hint"),
			proseText("Nombre y apellido"),
		],
		[
			makeTranslationUnitId("field", name, "help"),
			proseText("Como figura en la tarjeta"),
		],
		[
			makeTranslationUnitId("field", name, "validate_msg"),
			proseText("Escriba dos letras o más"),
		],
		[
			makeTranslationUnitId("field", fieldUuid("color"), "label"),
			proseText("Color favorito"),
		],
		[
			makeTranslationUnitId(
				"field",
				fieldUuid("color"),
				"option",
				optionUuid("red"),
			),
			proseText("Rojo"),
		],
		[
			makeTranslationUnitId(
				"field",
				fieldUuid("color"),
				"option",
				optionUuid("blue"),
			),
			proseText("Azul"),
		],
		[
			makeTranslationUnitId("system", "search-required", "default"),
			"Complete esta respuesta antes de buscar.",
		],
	])) {
		const unit = units.get(unitId);
		if (unit === undefined) throw new Error(`No unit ${unitId}.`);
		spanish[unitId] = {
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
		wireCodes: { spa: "es", eng: "en" },
		translations: { spa: spanish },
	};
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

/** The document as the reader returns its pair's member. */
function canonical(doc: BlueprintDoc): BlueprintDoc {
	return READER_CANONICAL_CHOICES.reduce(
		(current, choice) => choice.apply(current),
		doc,
	);
}

/** Each field-owned unit's text in every language. */
function fieldTexts(doc: BlueprintDoc): Record<string, unknown> {
	const { languageOrder } = effectiveAppLocalization(doc.localization);
	return Object.fromEntries(
		[...snapshotTranslationUnits(doc).values()]
			.filter(
				(unit) =>
					unit.owner.kind === "field" || unit.owner.kind === "select-option",
			)
			.map((unit) => [
				unit.id,
				Object.fromEntries(
					languageOrder.map((language) => [
						language,
						storedTranslationValue(doc, language, unit),
					]),
				),
			]),
	);
}

/** Each field's media by its id, a choice's by its value. */
function media(doc: BlueprintDoc): Record<string, unknown> {
	return Object.fromEntries(
		Object.values(doc.fields).map((field) => {
			const slots = field as {
				label_media?: unknown;
				help_media?: unknown;
				optionsSource?: { options?: { value: string; media?: unknown }[] };
			};
			return [
				field.id,
				{
					label: slots.label_media,
					help: slots.help_media,
					choices: slots.optionsSource?.options?.map((option) => [
						option.value,
						option.media,
					]),
				},
			];
		}),
	);
}

const MEDIA_KIND_OF_EXTENSION: Readonly<
	Record<string, "image" | "audio" | "video">
> = { ".png": "image", ".wav": "audio", ".mp4": "video" };

/** A reading of `doc`'s export, each form's source edited by `xml`, with the media index the
 *  export's manifest answers. */
async function readExport(
	doc: BlueprintDoc,
	xml?: (source: string) => string,
): Promise<ReturnType<typeof readHqApp>> {
	const manifest = manifestFor(doc);
	const assetOfPath = new Map(
		[...manifest].map(([assetId, asset]) => [
			`jr://file/${asset.wirePath}`,
			assetId,
		]),
	);
	return readHqApp(
		await inputFor(
			exportedBody(doc, {
				expand: { assets: manifest },
				...(xml !== undefined && { xml }),
			}),
			{
				resolver: matchingResolver(
					"app-1",
					externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				),
				media: {
					resolve: (path): ReaderMediaResolution => {
						const assetId = assetOfPath.get(path);
						if (assetId === undefined) return { kind: "no-entry" };
						const mediaKind =
							MEDIA_KIND_OF_EXTENSION[path.slice(path.lastIndexOf("."))];
						return mediaKind === undefined
							? { kind: "unreadable" }
							: { kind: "asset", assetId, mediaKind };
					},
				},
			},
		),
	);
}

/** The text slots of the question `case_name` in a reading's document. */
function nameSlots(doc: BlueprintDoc): {
	label?: unknown;
	hint?: unknown;
	help?: unknown;
	validate_msg?: unknown;
} {
	const found = Object.values(doc.fields).find(
		(field) => field.id === "case_name",
	);
	if (found === undefined) throw new Error("The reading holds no case_name.");
	return found as never;
}

/** Each finding a reading holds, by its code and name. */
function findingNames(outcome: ReturnType<typeof readHqApp>): string[] {
	return outcome.kind === "account"
		? outcome.findings.map((one) => `${one.code} ${one.detail.name ?? ""}`)
		: [];
}

describe("a form's text where the source language is not the first", () => {
	it("reads each slot in the source language and the first language as its translation", async () => {
		const doc = sourcedAfterFirst();
		const outcome = await readExport(doc);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const read = outcome.draft.doc;
		expect(read.localization?.sourceLanguage).toBe("eng");
		expect(read.localization?.defaultLanguage).toBe("spa");
		const name = nameSlots(read);
		expect(name.label).toEqual(proseText("Name"));
		expect(name.hint).toEqual(proseText("First and last name"));
		expect(name.help).toEqual(proseText("As written on the card"));
		expect(name.validate_msg).toEqual(proseText("Write two letters or more"));
		const want = canonical(doc);
		expect(fieldTexts(read)).toEqual(fieldTexts(want));
		expect(media(read)).toEqual(media(want));
	});

	it("holds a blank source value beside the first language's text as the first language's text, as the form builder fills it", async () => {
		const outcome = await readExport(sourcedAfterFirst(), (xml) =>
			xml.replace("<value>First and last name</value>", "<value/>"),
		);
		expect(outcome.defects).toEqual([]);
		expect(findingNames(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const read = outcome.draft.doc;
		expect(nameSlots(read).hint).toEqual(proseText("Nombre y apellido"));
		// The first language's text is the slot's own, so it is no translation of it.
		const field = Object.values(read.fields).find(
			(one) => one.id === "case_name",
		);
		const unit = makeTranslationUnitId(
			"field",
			field?.uuid ?? ("" as never),
			"hint",
		);
		expect(read.localization?.translations.spa?.[unit]).toBeUndefined();
		expect(nameSlots(read).label).toEqual(proseText("Name"));
	});

	it("refuses a blank in the first language beside the source's text, the language the form builder fills from", async () => {
		const outcome = await readExport(sourcedAfterFirst(), (xml) =>
			xml.replace("<value>Nombre y apellido</value>", "<value/>"),
		);
		expect(outcome.defects).toEqual([]);
		expect(
			outcome.kind === "account"
				? outcome.findings
						.map((one) => one.code)
						.filter((code) => code !== "unrecognized")
				: [],
		).toEqual([
			"questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text",
		]);
	});
});
