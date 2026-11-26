// Tests the inspector's choices write against the stored document: the rows
// come from a worker language's projection, and the write keeps every
// choice's own files in every language.
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { projectBuilderLanguageMutations } from "@/lib/doc/projectBuilderLanguageMutations";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	type Field,
	projectLocalizedField,
	proseText,
	type SelectOption,
} from "@/lib/domain";
import {
	replaceOptionLabel,
	withStoredOptionMedia,
} from "../optionsDraftModel";

const FIELD = testUuid("pill-question");
const PILL = testUuid("pill-choice");
const SYRUP = testUuid("syrup-choice");
const NEW = testUuid("new-choice");
const shared = testMediaAssetId("pill-shared");
const spanish = testMediaAssetId("pill-spanish");
const syrupShared = testMediaAssetId("syrup-shared");
const syrupFrench = testMediaAssetId("syrup-french");

const PILL_MEDIA = {
	image: shared,
	mediaByLanguage: { spa: { image: spanish } },
};
const SYRUP_MEDIA = {
	image: syrupShared,
	mediaByLanguage: { fra: { image: syrupFrench } },
};

function fixture(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								uuid: FIELD,
								id: "medicine",
								kind: "single_select",
								label: "Medicine",
								optionsSource: {
									kind: "inline",
									options: [
										{
											uuid: PILL,
											value: "pill",
											label: proseText("Pill"),
											media: PILL_MEDIA,
										},
										{
											uuid: SYRUP,
											value: "syrup",
											label: proseText("Syrup"),
											media: SYRUP_MEDIA,
										},
									],
								},
							}),
						],
					},
				],
			},
		],
	});
	return produce(doc, (draft) => {
		draft.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa", "fra"],
			wireCodes: { eng: "en", spa: "es", fra: "fr" },
			translations: { fra: {}, spa: {} },
		};
	});
}

function inlineOptions(field: Field | undefined): SelectOption[] {
	if (
		field === undefined ||
		!("optionsSource" in field) ||
		field.optionsSource.kind !== "inline"
	)
		throw new Error("Expected a question with its own choices.");
	return field.optionsSource.options;
}

/** One inspector save, as the Builder sends it under `language`. */
function save(
	doc: BlueprintDoc,
	language: string,
	edit: (rows: SelectOption[]) => SelectOption[],
): BlueprintDoc {
	const rows = inlineOptions(projectLocalizedField(doc, language, FIELD));
	const next = withStoredOptionMedia(
		inlineOptions(doc.fields[FIELD]),
		edit(rows),
	);
	const mutation: Mutation = {
		kind: "updateField",
		uuid: FIELD,
		targetKind: "single_select",
		patch: { optionsSource: { kind: "inline", options: next } },
	};
	const projected = projectBuilderLanguageMutations(doc, language, [mutation]);
	if (!projected.ok) throw new Error(projected.message);
	const verdict = mutationCommitVerdict(
		doc,
		projected.mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

describe("the choices write under a worker language", () => {
	for (const language of ["eng", "spa"]) {
		it(`keeps every choice's files in every language when a label changes (${language})`, () => {
			const after = save(fixture(), language, (rows) =>
				replaceOptionLabel(rows, 1, proseText("Syrup bottle")),
			);
			const options = inlineOptions(after.fields[FIELD]);
			expect(options.map((option) => option.media)).toEqual([
				PILL_MEDIA,
				SYRUP_MEDIA,
			]);
		});

		it(`keeps the files when a choice is added and one removed (${language})`, () => {
			const after = save(fixture(), language, (rows) => [
				rows[0],
				{ uuid: NEW, value: "drops", label: proseText("Drops") },
			]);
			const options = inlineOptions(after.fields[FIELD]);
			expect(options.map((option) => [option.uuid, option.media])).toEqual([
				[PILL, PILL_MEDIA],
				[NEW, undefined],
			]);
		});
	}
});
