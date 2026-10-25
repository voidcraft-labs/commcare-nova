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
import {
	type MediaFormatKey,
	mediaAssetIdSchema,
} from "@/lib/domain/multimedia";
import type { Platform } from "@/lib/domain/platforms";
import { bmp4Bit } from "@/lib/media/__tests__/bmpFixtures";
import { amrNb, midi } from "@/lib/media/__tests__/builtFixtures";
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
	// One real file of each variant one platform plays, in the media
	// family's per-declaration manifests alone.
	ico: testMediaAssetId("wire-ico"),
	avif: testMediaAssetId("wire-avif"),
	aac: testMediaAssetId("wire-aac"),
	amr: testMediaAssetId("wire-amr"),
	midi: testMediaAssetId("wire-midi"),
	hevc: testMediaAssetId("wire-hevc"),
	mpeg4: testMediaAssetId("wire-mpeg4"),
	mkv: testMediaAssetId("wire-mkv"),
};

/**
 * The variant each file is, which `mediaRecords` writes on its row as the
 * upload gate would; `mediaWireFixtures.test.ts` holds each equal to the
 * production classifier over the file's bytes.
 */
export const MEDIA_FORMAT_OF: Readonly<
	Record<keyof typeof mediaIds, MediaFormatKey>
> = {
	label: "png",
	option: "png",
	icon: "png",
	alias: "png",
	audio: "wav-pcm",
	video: "mp4-h264-high",
	bmp: "bmp",
	m4a: "m4a",
	flac: "flac",
	oggVorbis: "ogg-vorbis",
	oggOpus: "ogg-opus",
	webm: "webm-vp8",
	ico: "ico",
	avif: "avif",
	aac: "aac-adts",
	amr: "amr",
	midi: "midi",
	hevc: "mp4-hevc",
	mpeg4: "mp4-mpeg4-part2",
	mkv: "mkv",
};

/**
 * Which extra files a manifest holds: none (the corpus's), one of each format
 * every platform plays that defect 11's first half accepts, or one of each
 * variant only Web Apps or only Android plays, in an app that declares it.
 */
export type MediaFormatSet = "none" | "every-platform" | "web-apps" | "android";

/** The format sets the native media family emits. */
export const MEDIA_FORMAT_SETS: readonly MediaFormatSet[] = [
	"none",
	"every-platform",
	"web-apps",
	"android",
];

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
 * The uploaded files the media fixtures name, by asset id. A `formats` set
 * other than `none` adds one real file of each format it names: the native
 * media family's manifests, which HQ's bulk upload types by its bytes. The
 * corpus documents built from these fixtures upload the base files alone.
 */
export function mediaManifest(formats: MediaFormatSet = "none"): AssetManifest {
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
		...FORMAT_FILES[formats](),
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

/** The extra files of each format set. */
const FORMAT_FILES: Readonly<Record<MediaFormatSet, () => ManifestFile[]>> = {
	none: () => [],
	"every-platform": formatFiles,
	"web-apps": () => [
		[
			"ico",
			formatFixture("pattern-png.ico"),
			"image",
			"image/vnd.microsoft.icon",
			".ico",
		],
		["avif", formatFixture("pattern.avif"), "image", "image/avif", ".avif"],
	],
	android: () => [
		["aac", formatFixture("tone.aac"), "audio", "audio/aac", ".aac"],
		["amr", amrNb(), "audio", "audio/amr", ".amr"],
		["midi", midi(), "audio", "audio/midi", ".mid"],
		["hevc", formatFixture("pattern-hevc.mp4"), "video", "video/mp4", ".mp4"],
		["mpeg4", formatFixture("pattern-mpeg4.mp4"), "video", "video/mp4", ".mp4"],
		[
			"mkv",
			formatFixture("pattern-vp8.mkv"),
			"video",
			"video/x-matroska",
			".mkv",
		],
	],
};

/** The key of `mediaIds` an asset id is. */
const KEY_OF_ID: ReadonlyMap<string, keyof typeof mediaIds> = new Map(
	(Object.keys(mediaIds) as (keyof typeof mediaIds)[]).map((key) => [
		mediaIds[key],
		key,
	]),
);

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
/**
 * The ready rows of a manifest, each with the variant its file is
 * (`MEDIA_FORMAT_OF`), as the export boundary loads them.
 */
export function mediaRecords(
	assets: AssetManifest,
): Map<string, MediaAssetRecord> {
	return new Map(
		[...assets.values()].map((asset) => {
			const key = KEY_OF_ID.get(asset.assetId);
			return [
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
					...(key !== undefined && { mediaFormat: MEDIA_FORMAT_OF[key] }),
					created_at: new Date(0),
				},
			];
		}),
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

/** One option per variant only Web Apps plays, each file in a slot of its kind. */
const WEB_APPS_OPTIONS = [
	{ value: "seven", label: "Seven", media: { image: mediaIds.ico } },
	{ value: "eight", label: "Eight", media: { image: mediaIds.avif } },
];

/** One option per variant only Android plays, each file in a slot of its kind. */
const ANDROID_OPTIONS = [
	{ value: "seven", label: "Seven", media: { audio: mediaIds.aac } },
	{ value: "eight", label: "Eight", media: { audio: mediaIds.amr } },
	{ value: "nine", label: "Nine", media: { audio: mediaIds.midi } },
	{ value: "ten", label: "Ten", media: { video: mediaIds.hevc } },
	{ value: "eleven", label: "Eleven", media: { video: mediaIds.mpeg4 } },
	{ value: "twelve", label: "Twelve", media: { video: mediaIds.mkv } },
];

const SET_OPTIONS: Readonly<Record<MediaFormatSet, readonly object[]>> = {
	none: [],
	"every-platform": FORMAT_OPTIONS,
	"web-apps": WEB_APPS_OPTIONS,
	android: ANDROID_OPTIONS,
};

/** The one platform a format set's app declares, or none for both. */
const SET_DECLARATION: Readonly<Record<MediaFormatSet, Platform | undefined>> =
	{
		none: undefined,
		"every-platform": undefined,
		"web-apps": "web-apps",
		android: "android",
	};

/**
 * A followup form whose question, select options, menu, form and logo name
 * the manifest's media. A `formats` set other than `none` adds one select
 * option per file it names, each in a slot of its kind, and declares the
 * platform its files play on: the native media family's scenarios, never a
 * corpus document's. Each stays admissible: the fixture runs the validator
 * over its rows and throws on any finding.
 */
export function mediaWireFixture(
	mediaOnly = false,
	formats: MediaFormatSet = "none",
) {
	const assets = mediaManifest(formats);
	const columns = [
		plainColumn(testUuid("media-name-col"), "case_name", "Name"),
		imageMapColumn(testUuid("media-status-col"), "care_status", "Status", [
			imageMapEntry("active", mediaIds.label),
			imageMapEntry("closed", mediaIds.option),
			imageMapEntry("a.'\"/b", mediaIds.icon),
		]),
	];
	const runsOnlyOn = SET_DECLARATION[formats];
	const doc = buildDoc({
		appName: "Media proof",
		...(runsOnlyOn !== undefined && {
			appSettings: {
				showSavedForms: false,
				showIncompleteForms: false,
				runsOnlyOn,
			},
		}),
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
									...SET_OPTIONS[formats],
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
