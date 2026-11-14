/**
 * Contract: the canonical choice `joined-search-guards-split-as-read` returns a document that
 * prints the same search as the one it is given, and whose guard and validation messages, in each
 * language, are the texts the reading of Nova's export returns. The failure it catches: a guard
 * translated in a language where it is joined after one field's message, read back split at
 * another place than the document's (the join alone is stored), with no canonical choice naming
 * the split; a canonical choice that changes what the export prints; one that moves a document
 * whose guard a field holds alone or whose guard is untranslated.
 */
import { describe, expect, it } from "vitest";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import type { BlueprintDoc, TranslationUnitId } from "@/lib/domain";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import { searchRuntimeValidationMessage } from "@/lib/domain/searchRuntimeValidationMessages";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { readHqApp } from "../../index";
import { joinedGuardsSplitAsRead, readGuardText } from "../guardSplit";

const QUOTE_KEY = searchRuntimeValidationMessage(new Set(["quote"]))?.key ?? "";
const GUARD = makeTranslationUnitId("system", "search-validation", QUOTE_KEY);
const STATUS = "55555555-5555-4555-8555-eeeeeeee0002";
const MESSAGE = makeTranslationUnitId(
	"search-input",
	STATUS,
	"validation-message",
);

/** The prompts fixture with English first and its source, Spanish translating the quote guard
 *  where `guard` is given, and the status field's message. */
function englishFirst(guard: string | undefined): BlueprintDoc {
	const doc = localizationWireFixture("prompts");
	const localization = doc.localization;
	const spanish = localization?.translations.spa;
	if (localization === undefined || spanish === undefined)
		throw new Error("The fixture holds no Spanish.");
	const entry = spanish[GUARD];
	if (guard === undefined) delete spanish[GUARD];
	else if (entry !== undefined) spanish[GUARD] = { ...entry, value: guard };
	doc.localization = {
		...localization,
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
	};
	return doc;
}

/** The Spanish value of each unit, as the document stores it. */
function spanishOf(doc: BlueprintDoc, units: readonly TranslationUnitId[]) {
	const spanish = doc.localization?.translations.spa ?? {};
	return Object.fromEntries(units.map((unit) => [unit, spanish[unit]?.value]));
}

/** The menus' search settings Nova's export prints. */
function printedSearch(doc: BlueprintDoc): unknown {
	return (exportedBody(doc).modules as Record<string, unknown>[]).map(
		(module) => module.search_config,
	);
}

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
	expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
	if (outcome.kind !== "read") throw new Error("The export did not read.");
	return outcome.draft.doc;
}

describe("a guard joined after one field's message", () => {
	it("is split where the reading splits it, printing the same search", async () => {
		const doc = englishFirst("Quite las comillas.");
		const chosen = joinedGuardsSplitAsRead(doc);
		expect(printedSearch(chosen)).toEqual(printedSearch(doc));
		expect(spanishOf(chosen, [GUARD, MESSAGE])).toEqual({
			[GUARD]: "solo letras minúsculas. Quite las comillas.",
			[MESSAGE]: "Use",
		});
		const read = await readBack(doc);
		expect(spanishOf(read, [GUARD, MESSAGE])).toEqual(
			spanishOf(chosen, [GUARD, MESSAGE]),
		);
	});

	it("is left where the guard is untranslated", async () => {
		const doc = englishFirst(undefined);
		expect(joinedGuardsSplitAsRead(doc)).toBe(doc);
		const read = await readBack(doc);
		expect(spanishOf(read, [GUARD, MESSAGE])).toEqual(
			spanishOf(doc, [GUARD, MESSAGE]),
		);
	});
});

describe("a guard's text in a language other than the source", () => {
	it("is a field's text that holds it alone", () => {
		expect(readGuardText("Remove it", "Quítelo", ["a b Quítelo"])).toBe(
			"Quítelo",
		);
	});

	it("is Nova's sentence where every joined text ends with it", () => {
		expect(
			readGuardText("Remove it", undefined, ["a Remove it", "b c Remove it"]),
		).toBe("Remove it");
	});

	it("is the longest shared ending that leaves each field a message", () => {
		expect(readGuardText("Remove it", undefined, ["a x y", "b c x y"])).toBe(
			"x y",
		);
		expect(readGuardText("Remove it", undefined, ["a x y"])).toBe("x y");
	});
});
