/**
 * Contract: Nova's own sentences are one of the places a reading's source language is read at
 * (`languages.ts::readingSourceCode`): over Nova's own export of a document whose app name every
 * language shares, so the sentences alone tell, the source is the first language, in the app's
 * order, whose text is Nova's sentence for every system unit the app's searches print, and the
 * first language where they tell nothing. The failure it catches: a first language that
 * translates a search guard or the required message taken as the source, where the stored bytes
 * hold Nova's sentence only in another language; a sole-holder rule that leaves a three-language
 * app with an untranslated middle language on a first language whose text is no sentence of
 * Nova's; a source moved off the first language where nothing is translated.
 */
import { describe, expect, it } from "vitest";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import type { BlueprintDoc, TranslationUnitId } from "@/lib/domain";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import { searchRuntimeValidationMessage } from "@/lib/domain/searchRuntimeValidationMessages";
import { exportedBody } from "../../__tests__/novaExport";
import { readingSourceCode } from "../../languages";
import { systemSentenceHolders } from "../systemSentences";

const QUOTE_KEY = searchRuntimeValidationMessage(new Set(["quote"]))?.key ?? "";
const GUARD = makeTranslationUnitId("system", "search-validation", QUOTE_KEY);
const REQUIRED = makeTranslationUnitId("system", "search-required", "default");

/** The localization fixture whose search prints both system units, Spanish first and English
 *  its source, Spanish translating both. */
function prompts(): BlueprintDoc {
	return localizationWireFixture("prompts");
}

/** The source and holders Nova's own export of `doc` reads to. */
function read(doc: BlueprintDoc) {
	const body = exportedBody(doc);
	const codes = body.langs as string[];
	return {
		source: readingSourceCode(
			{
				name: body.name,
				translations: body.translations,
				modules: body.modules,
			},
			codes,
		),
		holders: Object.fromEntries(
			[...systemSentenceHolders(body.modules, codes)].map(([unit, held]) => [
				unit,
				[...held],
			]),
		),
	};
}

/** `doc` with Spanish holding no translation of `units`. */
function untranslated(
	doc: BlueprintDoc,
	units: readonly TranslationUnitId[],
): BlueprintDoc {
	const spanish = doc.localization?.translations.spa;
	if (spanish === undefined) throw new Error("The fixture holds no Spanish.");
	for (const unit of units) delete spanish[unit];
	return doc;
}

/** `doc` with French between Spanish and English, translating `units` as Spanish does. */
function withFrench(
	doc: BlueprintDoc,
	units: readonly TranslationUnitId[],
): BlueprintDoc {
	const localization = doc.localization;
	if (localization === undefined) throw new Error("The fixture is English.");
	const spanish = localization.translations.spa ?? {};
	const french = Object.fromEntries(
		units.flatMap((unit) => {
			const entry = spanish[unit];
			return entry === undefined
				? []
				: [[unit, { ...entry, value: `fr ${String(entry.value)}` }]];
		}),
	);
	doc.localization = {
		...localization,
		languageOrder: ["spa", "fra", "eng"],
		wireCodes: { ...localization.wireCodes, fra: "fra" },
		translations: { ...localization.translations, fra: french },
	};
	return doc;
}

describe("the source language of a reading", () => {
	it("is the language that holds Nova's sentences where the first translates them", () => {
		expect(read(prompts())).toEqual({
			source: "en",
			holders: {
				[`search-validation/${QUOTE_KEY}`]: ["en"],
				"search-required/default": ["en"],
			},
		});
	});

	it("is the first language where it translates none of Nova's sentences", () => {
		expect(read(untranslated(prompts(), [GUARD, REQUIRED])).source).toBe("es");
	});

	it("leaves the first language where it translates one sentence and holds the other", () => {
		const { source, holders } = read(untranslated(prompts(), [REQUIRED]));
		expect(holders["search-required/default"]).toEqual(["es", "en"]);
		expect(source).toBe("en");
	});

	it("is the first language that holds every sentence, a middle language untranslated", () => {
		expect(read(withFrench(prompts(), [])).source).toBe("fra");
	});

	it("is the one language that holds every sentence where the others translate them", () => {
		expect(read(withFrench(prompts(), [GUARD, REQUIRED])).source).toBe("en");
	});

	it("is the first language where the app prints none of Nova's sentences", () => {
		const doc = untranslated(prompts(), [GUARD, REQUIRED]);
		const body = exportedBody(doc);
		const modules = (body.modules as Record<string, unknown>[]).map(
			({ search_config: _search, ...rest }) => rest,
		);
		expect(
			readingSourceCode(
				{ name: body.name, translations: body.translations, modules },
				["es", "en"],
			),
		).toBe("es");
		expect(systemSentenceHolders(modules, ["es", "en"]).size).toBe(0);
	});
});
