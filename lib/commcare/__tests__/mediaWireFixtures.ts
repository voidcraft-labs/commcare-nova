/** Admitted media documents and real decodable bytes shared with native readers. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	imageMapColumn,
	imageMapEntry,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { mediaAssetIdSchema } from "@/lib/domain/multimedia";
import { bmp4Bit } from "@/lib/media/__tests__/bmpFixtures";
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "../multimedia/assetWirePath";

const PNGS = [
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNQDmz5DwADiwH4gz7gMgAAAABJRU5ErkJggg==",
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPY62ryHwAFLwI2bRgkkQAAAABJRU5ErkJggg==",
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPwXFTyHwAE9gJfg1o7iAAAAABJRU5ErkJggg==",
];
const wav = Buffer.alloc(46);
wav.write("RIFF");
wav.writeUInt32LE(38, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(2, 40);
export const mediaIds = {
	label: testMediaAssetId("wire-label"),
	option: testMediaAssetId("wire-option"),
	icon: testMediaAssetId("wire-icon"),
	alias: testMediaAssetId("wire-icon-alias"),
	audio: testMediaAssetId("wire-audio"),
	video: testMediaAssetId("wire-video"),
	// One real file of each format every platform plays that defect 11's
	// first half accepts, in the media family's manifest alone.
	bmp: testMediaAssetId("wire-bmp"),
	m4a: testMediaAssetId("wire-m4a"),
	flac: testMediaAssetId("wire-flac"),
	oggVorbis: testMediaAssetId("wire-ogg-vorbis"),
	oggOpus: testMediaAssetId("wire-ogg-opus"),
	webm: testMediaAssetId("wire-webm"),
};

/** An asset of the manifest: its id's key, its bytes, kind, MIME type and extension. */
type ManifestFile = [
	keyof typeof mediaIds,
	Buffer,
	ResolvedMediaAsset["kind"],
	string,
	string,
];

/** A committed fixture of the media validator's test, by its file name. */
function formatFixture(name: string): Buffer {
	return readFileSync(
		new URL(`../../media/__tests__/fixtures/${name}`, import.meta.url),
	);
}
/**
 * The uploaded files the media fixtures name, by asset id. With `formats`,
 * also one real file of each format defect 11's first half accepts: the
 * native media family's manifest, which HQ's bulk upload types by its bytes.
 * The corpus documents built from these fixtures upload the others alone.
 */
export function mediaManifest(formats = false): AssetManifest {
	const spec: ManifestFile[] = [
		["label", Buffer.from(PNGS[0], "base64"), "image", "image/png", ".png"],
		["option", Buffer.from(PNGS[1], "base64"), "image", "image/png", ".png"],
		["icon", Buffer.from(PNGS[2], "base64"), "image", "image/png", ".png"],
		["alias", Buffer.from(PNGS[2], "base64"), "image", "image/png", ".png"],
		["audio", wav, "audio", "audio/wav", ".wav"],
		[
			"video",
			readFileSync(
				new URL(
					"../../media/__tests__/fixtures/tiny-video.mp4",
					import.meta.url,
				),
			),
			"video",
			"video/mp4",
			".mp4",
		],
		...(formats ? formatFiles() : []),
	];
	return new Map(
		spec.map(([key, bytes, kind, mimeType, extension]) => {
			const contentHash = createHash("sha256").update(bytes).digest("hex");
			const assetId = mediaIds[key];
			return [
				assetId,
				{
					assetId,
					bytes,
					kind,
					mimeType,
					extension,
					contentHash,
					wirePath: `commcare/${contentHash}${extension}`,
				},
			];
		}),
	);
}

/** One real file of each format defect 11's first half accepts. */
function formatFiles(): ManifestFile[] {
	return [
		["bmp", bmp4Bit(), "image", "image/bmp", ".bmp"],
		["m4a", formatFixture("tone.m4a"), "audio", "audio/mp4", ".m4a"],
		["flac", formatFixture("tone.flac"), "audio", "audio/flac", ".flac"],
		[
			"oggVorbis",
			formatFixture("tone-vorbis.ogg"),
			"audio",
			"audio/ogg",
			".ogg",
		],
		["oggOpus", formatFixture("tone-opus.ogg"), "audio", "audio/ogg", ".ogg"],
		["webm", formatFixture("pattern-vp8.webm"), "video", "video/webm", ".webm"],
	];
}
export function mediaRecords(
	assets: AssetManifest,
): Map<string, MediaAssetRecord> {
	return new Map(
		[...assets.values()].map((asset) => [
			asset.assetId,
			{
				id: mediaAssetIdSchema.parse(asset.assetId),
				owner: "proof",
				project_id: "proof",
				status: "ready",
				kind: asset.kind,
				mimeType: asset.mimeType as MediaAssetRecord["mimeType"],
				extension: asset.extension,
				contentHash: asset.contentHash,
				sizeBytes: asset.bytes?.length ?? 0,
				gcsObjectKey: `projects/proof/${asset.contentHash}${asset.extension}`,
				originalFilename: asset.wirePath,
				displayName: asset.assetId,
				created_at: new Date(0),
			},
		]),
	);
}
/** One select option per format defect 11's first half accepts. */
const FORMAT_OPTIONS = [
	{
		value: "three",
		label: "Three",
		media: {
			image: mediaIds.bmp,
			audio: mediaIds.m4a,
			video: mediaIds.webm,
		},
	},
	{ value: "four", label: "Four", media: { audio: mediaIds.flac } },
	{ value: "five", label: "Five", media: { audio: mediaIds.oggVorbis } },
	{ value: "six", label: "Six", media: { audio: mediaIds.oggOpus } },
];

/**
 * A followup form whose question, select options, menu, form and logo name
 * the manifest's media. With `formats`, the select also holds one option per
 * format defect 11's first half accepts, each file in a slot of its kind:
 * the native media family's scenario, never a corpus document's.
 */
export function mediaWireFixture(mediaOnly = false, formats = false) {
	const assets = mediaManifest(formats);
	const columns = [
		plainColumn(testUuid("media-name-col"), "case_name", "Name"),
		imageMapColumn(testUuid("media-status-col"), "care_status", "Status", [
			imageMapEntry("active", mediaIds.label),
			imageMapEntry("closed", mediaIds.option),
			imageMapEntry("a.'\"/b", mediaIds.icon),
		]),
	];
	const doc = buildDoc({
		appName: "Media proof",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "care_status", label: proseText("Status") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns,
					listColumnOrder: columns.map((c) => c.uuid),
					detailColumnOrder: columns.map((c) => c.uuid),
					searchInputs: [],
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "answer",
								label: proseText("Answer 雪"),
								label_media: {
									image: mediaIds.label,
									audio: mediaIds.audio,
									video: mediaIds.video,
								},
								...(mediaOnly
									? {}
									: {
											hint: proseText("A hint"),
											help: proseText("Some help"),
											validate_msg: proseText("Use ok"),
										}),
								help_media: { audio: mediaIds.audio },
								validate: ". = 'ok'",
							}),
							f({
								kind: "single_select",
								id: "choice",
								label: proseText("Choose"),
								options: [
									{
										value: "one",
										label: "One",
										media: {
											image: mediaIds.option,
											audio: mediaIds.audio,
											video: mediaIds.video,
										},
									},
									{ value: "two", label: "Two" },
									...(formats ? FORMAT_OPTIONS : []),
								],
							}),
						],
					},
				],
			},
		],
	});
	const module = doc.modules[doc.moduleOrder[0]];
	const form = doc.forms[doc.formOrder[module.uuid][0]];
	module.icon = mediaIds.icon;
	module.audioLabel = mediaIds.audio;
	form.icon = mediaIds.alias;
	form.audioLabel = mediaIds.audio;
	doc.logo = mediaIds.icon;
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
		mediaAssets: mediaRecords(assets),
	});
	if (findings.length) throw new Error(JSON.stringify(findings));
	return { doc, assets };
}
