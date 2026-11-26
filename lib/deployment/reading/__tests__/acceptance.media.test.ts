/**
 * Acceptance and the files a reading holds.
 *
 * Contract: handed a choice that declares a platform a held file does not
 * play on (an icon, which Web Apps plays and Android does not), acceptance
 * fails the gate under `gate/export/MEDIA_FORMAT_NOT_PLAYED`: the validator
 * and project data's narrowing hold the same fact, so a choice the narrowing
 * kept and the validator refuses means the two disagree. And export
 * readiness never answers `MEDIA_EXPORT_TOO_LARGE`, whatever the files
 * weigh, over every document the proof lane publishes: the in-memory
 * export mode's media budget is no rule of the gate's, and a reading holds an
 * app to none.
 *
 * Plausible failures: a choice the narrowing kept and the validator refuses,
 * offered at the review; a code the gate is said never to answer, answered.
 */

import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import {
	hydrated,
	publishedCorpus,
	publishRefuses,
} from "@/lib/commcare/reader/__tests__/publishedDocuments";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { exportReadinessFindings } from "@/lib/doc/commitVerdicts";
import { acceptReading } from "../acceptance";
import { acceptanceInput, NO_TABLES } from "./acceptanceInput";
import { servedMediaReading } from "./servedReading";

const ICON = testMediaAssetId("icon");

/** A form whose one question's label shows an image. */
const PICTURED = buildDoc({
	appName: "Clinic",
	modules: [
		{
			name: "Visits",
			forms: [
				{
					name: "Visit",
					type: "survey",
					fields: [f({ kind: "text", id: "q", label_media: { image: ICON } })],
				},
			],
		},
	],
});

describe("acceptReading over a held file", () => {
	it("fails the gate for a choice that declares a platform the file does not play on", async () => {
		const read = await servedMediaReading(PICTURED, [
			{
				path: "jr://file/commcare/icon.png",
				assetId: ICON,
				contentHash: "a".repeat(64),
				mediaFormat: "ico",
				mimeType: "image/vnd.microsoft.icon",
			},
		]);
		const input = acceptanceInput(read.reader, read.outcome, {
			media: read.media,
		});
		expect(
			input.choices.choices.some((choice) => choice.runsOnlyOn !== "web-apps"),
		).toBe(true);
		const accepted = acceptReading(input);
		if (accepted.ok) throw new Error("Acceptance accepted an unplayed file.");
		expect(accepted.check).toBe("gate");
		expect(accepted.signature).toBe("gate/export/MEDIA_FORMAT_NOT_PLAYED");
	});
});

describe("export readiness", () => {
	it("never answers the export's media budget, whatever the files weigh", {
		timeout: 60_000,
	}, () => {
		const context = {
			kind: "available" as const,
			projectId: NO_TABLES.projectId,
			projectRevision: NO_TABLES.projectRevision,
			definitions: [],
		};
		let judged = 0;
		for (const document of publishedCorpus()) {
			const doc = hydrated(document);
			if (publishRefuses(document, doc) || document.lookup !== undefined)
				continue;
			const rows = new Map<string, MediaAssetRecord>();
			for (const [assetId, asset] of manifestFor(doc))
				rows.set(assetId, {
					id: assetId,
					project_id: "",
					owner: "",
					contentHash: asset.contentHash,
					mimeType: asset.mimeType,
					extension: asset.extension,
					sizeBytes: 4 * 1024 * 1024 * 1024,
					mediaFormat: asset.kind === "image" ? "png" : "unplayable",
					kind: asset.kind,
					gcsObjectKey: "",
					originalFilename: asset.wirePath,
					status: "ready",
					created_at: new Date(0),
				} as MediaAssetRecord);
			if (rows.size === 0) continue;
			judged++;
			expect(
				exportReadinessFindings(doc, context, rows).map((one) => one.code),
			).not.toContain("MEDIA_EXPORT_TOO_LARGE");
		}
		expect(judged).toBeGreaterThan(0);
	});
});
