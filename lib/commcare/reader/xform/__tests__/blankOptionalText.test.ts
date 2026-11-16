/**
 * A hint, a help text or a validation message blank in every language.
 *
 * Contract: the emitter gives an unset optional text the template of no parts
 * (`builder.ts::buildFieldParts`), so a document holding a blank one and a
 * document holding none print one source: no entry for a blank text, and for
 * a help text with media the entry of its media alone. A reading of either
 * holds no text there, and keeps the help text's media;
 * `prose.ts::blankOptionalTextAbsent` is the document the reading returns.
 *
 * Plausible failures: a help text read as a template of no parts beside its
 * media, a document Nova's own export cannot read back to; the choice
 * removing a text that is blank in its source language alone, whose other
 * language a worker reads.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import {
	makeTranslationUnitId,
	translationSourceFingerprint,
} from "@/lib/domain/localization";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import { EMPTY_PROSE_TEMPLATE } from "@/lib/domain/prose";
import { runValidation } from "../../../validator/runner";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";
import type { ReaderMediaResolution } from "../../types";
import { blankOptionalTextAbsent } from "../prose";

const PICTURE = asMediaAssetId(
	testUuid("7b7b7b7b-7b7b-4b7b-8b7b-0000000000a1"),
);

/** One question with a blank hint, a blank help text beside its picture and a blank validation
 *  message on a condition; a second whose help text holds Spanish alone. */
function blankTexts(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Blank texts",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "answer",
								label: proseText("Answer"),
								hint: EMPTY_PROSE_TEMPLATE,
								help: EMPTY_PROSE_TEMPLATE,
								help_media: { image: PICTURE },
								validate: "string-length(.) > 1",
								validate_msg: EMPTY_PROSE_TEMPLATE,
							}),
							f({
								kind: "text",
								id: "spanish_help",
								label: proseText("Spanish help"),
								help: EMPTY_PROSE_TEMPLATE,
							}),
						],
					},
				],
			},
		],
	});
	const spanishHelp = Object.values(doc.fields).find(
		(field) => field.id === "spanish_help",
	);
	if (spanishHelp === undefined) throw new Error("No spanish_help.");
	const unit = makeTranslationUnitId("field", spanishHelp.uuid, "help");
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		wireCodes: { eng: "en", spa: "es" },
		translations: {
			spa: {
				[unit]: {
					value: proseText("Ayuda"),
					sourceFingerprint: translationSourceFingerprint(
						"prose",
						EMPTY_PROSE_TEMPLATE,
					),
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		},
	};
	return doc;
}

/** A field's own record in a document, by its id. */
function field(doc: BlueprintDoc, id: string): Record<string, unknown> {
	const found = Object.values(doc.fields).find((one) => one.id === id);
	if (found === undefined) throw new Error(`No field ${id}.`);
	return found as unknown as Record<string, unknown>;
}

describe("an optional text blank in every language", () => {
	it("prints as none does, reads as none, and keeps a help text's media", async () => {
		const doc = blankTexts();
		const manifest = manifestFor(doc);
		const expand = { assets: manifest };
		const unset = blankOptionalTextAbsent(doc);
		expect(runValidation(unset, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(JSON.stringify(exportedBody(unset, { expand }))).toBe(
			JSON.stringify(exportedBody(doc, { expand })),
		);
		expect(blankOptionalTextAbsent(unset)).toBe(unset);
		const answer = field(unset, "answer");
		expect([answer.hint, answer.help, answer.validate_msg]).toEqual([
			undefined,
			undefined,
			undefined,
		]);
		// A help text blank in English and held in Spanish is a text a worker reads.
		expect(field(unset, "spanish_help").help).toEqual(EMPTY_PROSE_TEMPLATE);

		const pathOf = new Map(
			[...manifest].map(([assetId, asset]) => [
				`jr://file/${asset.wirePath}`,
				assetId,
			]),
		);
		const outcome = readHqApp(
			await inputFor(exportedBody(doc, { expand }), {
				media: {
					resolve: (path): ReaderMediaResolution => {
						const assetId = pathOf.get(path);
						return assetId === undefined
							? { kind: "no-entry" }
							: { kind: "asset", assetId, mediaKind: "image" };
					},
				},
			}),
		);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const read = field(outcome.draft.doc, "answer");
		expect([read.hint, read.help, read.validate_msg]).toEqual([
			undefined,
			undefined,
			undefined,
		]);
		expect(read.help_media).toEqual({ image: PICTURE });
	});
});
