import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
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
