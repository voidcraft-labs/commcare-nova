/**
 * Contract: the gate admits a search title blank in a language exactly where
 * CommCare HQ's build shows it blank there: a language with no title of its
 * own shows the first language's, so a language shows none only where the
 * first language shows none too.
 *
 * The failure it catches: a search with no title in its source language while
 * the app's first language, another, holds a title of its own, which every
 * language with none of its own, the source included, would show in HQ's
 * build while Nova's document says it shows none.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	NO_SEARCH_SCREEN_TITLE,
	type SearchInputDef,
	translationSourceFingerprint,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	admittedCaseListDoc,
	findings,
	withSearchInputs,
} from "./caseListRuleFixture";

const CODE = "CASE_LIST_SEARCH_TITLE_BLANK_BESIDE_FIRST";

const REGION: SearchInputDef = {
	uuid: testUuid("region-field"),
	name: "region",
	label: "Region",
	kind: "simple",
	type: "text",
	property: "region",
};

/** A search with no title in its source language, in an app of `order`, sourced in `source`,
 *  whose `titled` languages each hold a title of their own. */
function untitled(
	source: "eng" | "spa",
	order: readonly ("eng" | "spa")[],
	titled: Partial<Record<"eng" | "spa", string>>,
): BlueprintDoc {
	const doc = withSearchInputs(
		admittedCaseListDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "region", label: proseText("Region"), data_type: "text" },
					],
				},
			],
		}),
		[REGION],
	);
	const moduleUuid = doc.moduleOrder[0];
	if (moduleUuid === undefined) throw new Error("The fixture holds a menu.");
	const unit = makeTranslationUnitId("module", moduleUuid, "search-title");
	return produce(doc, (draft) => {
		const mod = draft.modules[moduleUuid];
		if (mod === undefined) throw new Error("The fixture holds a menu.");
		mod.caseSearchConfig = { searchScreenTitle: NO_SEARCH_SCREEN_TITLE };
		draft.localization = {
			sourceLanguage: source,
			defaultLanguage: order[0] ?? source,
			languageOrder: [...order],
			wireCodes: { eng: "en", spa: "es" },
			translations: Object.fromEntries(
				order
					.filter((language) => language !== source)
					.map((language) => {
						const value = titled[language];
						return [
							language,
							value === undefined
								? {}
								: {
										[unit]: {
											value,
											sourceFingerprint: translationSourceFingerprint(
												"text",
												"",
											),
											origin: "human" as const,
											review: "reviewed" as const,
											translatedFrom: source,
										},
									},
						];
					}),
			),
		};
	});
}

const refusals = (doc: BlueprintDoc) =>
	findings(doc).filter((error) => error.code === CODE);

describe("a search title blank in some languages", () => {
	it("admits no title in the first language beside a title in another", () => {
		expect(
			refusals(untitled("eng", ["eng", "spa"], { spa: "Buscar" })),
		).toEqual([]);
	});

	it("admits a search with no title in any language", () => {
		expect(refusals(untitled("spa", ["eng", "spa"], {}))).toEqual([]);
	});

	it("refuses no title in the source beside a title in the first language, another", () => {
		const found = refusals(untitled("spa", ["eng", "spa"], { eng: "Search" }));
		expect(found).toHaveLength(1);
		expect(found[0]?.details?.languages).toBe("Español");
	});
});
