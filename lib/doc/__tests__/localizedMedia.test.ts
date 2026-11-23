import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText, type SelectOption } from "@/lib/domain";
import { effectiveAppLocalization } from "@/lib/domain/localization";
import {
	asWalkableDoc,
	remapAssetRefs,
	walkAuthoredAssetRefs,
} from "@/lib/domain/mediaRefs";
import { installedFormMedia, mediaInLanguage } from "@/lib/domain/multimedia";
import { navigationFilesInLanguage } from "@/lib/domain/navigationMedia";
import { mutationCommitVerdict } from "../commitVerdicts";
import { diffDocsToMutations } from "../diffDocsToMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../lookupReferences";
import { type BlueprintDoc, type Mutation, mutationSchema } from "../types";

const FIELD = testUuid("photo-label");
const MODULE = testUuid("visits");
const first = testMediaAssetId("shared");
const second = testMediaAssetId("spanish");
const third = testMediaAssetId("french");
function fixture() {
	const doc = buildDoc({
		modules: [
			{
				uuid: MODULE,
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								uuid: FIELD,
								id: "note",
								kind: "text",
								label: proseText("Note"),
								label_media: { image: first },
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
		draft.modules[MODULE].icon = first;
	});
}
const CHOICE_FIELD = testUuid("medicine");
const CHOICE = testUuid("pill");
/** A choice with a shared image and a Spanish one, in an app with three languages. */
function choiceFixture() {
	const doc = buildDoc({
		modules: [
			{
				uuid: MODULE,
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								uuid: CHOICE_FIELD,
								id: "medicine",
								kind: "single_select",
								label: proseText("Medicine"),
								optionsSource: {
									kind: "inline",
									options: [
										{
											uuid: CHOICE,
											value: "pill",
											label: proseText("Pill"),
											media: {
												image: first,
												mediaByLanguage: { spa: { image: second } },
											},
										},
										{
											uuid: testUuid("syrup"),
											value: "syrup",
											label: proseText("Syrup"),
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
function inlineChoice(doc: BlueprintDoc, uuid: string): SelectOption {
	const field = doc.fields[CHOICE_FIELD];
	if (!("optionsSource" in field) || field.optionsSource.kind !== "inline")
		throw Error("The question lost its own choices.");
	const option = field.optionsSource.options.find((o) => o.uuid === uuid);
	if (option === undefined) throw Error("The choice is gone.");
	return option;
}
function apply(doc: BlueprintDoc, mutations: Mutation[]) {
	const parsed = mutations.map((value) =>
		mutationSchema.parse(JSON.parse(JSON.stringify(value))),
	);
	const verdict = mutationCommitVerdict(
		doc,
		parsed,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

describe("language-scoped media across editors", () => {
	it("preserves a second editor's translated file when a change from HQ is replayed", () => {
		const base = fixture();
		const shared = testMediaAssetId("replacement");
		const translated = apply(base, [
			{
				kind: "setFieldMedia",
				fieldUuid: FIELD,
				slot: "label",
				language: "eng",
				media: { image: shared },
			},
			{
				kind: "setFieldMedia",
				fieldUuid: FIELD,
				slot: "label",
				language: "spa",
				media: { image: second },
			},
			{
				kind: "setModuleMedia",
				uuid: MODULE,
				language: "spa",
				icon: second,
				audioLabel: null,
			},
		]);
		const changes = diffDocsToMutations(base, translated);
		expect(changes.map((m) => m.kind)).toEqual(
			expect.arrayContaining(["setModuleMedia", "setFieldMedia"]),
		);
		const peer = apply(base, [
			{
				kind: "setFieldMedia",
				fieldUuid: FIELD,
				slot: "label",
				language: "fra",
				media: { image: third },
			},
			{
				kind: "setModuleMedia",
				uuid: MODULE,
				language: "fra",
				icon: third,
				audioLabel: null,
			},
		]);
		const merged = apply(peer, changes);
		const field = merged.fields[FIELD];
		if (field.kind !== "text") throw Error("The question changed kind.");
		expect(mediaInLanguage(field.label_media, "spa", "eng")?.image).toBe(
			second,
		);
		expect(mediaInLanguage(field.label_media, "fra", "eng")?.image).toBe(third);
		expect(
			navigationFilesInLanguage(
				merged.modules[MODULE],
				"fra",
				effectiveAppLocalization(merged.localization),
			).icon,
		).toBe(third);
		const usages = [...walkAuthoredAssetRefs(merged)].filter(
			(ref) => ref.assetId === third,
		);
		expect(usages.map((ref) => [ref.slotKind, ref.location.language])).toEqual([
			["image", "fra"],
			["image", "fra"],
		]);
		const reassigned = remapAssetRefs(merged, new Map([[third, second]]));
		expect(
			[...walkAuthoredAssetRefs(asWalkableDoc(reassigned))].some(
				(ref) => ref.assetId === third,
			),
		).toBe(false);
		const afterRemoval = apply(merged, [
			{ kind: "removeLanguage", code: "fra" },
		]);
		expect(
			[...walkAuthoredAssetRefs(afterRemoval)].some(
				(ref) => ref.assetId === third,
			),
		).toBe(false);
	});
	it("replays a change to a choice's shared files alone, keeping its languages' own", () => {
		const base = choiceFixture();
		const replacement = testMediaAssetId("replacement");
		const changed = produce(base, (draft) => {
			const option = inlineChoice(draft, CHOICE);
			option.media = { ...option.media, image: replacement };
		});
		const forward = diffDocsToMutations(base, changed);
		expect(forward).toContainEqual(
			expect.objectContaining({
				kind: "setFieldMedia",
				optionUuid: CHOICE,
				sharedOnly: true,
			}),
		);
		expect(inlineChoice(apply(base, forward), CHOICE).media).toEqual({
			image: replacement,
			mediaByLanguage: { spa: { image: second } },
		});
		/* The way back, as undo builds it. */
		expect(
			inlineChoice(apply(changed, diffDocsToMutations(changed, base)), CHOICE)
				.media,
		).toEqual(inlineChoice(base, CHOICE).media);
	});
	it("undoes removing a language that held its own question, choice and menu files", () => {
		const shared = produce(choiceFixture(), (draft) => {
			draft.modules[MODULE].icon = first;
			const field = draft.fields[CHOICE_FIELD];
			if (field.kind !== "single_select") throw Error("Expected a choice.");
			field.label_media = { image: first };
		});
		const withFrench = apply(shared, [
			{
				kind: "setFieldMedia",
				fieldUuid: CHOICE_FIELD,
				slot: "label",
				language: "fra",
				media: { image: third },
			},
			{
				kind: "setFieldMedia",
				fieldUuid: CHOICE_FIELD,
				slot: "label",
				optionUuid: CHOICE,
				language: "fra",
				media: { image: third },
			},
			{
				kind: "setModuleMedia",
				uuid: MODULE,
				language: "fra",
				icon: third,
				audioLabel: null,
			},
		]);
		const removed = apply(withFrench, [
			{ kind: "removeLanguage", code: "fra" },
		]);
		/* Undo is the diff back to the document before the removal. */
		const undo = diffDocsToMutations(removed, withFrench);
		const kinds = undo.map((mutation) => mutation.kind);
		expect(kinds.indexOf("addLanguage")).toBeGreaterThanOrEqual(0);
		const restored = apply(removed, undo);
		expect(restored.fields[CHOICE_FIELD]).toEqual(
			withFrench.fields[CHOICE_FIELD],
		);
		expect(restored.modules[MODULE]).toEqual(withFrench.modules[MODULE]);
		expect(restored.localization).toEqual(withFrench.localization);
	});
	it("brings in a language that arrives with a menu file of its own", () => {
		const base = produce(choiceFixture(), (draft) => {
			draft.modules[MODULE].icon = first;
		});
		const target = produce(base, (draft) => {
			if (draft.localization === undefined) throw Error("No languages.");
			draft.localization.languageOrder.push("hin");
			draft.localization.wireCodes.hin = "hi";
			draft.localization.translations.hin = {};
			draft.modules[MODULE].mediaByLanguage = { hin: { icon: third } };
		});
		const changed = apply(base, diffDocsToMutations(base, target));
		expect(changed.modules[MODULE]).toEqual(target.modules[MODULE]);
		expect(
			effectiveAppLocalization(changed.localization).languageOrder,
		).toContain("hin");
	});
	it("distinguishes a full form, a selected installation with no image, and an invalid installation default", () => {
		const media = {
			image: first,
			mediaByLanguage: { fra: { image: null }, spa: { image: second } },
		};
		expect(installedFormMedia(media, "fra", "eng", ["eng", "fra"])).toEqual({
			kind: "files",
			files: { image: first },
		});
		expect(installedFormMedia(media, "fra", "eng", ["fra"])).toEqual({
			kind: "files",
			files: {},
		});
		expect(installedFormMedia(media, "spa", "eng", ["fra", "spa"])).toEqual({
			kind: "missing-default",
			role: "image",
		});
	});
});
