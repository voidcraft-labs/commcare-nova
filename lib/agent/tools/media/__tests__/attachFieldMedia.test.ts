/** Actual media command, preflight and canonical reducer behavior over admitted
 * documents and controlled asset rows. JSON clear tests exercise serialization;
 * native persistence and SA/MCP transport are separate proofs. */
import { produce } from "immer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { applyOverWire } from "@/lib/doc/__tests__/wireRoundTrip";
import type { Media, Uuid } from "@/lib/domain";
import { attachFieldMediaTool } from "../attachFieldMedia";
import type { FieldMediaSlot } from "../shared";
import {
	ASSET_AUD_1,
	ASSET_ICON,
	ASSET_IMG_1,
	errorOf,
	FORM_A,
	HIDDEN_FIELD,
	loadAssetsByIdsMock,
	MOD_A,
	makeMediaDoc,
	makeMediaFixture,
	resetTestAssets,
	SELECT_FIELD,
	seedTestAsset,
	TEXT_FIELD,
} from "./fixtures";

const ASSET_NOPE = testMediaAssetId("asset-nope");
const ASSET_FOREIGN = testMediaAssetId("asset-foreign");
const ASSET_PENDING = testMediaAssetId("asset-pending");
const UNKNOWN_FIELD = testUuid("88888888-8888-4888-8888-888888888888");

vi.mock("@/lib/db/apps", () => ({
	loadAppProjectId: vi.fn(() =>
		Promise.resolve({ kind: "found", projectId: "project-1" }),
	),
}));
// The db-constructing module stubbed at the import boundary; the
// attach verdict's asset reads resolve against the fixtures' in-memory
// table instead.
vi.mock("@/lib/db/mediaAssets", async () => ({
	loadAssetsByIds: (await import("./fixtures")).loadAssetsByIdsMock,
}));

beforeEach(() => {
	resetTestAssets();
});

/** One attachment on the fixture's m0-f0. */
const attachment = (
	fieldUuid: Uuid,
	slot: FieldMediaSlot,
	media: Partial<Media>,
) => ({ moduleUuid: MOD_A, formUuid: FORM_A, fieldUuid, slot, media });

/** Wrap attachments in the batch input shape. */
const input = (...attachments: ReturnType<typeof attachment>[]) => ({
	attachments,
});

describe("attachFieldMedia", () => {
	it("sets an inline video on a label, checked as a video, and refuses one on a help text", async () => {
		const video = testMediaAssetId("asset-inline-video");
		seedTestAsset(video, "video");
		const h = makeMediaFixture();
		await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "label", { videoInline: video })),
		);
		const field = h.currentDoc().fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toEqual({ videoInline: video });

		// An image is no inline video: the attach verdict checks the kind.
		const wrongKind = await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "label", { videoInline: ASSET_IMG_1 })),
		);
		expect(errorOf(wrongKind)).toContain("inline video");

		const onHelp = await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "help", { videoInline: video })),
		);
		expect(errorOf(onHelp)).toContain(
			"Only a question's label plays an inline video",
		);
		const after = h.currentDoc().fields[TEXT_FIELD];
		expect(
			after && "help_media" in after ? after.help_media : undefined,
		).toBeUndefined();
	});

	it("sets the image on a field's label slot", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "label", { image: ASSET_IMG_1 })),
		);

		expect(result.kind).toBe("mutate");
		const field = h.currentDoc().fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toEqual({ image: ASSET_IMG_1 });
	});

	it("sets a multi-slot bundle on the help slot", async () => {
		const h = makeMediaFixture();
		await h.runTool(
			attachFieldMediaTool,
			input(
				attachment(TEXT_FIELD, "help", {
					image: ASSET_IMG_1,
					audio: ASSET_AUD_1,
				}),
			),
		);
		const field = h.currentDoc().fields[TEXT_FIELD];
		expect(
			field && "help_media" in field ? field.help_media : undefined,
		).toEqual({ image: ASSET_IMG_1, audio: ASSET_AUD_1 });
	});

	it("offers no slot for a hint's or a validation message's media", () => {
		for (const slot of ["hint", "validate_msg"]) {
			expect(
				attachFieldMediaTool.inputSchema.safeParse({
					attachments: [
						{
							moduleUuid: MOD_A,
							formUuid: FORM_A,
							fieldUuid: TEXT_FIELD,
							slot,
							media: { image: ASSET_IMG_1 },
						},
					],
				}).success,
			).toBe(false);
		}
	});

	it("attaches to several fields in one batch", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(
			attachFieldMediaTool,
			input(
				attachment(TEXT_FIELD, "label", { image: ASSET_IMG_1 }),
				attachment(SELECT_FIELD, "label", { audio: ASSET_AUD_1 }),
			),
		);
		const text = h.currentDoc().fields[TEXT_FIELD];
		const select = h.currentDoc().fields[SELECT_FIELD];
		expect(
			text && "label_media" in text ? text.label_media : undefined,
		).toEqual({ image: ASSET_IMG_1 });
		expect(
			select && "label_media" in select ? select.label_media : undefined,
		).toEqual({ audio: ASSET_AUD_1 });
		const success = result.result as { summary?: { count?: number } };
		expect(success.summary).toEqual({ count: 2 });
	});

	it("clears the slot when handed an empty bundle", async () => {
		const h = makeMediaFixture();
		// Seed an existing label_media so the clear has something to remove.
		await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "label", { image: ASSET_IMG_1 })),
		);

		const cleared = await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "label", {})),
		);
		const field = h.currentDoc().fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toBeUndefined();
		expect(cleared.result).toHaveProperty("ok", true);
	});

	it("clears the slot after JSON serialization and reducer application", async () => {
		// Build a doc that already has label_media set, then take the CLEAR
		// tool's mutations and apply them through `applyOverWire` (JSON
		// serialize/parse) against that doc — exactly what the client does
		// with the SSE `data-mutations` payload. A clear encoded as
		// `{ label_media: undefined }` on an `updateField` patch would be
		// dropped by `JSON.stringify` and the slot would survive; the
		// dedicated `setFieldMedia` mutation carries an explicit `null`, so
		// it clears over the wire too.
		const h = makeMediaFixture();
		await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "label", { image: ASSET_IMG_1 })),
		);
		const seededDoc = h.currentDoc();
		const clear = await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "label", {})),
		);

		const overWire = applyOverWire(seededDoc, clear.mutations);
		const field = overWire.fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toBeUndefined();
	});

	it("refuses a slot the field's kind doesn't carry", async () => {
		const h = makeMediaFixture();
		// A hidden field carries no help media slot.
		const result = await h.runTool(
			attachFieldMediaTool,
			input(attachment(HIDDEN_FIELD, "help", { image: ASSET_IMG_1 })),
		);

		expect(result.mutations).toEqual([]);
		const error = errorOf(result);
		expect(error).toContain("hidden field");
		expect(error).toContain("help");
	});

	it("returns an Elm-style error when the field id is unknown", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(
			attachFieldMediaTool,
			input(attachment(UNKNOWN_FIELD, "label", { image: ASSET_IMG_1 })),
		);
		expect(result.mutations).toEqual([]);
		const error = errorOf(result);
		expect(error).toContain("nothing was attached");
		expect(error).toContain(UNKNOWN_FIELD);
	});

	it("writes nothing when one attachment of a batch doesn't resolve", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(
			attachFieldMediaTool,
			input(
				attachment(TEXT_FIELD, "label", { image: ASSET_IMG_1 }),
				attachment(UNKNOWN_FIELD, "label", { image: ASSET_IMG_1 }),
			),
		);
		expect(result.mutations).toEqual([]);
		const field = h.currentDoc().fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toBeUndefined();
		const error = errorOf(result);
		expect(error).toContain("attachments[1]");
		expect(error).toContain(UNKNOWN_FIELD);
	});

	it("refuses an asset id that isn't in the caller's library", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "label", { image: ASSET_NOPE })),
		);
		expect(result.mutations).toEqual([]);
		const error = errorOf(result);
		expect(error).toContain(ASSET_NOPE);
		expect(error).toContain("library");
		// Nothing committed.
		const field = h.currentDoc().fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toBeUndefined();
	});

	it("refuses a foreign Project row even when the controlled reader returns it", async () => {
		seedTestAsset(ASSET_FOREIGN, "image", { project_id: "project-2" });
		const h = makeMediaFixture();
		const result = await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "label", { image: ASSET_FOREIGN })),
		);
		const error = errorOf(result);
		expect(error).toContain("library");
		expect(error).not.toContain("project-2");
	});

	it("refuses an asset whose upload hasn't confirmed", async () => {
		seedTestAsset(ASSET_PENDING, "image", { status: "pending" });
		const h = makeMediaFixture();
		const result = await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "help", { image: ASSET_PENDING })),
		);
		expect(errorOf(result)).toContain("upload hasn't finished");
		expect(result.mutations).toEqual([]);
	});

	it("refuses an asset whose kind doesn't match the slot it's placed in", async () => {
		const h = makeMediaFixture();
		// An audio asset placed in the bundle's IMAGE slot.
		const result = await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "label", { image: ASSET_AUD_1 })),
		);
		const error = errorOf(result);
		expect(error).toContain("an audio file");
		expect(error).toContain("an image");
		expect(result.mutations).toEqual([]);
	});

	it("a verdict failure on one attachment writes nothing for the whole batch", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(
			attachFieldMediaTool,
			input(
				attachment(TEXT_FIELD, "label", { image: ASSET_IMG_1 }),
				attachment(SELECT_FIELD, "label", { image: ASSET_NOPE }),
			),
		);
		expect(result.mutations).toEqual([]);
		const field = h.currentDoc().fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toBeUndefined();
	});

	it("clears without touching the asset table (no verdict on a clear)", async () => {
		const h = makeMediaFixture();
		await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "label", { image: ASSET_IMG_1 })),
		);
		// A clear has no asset expectations, even if the old row moved Projects.
		loadAssetsByIdsMock.mockClear();
		resetTestAssets();
		seedTestAsset(ASSET_IMG_1, "image", { project_id: "project-2" });
		const cleared = await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "label", {})),
		);
		expect(cleared.result).toHaveProperty("ok", true);
		expect(loadAssetsByIdsMock).not.toHaveBeenCalled();
	});

	it("applies repeated slot replacements in input order as one workspace write", async () => {
		const h = makeMediaFixture();
		await h.runTool(
			attachFieldMediaTool,
			input(
				attachment(TEXT_FIELD, "label", { image: ASSET_IMG_1 }),
				attachment(TEXT_FIELD, "label", { audio: ASSET_AUD_1 }),
			),
		);
		const field = h.currentDoc().fields[TEXT_FIELD];
		expect(
			field && "label_media" in field ? field.label_media : undefined,
		).toEqual({ audio: ASSET_AUD_1 });
		expect(h.recordMutations).toHaveBeenCalledOnce();
	});
});

describe("attachFieldMedia in another language", () => {
	/** The fixture app in English and French. */
	const bilingual = () =>
		makeMediaFixture({
			doc: produce(makeMediaDoc(), (draft) => {
				draft.localization = {
					sourceLanguage: "eng",
					defaultLanguage: "eng",
					languageOrder: ["eng", "fra"],
					wireCodes: { eng: "en", fra: "fr" },
					translations: { fra: {} },
				};
			}),
		});
	const labelMedia = (h: ReturnType<typeof bilingual>) => {
		const field = h.currentDoc().fields[TEXT_FIELD];
		return field && "label_media" in field ? field.label_media : undefined;
	};

	it("gives a language its own file and keeps the shared one", async () => {
		const h = bilingual();
		await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "label", { image: ASSET_IMG_1 })),
		);
		await h.runTool(attachFieldMediaTool, {
			attachments: [
				{
					...attachment(TEXT_FIELD, "label", { image: ASSET_ICON }),
					language: { language: "fra" },
				},
			],
		});
		expect(labelMedia(h)).toEqual({
			image: ASSET_IMG_1,
			mediaByLanguage: { fra: { image: ASSET_ICON } },
		});
	});

	it("goes back to the shared file with an empty bundle, as the description says", async () => {
		const h = bilingual();
		await h.runTool(
			attachFieldMediaTool,
			input(attachment(TEXT_FIELD, "label", { image: ASSET_IMG_1 })),
		);
		await h.runTool(attachFieldMediaTool, {
			attachments: [
				{
					...attachment(TEXT_FIELD, "label", { image: ASSET_ICON }),
					language: { language: "fra" },
				},
			],
		});
		const restored = await h.runTool(attachFieldMediaTool, {
			attachments: [
				{
					...attachment(TEXT_FIELD, "label", {}),
					language: { language: "fra" },
				},
			],
		});
		expect(restored.result).toHaveProperty("ok", true);
		/* French workers see the shared file again; nothing hides it. */
		expect(labelMedia(h)).toEqual({ image: ASSET_IMG_1 });
		expect(
			attachFieldMediaTool.inputSchema.shape.attachments.element.shape.language
				.description,
		).toContain("goes back to the shared file");
	});

	it("refuses a language the app doesn't have", async () => {
		const h = bilingual();
		const result = await h.runTool(attachFieldMediaTool, {
			attachments: [
				{
					...attachment(TEXT_FIELD, "label", { image: ASSET_IMG_1 }),
					language: { language: "spa" },
				},
			],
		});
		expect(errorOf(result)).toContain("This language is not in the app.");
		expect(labelMedia(h)).toBeUndefined();
	});
});
