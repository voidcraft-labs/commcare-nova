/**
 * Contract: a search that holds no title of its own prints "Search" in its source language and
 * its title unit's translation in each other language, and reads back as no title with that
 * translation; a search whose title is "Search" prints the same bytes, and the canonical choice
 * `default-search-title-is-absent` returns it with no title. The failure it catches: a translated
 * default title read as an authored "Search" title, which no document Nova wrote holds; a
 * canonical choice that changes what the export prints.
 */
import { expect, it } from "vitest";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import type { BlueprintDoc } from "@/lib/domain";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import { DEFAULT_CASE_SEARCH_TITLE } from "@/lib/domain/modules";
import { snapshotTranslationUnits } from "@/lib/domain/translationUnits";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { readHqApp } from "../../index";
import { translationEntryFor } from "../../translations";
import { defaultSearchTitleIsAbsent } from "../settings";

/** The prompts fixture with English first and its source, and the first menu's default title
 *  translated into Spanish; its title "Search" where `titled`. */
function bilingual(titled: boolean): {
	doc: BlueprintDoc;
	unit: ReturnType<typeof makeTranslationUnitId>;
} {
	const doc = localizationWireFixture("prompts");
	const localization = doc.localization;
	if (localization === undefined) throw new Error("The fixture is English.");
	const moduleUuid = doc.moduleOrder[0] ?? "";
	const module = doc.modules[moduleUuid];
	if (module === undefined) throw new Error("The fixture holds no menu.");
	if (titled) module.caseSearchConfig = { searchScreenTitle: "Search" };
	const unit = makeTranslationUnitId("module", moduleUuid, "search-title");
	const entry = translationEntryFor(
		"text",
		DEFAULT_CASE_SEARCH_TITLE,
		"Buscar",
		"eng",
	);
	if (entry === undefined) throw new Error("The title's entry is empty.");
	doc.localization = {
		...localization,
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		translations: {
			spa: { ...(localization.translations.spa ?? {}), [unit]: entry },
		},
	};
	return { doc, unit };
}

function printedTitles(doc: BlueprintDoc): unknown {
	return (exportedBody(doc).modules as Record<string, unknown>[]).map(
		(module) => (module.search_config as Record<string, unknown>).title_label,
	);
}

it("reads a translated default title as no title with its translation", async () => {
	const { doc, unit } = bilingual(false);
	expect(printedTitles(doc)).toEqual([{ en: "Search", es: "Buscar" }]);
	const outcome = readHqApp(
		await inputFor(exportedBody(doc), {
			resolver: matchingResolver(
				"app-1",
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			recordDialect: recordDialectRoundTrip,
		}),
	);
	expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
	if (outcome.kind !== "read") return;
	const read = outcome.draft.doc;
	const moduleUuid = read.moduleOrder[0] ?? "";
	const config = read.modules[moduleUuid]?.caseSearchConfig;
	expect(config === undefined || !("searchScreenTitle" in config)).toBe(true);
	expect(snapshotTranslationUnits(read).has(unit)).toBe(true);
	expect(read.localization?.translations.spa?.[unit]?.value).toBe("Buscar");
});

it("returns a title of Search as no title, printing the same title", () => {
	const titled = bilingual(true).doc;
	const chosen = defaultSearchTitleIsAbsent(titled);
	expect(chosen).not.toBe(titled);
	expect(printedTitles(chosen)).toEqual(printedTitles(titled));
	expect(
		chosen.modules[chosen.moduleOrder[0] ?? ""]?.caseSearchConfig,
	).not.toHaveProperty("searchScreenTitle");
	const untitled = bilingual(false).doc;
	expect(defaultSearchTitleIsAbsent(untitled)).toBe(untitled);
});
