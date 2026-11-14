/**
 * The source language of a reading, and of the canonical document a Nova-born
 * document reads back to.
 *
 * Contract: a reading's source language is the first language, in the app's
 * order, that a reading with it as the source prints back at every place
 * Nova's emitter writes a source text apart from a translation: the app's name
 * (`name` in the source language, `app.display.name` in a language whose name
 * differs) and Nova's own sentences (a Search guard's message, the required
 * message of a Search field with none of its own, whose source-language text
 * is always the sentence). Where nothing in the export tells the languages
 * apart it is the first language; the first language stays the default
 * whatever the source. The canonical row `source-language-is-as-read`
 * re-sources a Nova document to that same language with every language's text
 * unchanged, so a document whose export tells its source keeps it, and one
 * whose export tells nothing is sourced in its first language.
 *
 * Plausible failures: the reading sourced in the first language where that
 * language translates the app's name or one of Nova's sentences (the reading
 * then folds the name, or the search does not print back); the canonical row
 * re-sourcing a document the reading keeps, or keeping one the reading
 * re-sources; a re-sourcing that changes some language's text of some unit.
 */
import { describe, expect, it } from "vitest";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	effectiveAppLocalization,
	type LanguageTag,
	type LocalizedValue,
	type TranslationUnitId,
} from "@/lib/domain";
import {
	snapshotTranslationUnits,
	storedTranslationValue,
} from "@/lib/domain/translationUnits";
import { expandDoc } from "../../expander";
import { mintLanguageWireCode } from "../../languageWire";
import { runValidation } from "../../validator/runner";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { READER_CANONICAL_CHOICES } from "../assemble";
import { matchingResolver } from "../identity";
import { externalIdentityMap } from "../identityMap";
import { readHqApp } from "../index";
import { resourcedDocument, sourceLanguageAsRead } from "../languages";
import { exportedBody, inputFor } from "./novaExport";

/** The document as the reader returns its pair's member. */
function canonical(doc: BlueprintDoc): BlueprintDoc {
	return READER_CANONICAL_CHOICES.reduce(
		(current, choice) => choice.apply(current),
		doc,
	);
}

/** Every unit's text in every language, before the form builder's fill. */
function texts(
	doc: BlueprintDoc,
): Map<TranslationUnitId, Record<string, LocalizedValue>> {
	const { languageOrder } = effectiveAppLocalization(doc.localization);
	return new Map(
		[...snapshotTranslationUnits(doc).values()].map((unit) => [
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

/** The document a reading of `doc`'s export gives; the test fails where it gives an account. */
async function readBack(doc: BlueprintDoc): Promise<BlueprintDoc> {
	const outcome = readHqApp(
		await inputFor(exportedBody(doc), {
			resolver: matchingResolver(
				"app-1",
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			recordDialect: recordDialectRoundTrip,
		}),
	);
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "read")
		throw new Error(
			`The export read to an account: ${outcome.findings.map((one) => `${one.code} (${one.detail.name ?? ""})`).join(", ")}`,
		);
	return outcome.draft.doc;
}

/** Every unit of `want` with its texts, and the same units of `got`. */
function sharedTexts(
	want: BlueprintDoc,
	got: BlueprintDoc,
): { want: unknown; got: unknown } {
	const wanted = texts(want);
	const read = texts(got);
	const ids = [...wanted.keys()];
	return {
		want: Object.fromEntries(ids.map((id) => [id, wanted.get(id)])),
		got: Object.fromEntries(ids.map((id) => [id, read.get(id)])),
	};
}

/** `doc` with French between its two languages, untranslated: every text prints in French as
 *  in English, the source. */
function withFrench(doc: BlueprintDoc): BlueprintDoc {
	const localization = doc.localization;
	if (localization === undefined)
		throw new Error("The localization fixtures hold two languages.");
	const fra = "fra" as LanguageTag;
	doc.localization = {
		...localization,
		languageOrder: ["spa", fra, "eng"] as LanguageTag[],
		translations: { ...localization.translations, [fra]: {} },
		wireCodes: {
			...localization.wireCodes,
			[fra]: mintLanguageWireCode(
				new Set(Object.values(localization.wireCodes)),
				{ language: "fra" },
			),
		},
	};
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

describe("the source language a reading takes", () => {
	it("is the first language where nothing in the export tells the languages apart, and the canonical document is re-sourced to it", async () => {
		/* The app's name untranslated, and no search: Spanish first, English the source. */
		const doc = localizationWireFixture("optional");
		expect(doc.localization?.sourceLanguage).toBe("eng");
		const read = await readBack(doc);
		expect(read.localization?.sourceLanguage).toBe("spa");
		expect(read.localization?.defaultLanguage).toBe("spa");
		expect(sourceLanguageAsRead(doc)).toBe("spa");
		const want = canonical(doc);
		expect(want.localization?.sourceLanguage).toBe("spa");
		const { want: wanted, got } = sharedTexts(want, read);
		expect(got).toEqual(wanted);
	});

	it("keeps a document's own source where its first language translates the app's name", async () => {
		const doc = localizationWireFixture("bilingual");
		const read = await readBack(doc);
		expect(read.localization?.sourceLanguage).toBe("eng");
		expect(read.localization?.defaultLanguage).toBe("spa");
		expect(read.appName).toBe(doc.appName);
		expect(sourceLanguageAsRead(doc)).toBe("eng");
		const want = canonical(doc);
		expect(want.localization?.sourceLanguage).toBe("eng");
		const { want: wanted, got } = sharedTexts(want, read);
		expect(got).toEqual(wanted);
	});

	it("is the first language whose app name is the source's where the source is neither first nor alone in holding it", async () => {
		const doc = withFrench(localizationWireFixture("bilingual"));
		const read = await readBack(doc);
		expect(read.localization?.sourceLanguage).toBe("fra");
		expect(read.localization?.defaultLanguage).toBe("spa");
		const want = canonical(doc);
		expect(want.localization?.sourceLanguage).toBe("fra");
		expect(JSON.stringify(expandDoc(want))).toBe(
			JSON.stringify(expandDoc(doc)),
		);
		const { want: wanted, got } = sharedTexts(want, read);
		expect(got).toEqual(wanted);
	});

	it("keeps a document's own source where its first language translates one of Nova's sentences", async () => {
		const doc = localizationWireFixture("prompts");
		const read = await readBack(doc);
		expect(read.localization?.sourceLanguage).toBe("eng");
		expect(read.localization?.defaultLanguage).toBe("spa");
		expect(sourceLanguageAsRead(doc)).toBe("eng");
		const want = canonical(doc);
		expect(want.localization?.sourceLanguage).toBe("eng");
		const { want: wanted, got } = sharedTexts(want, read);
		expect(got).toEqual(wanted);
	});

	it("is the first language where its first language translates none of Nova's sentences, the two printing one export", async () => {
		const doc = localizationWireFixture("prompts");
		const spanish = doc.localization?.translations.spa ?? {};
		for (const unit of snapshotTranslationUnits(doc).values())
			if (unit.role === "search-runtime-validation-message")
				delete spanish[unit.id];
		const read = await readBack(doc);
		expect(read.localization?.sourceLanguage).toBe("spa");
		const want = canonical(doc);
		expect(want.localization?.sourceLanguage).toBe("spa");
		expect(JSON.stringify(expandDoc(want))).toBe(
			JSON.stringify(expandDoc(doc)),
		);
		const { want: wanted, got } = sharedTexts(want, read);
		expect(got).toEqual(wanted);
	});

	it("is the first language that prints every one of Nova's sentences where the source is neither first nor alone in printing them", async () => {
		const doc = withFrench(localizationWireFixture("prompts"));
		const read = await readBack(doc);
		expect(read.localization?.sourceLanguage).toBe("fra");
		expect(read.localization?.defaultLanguage).toBe("spa");
		const want = canonical(doc);
		expect(want.localization?.sourceLanguage).toBe("fra");
		const { want: wanted, got } = sharedTexts(want, read);
		expect(got).toEqual(wanted);
	});
});

describe("resourcedDocument", () => {
	it("changes no language's text of any unit", () => {
		for (const scenario of [
			"bilingual",
			"optional",
			"escaped",
			"mandarin",
		] as const) {
			const doc = canonical(localizationWireFixture(scenario));
			for (const language of doc.localization?.languageOrder ?? []) {
				const resourced = resourcedDocument(doc, language);
				expect(resourced.localization?.sourceLanguage).toBe(language);
				expect(resourced.localization?.defaultLanguage).toBe(
					doc.localization?.defaultLanguage,
				);
				expect(texts(resourced)).toEqual(texts(doc));
				expect(runValidation(resourced, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual(
					[],
				);
			}
		}
	});
});
