/**
 * Contract: a document whose search prints Nova's own sentences reads back, whole, to the
 * document after the reader's canonical choices, with the source language those choices keep: its
 * own where its first language translates a search guard or the required message, its first
 * language where that translates neither. Each Search field's required and validation messages,
 * and each system unit, show every language the text the document showed.
 *
 * The failure it catches: a reading whose first language translates one of Nova's sentences taken
 * as that language's source, where no document can hold the stored text (an `unrecognized`
 * `schema:Assertion.text`); a translated required message read as a message of the field's own;
 * a guard's translation read into the source language; a canonical choice that re-sources a
 * document the reading keeps on its own source, or keeps one the reading moves.
 */
import { describe, expect, it } from "vitest";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import type {
	BlueprintDoc,
	LanguageTag,
	TranslationUnitId,
} from "@/lib/domain";
import {
	effectiveAppLocalization,
	makeTranslationUnitId,
} from "@/lib/domain/localization";
import { projectProseTemplate } from "@/lib/domain/prose";
import { searchRuntimeValidationMessage } from "@/lib/domain/searchRuntimeValidationMessages";
import {
	localizeTranslationUnit,
	snapshotTranslationUnits,
} from "@/lib/domain/translationUnits";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { readHqApp } from "../../index";

const QUOTE_KEY = searchRuntimeValidationMessage(new Set(["quote"]))?.key ?? "";
const GUARD = makeTranslationUnitId("system", "search-validation", QUOTE_KEY);
const REQUIRED = makeTranslationUnitId("system", "search-required", "default");

function canonical(doc: BlueprintDoc): BlueprintDoc {
	return READER_CANONICAL_CHOICES.reduce(
		(current, choice) => choice.apply(current),
		doc,
	);
}

/** A unit's text in each language as Nova's export writes it (a Search text is no itext, so no
 *  fill applies). */
function textsOf(
	doc: BlueprintDoc,
	unitId: TranslationUnitId,
): Record<string, string> {
	const unit = snapshotTranslationUnits(doc).get(unitId);
	if (unit === undefined) return {};
	const out: Record<string, string> = {};
	const { languageOrder } = effectiveAppLocalization(doc.localization);
	for (const language of languageOrder as readonly LanguageTag[]) {
		const value = localizeTranslationUnit(doc, language, unit).effective;
		out[language] =
			typeof value === "string" ? value : projectProseTemplate(value, doc).text;
	}
	return out;
}

/** What a worker reads of the first menu's search, and the document's source language. */
function searchFacts(doc: BlueprintDoc) {
	const module = doc.modules[doc.moduleOrder[0] ?? ""];
	const inputs = module?.caseListConfig?.searchInputs ?? [];
	return {
		source: doc.localization?.sourceLanguage,
		order: doc.localization?.languageOrder,
		system: { guard: textsOf(doc, GUARD), required: textsOf(doc, REQUIRED) },
		fields: inputs.map((input) => ({
			name: input.name,
			required:
				"required" in input && input.required !== undefined
					? {
							own: input.required.message !== undefined,
							texts: textsOf(
								doc,
								makeTranslationUnitId(
									"search-input",
									input.uuid,
									"required-message",
								),
							),
						}
					: undefined,
			validation: textsOf(
				doc,
				makeTranslationUnitId("search-input", input.uuid, "validation-message"),
			),
		})),
	};
}

async function readBack(doc: BlueprintDoc) {
	const outcome = readHqApp(
		await inputFor(exportedBody(doc), {
			resolver: matchingResolver(
				"app-1",
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			recordDialect: recordDialectRoundTrip,
		}),
	);
	return outcome;
}

/** The prompts fixture, Spanish first, English its source; Spanish translating the system units
 *  where `translated`, and none of them otherwise. */
function prompts(translated: boolean): BlueprintDoc {
	const doc = localizationWireFixture("prompts");
	const spanish = doc.localization?.translations.spa;
	if (spanish === undefined) throw new Error("The fixture holds no Spanish.");
	if (!translated) {
		delete spanish[GUARD];
		delete spanish[REQUIRED];
	}
	return doc;
}

describe("the source language of a document whose search prints Nova's sentences", () => {
	it("stays the document's own where its first language translates them", async () => {
		const doc = prompts(true);
		const want = canonical(doc);
		expect(want.localization?.sourceLanguage).toBe("eng");
		const outcome = await readBack(doc);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") return;
		expect(searchFacts(outcome.draft.doc)).toEqual(searchFacts(want));
	});

	it("is the first language where that translates none of them", async () => {
		const doc = prompts(false);
		const want = canonical(doc);
		expect(want.localization?.sourceLanguage).toBe("spa");
		const outcome = await readBack(doc);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") return;
		expect(searchFacts(outcome.draft.doc)).toEqual(searchFacts(want));
	});
});
