/**
 * The export boundary's format rule over the media fixture's real rows: a
 * file a declared platform cannot play is refused at each reference, with
 * the platform named, and nothing else is this rule's to judge.
 */

import { describe, expect, it } from "vitest";
import {
	mediaIds,
	mediaRecords,
	mediaWireFixture,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import type { Platform } from "@/lib/domain/platforms";
import { mediaFormatPlays } from "../mediaFormatPlays";

function declared(doc: BlueprintDoc, runsOnlyOn?: Platform): BlueprintDoc {
	const { runsOnlyOn: _, ...rest } = doc.appSettings;
	return {
		...doc,
		appSettings: runsOnlyOn ? { ...rest, runsOnlyOn } : rest,
	};
}

/** The fixture's rows with its video recorded as HEVC, which only Android plays. */
function withHevcVideo(): Map<string, MediaAssetRecord> {
	const { assets } = mediaWireFixture();
	const records = mediaRecords(assets);
	const video = records.get(mediaIds.video);
	if (video === undefined) throw new Error("The fixture holds a video.");
	records.set(mediaIds.video, { ...video, mediaFormat: "mp4-hevc" });
	return records;
}

describe("mediaFormatPlays", () => {
	it("refuses each reference to a file a declared platform can't play, naming it", () => {
		const { doc } = mediaWireFixture();
		const findings = mediaFormatPlays(declared(doc), withHevcVideo());
		expect(findings.map((finding) => finding.code)).toEqual([
			"MEDIA_FORMAT_NOT_PLAYED",
			"MEDIA_FORMAT_NOT_PLAYED",
		]);
		const [first] = findings;
		expect(first?.details).toMatchObject({
			assetId: mediaIds.video,
			mediaFormat: "mp4-hevc",
			missingPlatforms: "web-apps",
		});
		expect(first?.message).toContain(
			"the attached video is MP4 (HEVC), which Web Apps can't play, and this app runs in Web Apps. Exporting it again as MP4 with H.264 Main video, or clearing the slot, fixes that.",
		);
	});

	it("admits the same file in an app that runs only on Android", () => {
		const { doc } = mediaWireFixture();
		expect(mediaFormatPlays(declared(doc, "android"), withHevcVideo())).toEqual(
			[],
		);
	});

	it("reads a ready row with no format as playing nowhere", () => {
		const { doc, assets } = mediaWireFixture();
		const records = mediaRecords(assets);
		const audio = records.get(mediaIds.audio);
		if (audio === undefined) throw new Error("The fixture holds audio.");
		const { mediaFormat: _, ...unrecorded } = audio;
		records.set(mediaIds.audio, unrecorded);
		const findings = mediaFormatPlays(declared(doc), records);
		expect(findings.length).toBeGreaterThan(0);
		expect(findings[0]?.details).toMatchObject({
			mediaFormat: "unplayable",
			missingPlatforms: "web-apps,android",
		});
		expect(findings[0]?.message).toContain(
			"no CommCare app can play the attached audio (WAV). Exporting it again as MP3, or M4A with AAC audio, or clearing the slot, fixes that.",
		);
	});

	it("leaves a missing, pending, wrong-kind or document row to the other rules", () => {
		const { doc } = mediaWireFixture();
		const records = withHevcVideo();
		const video = records.get(mediaIds.video);
		if (video === undefined) throw new Error("The fixture holds a video.");
		for (const replacement of [
			undefined,
			{ ...video, status: "pending" as const },
			{ ...video, kind: "audio" as const },
			{
				...video,
				kind: "pdf" as const,
				mimeType: "application/pdf" as const,
			},
		]) {
			const changed = new Map(records);
			if (replacement === undefined) changed.delete(mediaIds.video);
			else changed.set(mediaIds.video, replacement);
			expect(mediaFormatPlays(declared(doc), changed)).toEqual([]);
		}
	});
});
