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
};
export function mediaManifest(): AssetManifest {
	const spec: [
		keyof typeof mediaIds,
		Buffer,
		ResolvedMediaAsset["kind"],
		string,
		string,
	][] = [
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
export function mediaWireFixture(mediaOnly = false) {
	const assets = mediaManifest();
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
								hint_media: { image: mediaIds.option },
								help_media: { audio: mediaIds.audio },
								validate: ". = 'ok'",
								validate_msg_media: { image: mediaIds.icon },
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
