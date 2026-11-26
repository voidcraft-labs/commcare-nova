// Tests the case list menu entry's label write against the stored document:
// under a worker language the Builder shows the projected entry, and the
// write keeps the shared files and every language's own.
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import {
	caseListMenuItemMutation,
	caseListMenuItemWithSlot,
} from "@/components/builder/detail/moduleSettings/CaseListMenuItemSection";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { projectBuilderLanguageMutations } from "@/lib/doc/projectBuilderLanguageMutations";
import type { BlueprintDoc } from "@/lib/doc/types";
import { plainColumn, projectLocalizedModule, proseText } from "@/lib/domain";

const MODULE = testUuid("patients");
const NAME = testUuid("name-column");
const shared = testMediaAssetId("list-shared");
const spanish = testMediaAssetId("list-spanish");
const sharedAudio = testMediaAssetId("list-shared-audio");
const ITEM = {
	icon: shared,
	audioLabel: sharedAudio,
	mediaByLanguage: { spa: { icon: spanish } },
};

function fixture(): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "age", label: proseText("Age"), data_type: "int" },
				],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListMenuItem: ITEM,
				caseListConfig: {
					columns: [plainColumn(NAME, "case_name", "Name")],
					listColumnOrder: [NAME],
					detailColumnOrder: [NAME],
					searchInputs: [],
				},
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
	return produce(doc, (draft) => {
		draft.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			wireCodes: { eng: "en", spa: "es" },
			translations: { spa: {} },
		};
	});
}

describe("the case list menu entry's label under a worker language", () => {
	for (const language of ["eng", "spa"]) {
		it(`keeps the shared files and the language's own (${language})`, () => {
			const doc = fixture();
			/* What the section shows: the language's files as the entry's own. */
			const shown = projectLocalizedModule(doc, language, MODULE);
			expect(shown?.caseListMenuItem?.icon).toBe(
				language === "spa" ? spanish : shared,
			);
			const mutation = caseListMenuItemMutation(
				MODULE,
				caseListMenuItemWithSlot(
					doc.modules[MODULE].caseListMenuItem,
					"label",
					"Find a patient",
				),
			);
			const projected = projectBuilderLanguageMutations(doc, language, [
				mutation,
			]);
			if (!projected.ok) throw new Error(projected.message);
			const verdict = mutationCommitVerdict(
				doc,
				projected.mutations,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict.ok ? [] : verdict.findings).toEqual([]);
			expect(verdict.nextDoc.modules[MODULE].caseListMenuItem).toEqual({
				...ITEM,
				label: "Find a patient",
			});
		});
	}

	it("clears only the slot it names", () => {
		expect(
			caseListMenuItemWithSlot({ ...ITEM, label: "Find" }, "label", undefined),
		).toEqual(ITEM);
	});
});
