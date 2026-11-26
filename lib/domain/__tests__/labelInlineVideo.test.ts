/** A question label's inline video: the one media role only a question's
 * label carries. The field schema admits it on `label_media` alone, the
 * `setFieldMedia` mutation refuses it anywhere else, and the per-language
 * file functions carry it as they carry the other roles. */

import { describe, expect, it } from "vitest";
import { mutationSchema } from "@/lib/doc/types";
import {
	asMediaAssetId,
	editMediaInLanguage,
	fieldSchema,
	mediaInLanguage,
	selectOptionSchema,
	storedFormMedia,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const VIDEO = asMediaAssetId("00000000-0000-4000-8000-000000000011");
const VIDEO_FR = asMediaAssetId("00000000-0000-4000-8000-000000000012");
const FIELD = "10000000-0000-4000-8000-000000000001";

describe("an inline video's carriers", () => {
	it("is held on a question's label and refused on its help or a choice", () => {
		const base = {
			kind: "text",
			uuid: FIELD,
			id: "fold",
			label: proseText("Fold it"),
		};
		expect(
			fieldSchema.safeParse({ ...base, label_media: { videoInline: VIDEO } })
				.success,
		).toBe(true);
		expect(
			fieldSchema.safeParse({
				...base,
				help: proseText("Like this"),
				help_media: { videoInline: VIDEO },
			}).success,
		).toBe(false);
		expect(
			fieldSchema.safeParse({
				...base,
				help: proseText("Like this"),
				help_media: {
					video: VIDEO,
					mediaByLanguage: { fra: { videoInline: VIDEO_FR } },
				},
			}).success,
		).toBe(false);
		expect(
			selectOptionSchema.safeParse({
				uuid: "20000000-0000-4000-8000-000000000001",
				value: "yes",
				label: proseText("Yes"),
				media: { videoInline: VIDEO },
			}).success,
		).toBe(false);
	});

	it("is refused by setFieldMedia on a help text or a choice", () => {
		const mutation = (extra: object) =>
			mutationSchema.safeParse({
				kind: "setFieldMedia",
				fieldUuid: FIELD,
				slot: "label",
				media: { videoInline: VIDEO },
				...extra,
			}).success;
		expect(mutation({})).toBe(true);
		expect(mutation({ slot: "help" })).toBe(false);
		expect(
			mutation({ optionUuid: "20000000-0000-4000-8000-000000000001" }),
		).toBe(false);
		expect(
			mutation({
				slot: "help",
				media: null,
				language: "fra",
				languageEntry: { videoInline: VIDEO },
			}),
		).toBe(false);
	});
});

describe("an inline video per language", () => {
	it("shows a language's own file, inherits the shared one, and writes each language's own", () => {
		const edited = editMediaInLanguage(
			{ videoInline: VIDEO },
			{ videoInline: VIDEO_FR },
			"fra",
			"en",
			"en",
		);
		expect(edited).toEqual({
			videoInline: VIDEO,
			mediaByLanguage: { fra: { videoInline: VIDEO_FR } },
		});
		expect(mediaInLanguage(edited, "fra", "en")).toEqual({
			videoInline: VIDEO_FR,
		});
		expect(mediaInLanguage(edited, "hin", "en")).toEqual({
			videoInline: VIDEO,
		});
		expect(storedFormMedia(edited, "fra", "en")).toEqual({
			videoInline: VIDEO_FR,
		});
		// A language reset to the shared file holds no file of its own.
		expect(
			editMediaInLanguage(edited, { videoInline: VIDEO }, "fra", "en", "en"),
		).toEqual({ videoInline: VIDEO });
	});
});
