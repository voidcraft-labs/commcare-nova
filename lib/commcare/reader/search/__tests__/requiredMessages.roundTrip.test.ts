/**
 * Contract: two Search fields that are required, one with no message of its own and one whose own
 * message is Nova's sentence in the source language with its own translation, print the same
 * bytes as the document whose two fields swap which holds the message; the reader returns the
 * document whose first such field, in menu and field order, holds no message
 * (`systemSentences.ts::requiredMessagesAsRead`, the canonical choice `required-messages-as-read`),
 * and a reading of either export is that document, with no finding.
 *
 * The failure it catches: a reading that returns another document than the canonical one for the
 * same bytes with no finding (a field's own message read as Nova's, Nova's message's translation
 * taken from the other field), and a canonical choice that changes what a worker reads.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import {
	type BlueprintDoc,
	type LanguageTag,
	makeTranslationUnitId,
	plainColumn,
	proseText,
	simpleSearchInputDef,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import { effectiveAppLocalization } from "@/lib/domain/localization";
import {
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	type SearchInputRequired,
} from "@/lib/domain/modules";
import {
	localizeTranslationUnit,
	snapshotTranslationUnits,
} from "@/lib/domain/translationUnits";
import { expandDoc } from "../../../expander";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { readHqApp } from "../../index";
import { requiredMessagesAsRead } from "../systemSentences";

const FIRST = testUuid("required-first");
const SECOND = testUuid("required-second");
const SYSTEM = makeTranslationUnitId("system", "search-required", "default");
const NOVA_SPANISH = "Complete esta respuesta antes de buscar.";
const OWN_SPANISH = "Responda esta pregunta, por favor.";

/** Two required Search fields: `own` names the one whose message is Nova's English sentence, its
 *  Spanish `ownSpanish`, and the other holds none, Nova's message reading `novaSpanish`. */
function prompts(
	own: "first" | "second",
	ownSpanish: string,
	novaSpanish: string,
): BlueprintDoc {
	const required = (holds: boolean): SearchInputRequired =>
		holds ? { message: SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE } : {};
	const doc = buildDoc({
		appName: "Health app",
		modules: [
			{
				uuid: testUuid("required-menu"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(testUuid("required-column"), "case_name", "Name"),
					],
					searchInputs: [
						simpleSearchInputDef(FIRST, "name", "Name", "text", "case_name", {
							required: required(own === "first"),
						}),
						simpleSearchInputDef(SECOND, "phone", "Phone", "text", "phone", {
							required: required(own === "second"),
						}),
					],
				},
				caseSearchConfig: {},
				forms: [
					{
						uuid: testUuid("required-form"),
						name: "Register",
						type: "registration",
						fields: [
							f({
								uuid: testUuid("required-name"),
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "phone", label: proseText("Phone"), data_type: "text" },
				],
			},
		],
	});
	const units = translationUnitsById(doc);
	const entry = (
		unitId: TranslationUnitId,
		value: string,
	): TranslationEntry => {
		const unit = units.get(unitId);
		if (unit === undefined) throw new Error(`The document holds no ${unitId}.`);
		return {
			value,
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
		};
	};
	const ownUnit = makeTranslationUnitId(
		"search-input",
		own === "first" ? FIRST : SECOND,
		"required-message",
	);
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		wireCodes: { eng: "en", spa: "es" },
		translations: {
			spa: {
				[ownUnit]: entry(ownUnit, ownSpanish),
				[SYSTEM]: entry(SYSTEM, novaSpanish),
			},
		},
	};
	return doc;
}

function canonical(doc: BlueprintDoc): BlueprintDoc {
	return READER_CANONICAL_CHOICES.reduce(
		(current, choice) => choice.apply(current),
		doc,
	);
}

/** A unit's text in each language as Nova's export writes it. */
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
		out[language] = typeof value === "string" ? value : "";
	}
	return out;
}

/** Which fields hold a message of their own, and every required text the document holds. */
function requiredFacts(doc: BlueprintDoc) {
	const module = doc.modules[doc.moduleOrder[0] ?? ""];
	return {
		system: textsOf(doc, SYSTEM),
		fields: (module?.caseListConfig?.searchInputs ?? []).map((input) => ({
			name: input.name,
			message:
				input.kind === "hidden" ? undefined : (input.required?.message ?? null),
			texts: textsOf(
				doc,
				makeTranslationUnitId("search-input", input.uuid, "required-message"),
			),
		})),
	};
}

async function readBack(doc: BlueprintDoc) {
	return readHqApp(
		await inputFor(exportedBody(doc), {
			resolver: matchingResolver(
				"app-1",
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			recordDialect: recordDialectRoundTrip,
		}),
	);
}

describe("a required field whose own message is Nova's sentence", () => {
	// The first field holds no message, Nova's reading "Complete"; the second its own, "Responda".
	const returned = prompts("second", OWN_SPANISH, NOVA_SPANISH);
	// The first field holds its own message, "Complete"; the second none, Nova's reading "Responda".
	const other = prompts("first", NOVA_SPANISH, OWN_SPANISH);

	it("prints the same bytes as the document whose fields swap the message", () => {
		expect(JSON.stringify(expandDoc(other))).toBe(
			JSON.stringify(expandDoc(returned)),
		);
	});

	it("is put where the reading puts it, and the choice is a fixed point", () => {
		expect(requiredFacts(other)).not.toEqual(requiredFacts(returned));
		const chosen = requiredMessagesAsRead(other);
		expect(requiredFacts(chosen)).toEqual(requiredFacts(returned));
		expect(JSON.stringify(expandDoc(chosen))).toBe(
			JSON.stringify(expandDoc(other)),
		);
		expect(requiredFacts(requiredMessagesAsRead(returned))).toEqual(
			requiredFacts(returned),
		);
		expect(requiredFacts(requiredMessagesAsRead(chosen))).toEqual(
			requiredFacts(chosen),
		);
	});

	it.each([
		["the returned document", returned],
		["the other document", other],
	])("reads back from %s to the returned one", async (_name, doc) => {
		const outcome = await readBack(doc);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") return;
		const want = requiredMessagesAsRead(canonical(doc));
		expect(requiredFacts(want)).toEqual(requiredFacts(returned));
		expect(requiredFacts(outcome.draft.doc)).toEqual(requiredFacts(want));
	});
});

/**
 * The residual collision: an author's own required message whose translation in another language
 * is Nova's sentence, in an app whose first language is not its source. No language then holds
 * Nova's sentence for every field that prints it, so the reading takes the first language as its
 * source (`systemSentences.ts::systemSentenceSource`) and reads the field that holds no message
 * as holding its printed texts as its own. The canonical document is the one the rows
 * `source-language-is-as-read` and `required-messages-as-read` return, and it must print the
 * document's export and equal the reading.
 */
describe("an own required message translated as Nova's sentence, the first language not the source", () => {
	const OWN = "Please fill this in.";
	function spanishFirst(): BlueprintDoc {
		const doc = prompts("second", NOVA_SPANISH, NOVA_SPANISH);
		const module = doc.modules[doc.moduleOrder[0] ?? ""];
		const second = module?.caseListConfig?.searchInputs[1];
		if (second === undefined || second.kind === "hidden")
			throw new Error("The fixture holds two visible fields.");
		second.required = { message: OWN };
		const units = translationUnitsById(doc);
		const ownUnit = makeTranslationUnitId(
			"search-input",
			SECOND,
			"required-message",
		);
		const unit = units.get(ownUnit);
		const localization = doc.localization;
		if (unit === undefined || localization === undefined)
			throw new Error("The fixture holds the message's unit.");
		doc.localization = {
			...localization,
			defaultLanguage: "spa",
			languageOrder: ["spa", "eng"],
			translations: {
				spa: {
					...localization.translations.spa,
					[ownUnit]: {
						value: SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
					},
				},
			},
		};
		return doc;
	}

	it("reads back to the canonical document, which prints the same export", async () => {
		const doc = spanishFirst();
		const want = canonical(doc);
		expect(JSON.stringify(expandDoc(want))).toBe(
			JSON.stringify(expandDoc(doc)),
		);
		const outcome = await readBack(doc);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") return;
		const read = outcome.draft.doc;
		expect(read.localization?.sourceLanguage).toBe(
			want.localization?.sourceLanguage,
		);
		expect(requiredFacts(read)).toEqual(requiredFacts(want));
	});
});

/**
 * Every way two required fields can hold the required message, and an app whose first language is
 * the source or is not: each field holds none, its own message in English, or Nova's sentence as
 * its own, translated as nothing, as Nova's English sentence, as Nova's Spanish or as its own
 * Spanish, beside Nova's message translated as nothing, as its Spanish or as its English sentence.
 * Each reads back, with no finding, to the canonical document, which prints the same export: no
 * residual collision is left for a canonical row to choose.
 */
describe("every holding of the required message across two fields and two languages", () => {
	type Holding = { readonly message?: string; readonly spanish?: string };
	const OWN = "Please fill this in.";
	function held(
		first: Holding | undefined,
		second: Holding | undefined,
		system: string | undefined,
		spanishFirst: boolean,
	): BlueprintDoc {
		const doc = prompts("second", NOVA_SPANISH, NOVA_SPANISH);
		const inputs =
			doc.modules[doc.moduleOrder[0] ?? ""]?.caseListConfig?.searchInputs ?? [];
		const holdings = [first, second];
		holdings.forEach((holding, index) => {
			const input = inputs[index];
			if (input === undefined || input.kind === "hidden") return;
			if (holding === undefined) delete input.required;
			else
				input.required =
					holding.message === undefined ? {} : { message: holding.message };
		});
		const units = translationUnitsById(doc);
		const spanish: Record<TranslationUnitId, TranslationEntry> = {};
		const translate = (unitId: TranslationUnitId, value: string) => {
			const unit = units.get(unitId);
			if (unit === undefined) return;
			spanish[unitId] = {
				value,
				sourceFingerprint: unit.sourceFingerprint,
				origin: "human",
				review: "reviewed",
				translatedFrom: "eng",
			};
		};
		holdings.forEach((holding, index) => {
			const input = inputs[index];
			if (input === undefined || holding?.spanish === undefined) return;
			translate(
				makeTranslationUnitId("search-input", input.uuid, "required-message"),
				holding.spanish,
			);
		});
		if (system !== undefined) translate(SYSTEM, system);
		doc.localization = {
			sourceLanguage: "eng",
			defaultLanguage: spanishFirst ? "spa" : "eng",
			languageOrder: spanishFirst ? ["spa", "eng"] : ["eng", "spa"],
			wireCodes: { eng: "en", spa: "es" },
			translations: { spa: spanish },
		};
		return doc;
	}

	const S = SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE;
	const firsts: (Holding | undefined)[] = [
		undefined,
		{},
		...[OWN, S].flatMap((message) =>
			[undefined, S, NOVA_SPANISH, OWN_SPANISH].map((spanish) => ({
				message,
				...(spanish !== undefined && { spanish }),
			})),
		),
	];
	const seconds: (Holding | undefined)[] = [
		undefined,
		{},
		{ message: S, spanish: OWN_SPANISH },
		{ message: OWN, spanish: S },
	];

	it("reads each back to its canonical document", {
		// Two hundred and forty documents, each expanded twice and read once.
		timeout: 120_000,
	}, async () => {
		const differing: string[] = [];
		for (const spanishFirst of [false, true])
			for (const first of firsts)
				for (const second of seconds)
					for (const system of [undefined, NOVA_SPANISH, S]) {
						const doc = held(first, second, system, spanishFirst);
						const name = JSON.stringify({
							spanishFirst,
							first,
							second,
							system,
						});
						const want = canonical(doc);
						if (
							JSON.stringify(expandDoc(want)) !== JSON.stringify(expandDoc(doc))
						) {
							differing.push(
								`${name}: the canonical document prints another export`,
							);
							continue;
						}
						const outcome = await readBack(doc);
						if (outcome.defects.length > 0 || outcome.kind !== "read") {
							differing.push(`${name}: does not read`);
							continue;
						}
						const read = outcome.draft.doc;
						const got = {
							source: read.localization?.sourceLanguage,
							facts: requiredFacts(read),
						};
						const expected = {
							source: want.localization?.sourceLanguage,
							facts: requiredFacts(want),
						};
						if (JSON.stringify(got) !== JSON.stringify(expected))
							differing.push(`${name}: reads as another document`);
					}
		expect(differing).toEqual([]);
	});
});
