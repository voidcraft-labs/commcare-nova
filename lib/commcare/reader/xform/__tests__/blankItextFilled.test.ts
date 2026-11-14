/**
 * A form's text left blank in one language beside another language's text.
 *
 * Contract: the export writes each language's filled text, the form builder's
 * fill (`translationFill.ts::filledProse`): a blank value takes the default
 * language's text, else the first language's in order that holds one. A
 * document whose source is blank there and the document whose source holds the
 * filled text print one source, as do a blank translation and none, so a
 * reading returns the second of each pair, and `prose.ts::blankItextFilled`
 * rewrites the first into it: the source slot takes the filled text, a blank
 * translation the filled text or nothing where that equals the source, and
 * every other translation of a text whose source moved is kept against the
 * new source. A document with no such blank is left as it is.
 *
 * Plausible failures: the reading returning the filled text while the
 * document compared with it holds the blank, with no finding; the rewrite
 * changing what some language prints; a translation of a moved source dropped
 * as out of date.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type LanguageTag,
	makeTranslationUnitId,
	type ProseTemplate,
	proseText,
	type TranslationEntry,
	translationSourceFingerprint,
} from "@/lib/domain";
import { expandDoc } from "../../../expander";
import { runValidation } from "../../../validator/runner";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { readHqApp } from "../../index";
import { blankItextFilled } from "../prose";

const FRA = "fra" as LanguageTag;
const SPA = "spa" as LanguageTag;
const WIRE_CODE: Readonly<Record<string, string>> = { fra: "fra", spa: "es" };

/** A survey of one question `q` whose label is `source` in English and each translation in the
 *  languages after it, English first and the source. */
function labelled(
	source: ProseTemplate,
	translations: Readonly<Record<string, ProseTemplate>>,
): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [f({ kind: "text", id: "q", label: source })],
					},
				],
			},
		],
	});
	const languages = Object.keys(translations) as LanguageTag[];
	const unit = labelUnit(doc);
	const next = produce(doc, (draft) => {
		draft.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", ...languages] as LanguageTag[],
			wireCodes: Object.fromEntries([
				["eng", "en"],
				...languages.map((language) => [language, WIRE_CODE[language]]),
			]),
			translations: Object.fromEntries(
				languages.map((language) => [
					language,
					{
						[unit]: {
							value: translations[language],
							sourceFingerprint: translationSourceFingerprint("prose", source),
							origin: "human",
							review: "reviewed",
							translatedFrom: "eng",
						},
					},
				]),
			),
		} as never;
	});
	expect(runValidation(next, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return next;
}

function labelUnit(doc: BlueprintDoc) {
	const q = Object.values(doc.fields).find((one) => one.id === "q");
	if (q === undefined) throw new Error("No question q.");
	return makeTranslationUnitId("field", q.uuid, "label");
}

function label(doc: BlueprintDoc): unknown {
	return (
		Object.values(doc.fields).find((one) => one.id === "q") as {
			label?: unknown;
		}
	).label;
}

function entry(value: ProseTemplate, source: ProseTemplate): TranslationEntry {
	return {
		value,
		sourceFingerprint: translationSourceFingerprint("prose", source),
		origin: "human",
		review: "reviewed",
		translatedFrom: "eng",
	};
}

/** The document a reading of `doc`'s export gives, with no finding and no defect. */
async function readBack(doc: BlueprintDoc): Promise<BlueprintDoc> {
	const outcome = readHqApp(
		await inputFor(exportedBody(doc), {
			resolver: matchingResolver(
				"app-1",
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
		}),
	);
	expect(outcome.defects).toEqual([]);
	expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
	if (outcome.kind !== "read") throw new Error("The export did not read.");
	return outcome.draft.doc;
}

/** Both members print one source, the row is a fixed point on its member, and a reading of the
 *  export gives the member's text in every language. */
async function holdsThePair(doc: BlueprintDoc): Promise<BlueprintDoc> {
	const member = blankItextFilled(doc);
	expect(member).not.toBe(doc);
	expect(JSON.stringify(expandDoc(member))).toBe(
		JSON.stringify(expandDoc(doc)),
	);
	expect(blankItextFilled(member)).toBe(member);
	const read = await readBack(doc);
	const unit = labelUnit(doc);
	expect(label(read)).toEqual(label(member));
	const translations = (one: BlueprintDoc) =>
		Object.fromEntries(
			Object.entries(one.localization?.translations ?? {}).map(
				([language, entries]) => [language, entries[unit]],
			),
		);
	expect(translations(read)).toEqual(translations(member));
	return member;
}

describe("a form's text left blank beside another language's text", () => {
	it("gives a blank source the text the form builder fills it with", async () => {
		const member = await holdsThePair(
			labelled(proseText(""), { [FRA]: proseText("Bonjour") }),
		);
		expect(label(member)).toEqual(proseText("Bonjour"));
		expect(member.localization?.translations[FRA]).toEqual({});
	});

	it("gives a blank translation nothing where the filled text is the source's", async () => {
		const member = await holdsThePair(
			labelled(proseText("Hello"), { [FRA]: proseText("") }),
		);
		expect(label(member)).toEqual(proseText("Hello"));
		expect(member.localization?.translations[FRA]).toEqual({});
	});

	it("keeps another language's translation of a source that moved, against the new source", async () => {
		const doc = labelled(proseText(""), {
			[FRA]: proseText("Bonjour"),
			[SPA]: proseText("Hola"),
		});
		const member = await holdsThePair(doc);
		expect(label(member)).toEqual(proseText("Bonjour"));
		expect(member.localization?.translations[SPA]).toEqual({
			[labelUnit(doc)]: entry(proseText("Hola"), proseText("Bonjour")),
		});
	});

	it("leaves a document with no blank beside text as it is, and a text blank everywhere", () => {
		const translated = labelled(proseText("Hello"), {
			[FRA]: proseText("Bonjour"),
		});
		expect(blankItextFilled(translated)).toBe(translated);
		const blank = labelled(proseText(""), { [FRA]: proseText("") });
		expect(blankItextFilled(blank)).toBe(blank);
	});
});
