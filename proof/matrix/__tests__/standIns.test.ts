// The proof lane's stand-in media files (`proof/matrix/media.py::stand_in`),
// held to Nova's own judge of a file: `lib/media/validate.ts::validateSniffedMediaBytes`,
// the verdict a reading gives each file it fetches from CommCare HQ
// (`lib/deployment/reading/projectData/mediaStore.ts::judgeReadingMedia`).
//
// The files are the retained pair `proof/matrix/stand-ins.json`: every
// stand-in the lane attaches at a path HQ's template apps map, one at a path
// of its own for each kind `media.py` makes, one at a path of its own for
// each refused format it makes, with the entry Nova's judge names for it
// (`refusedUnder`), and one at a path of its own for each held format it
// makes beyond those kinds, with the entry that holds it (`heldUnder`), each
// with its bytes.
// `proof/matrix/test_media.py` holds the file to `media.stand_in` over HQ's
// template apps at the pin, and to HQ's own classification of each file.
//
// Contract: Nova reads each stand-in as the kind HQ stores it under, with
// the MIME type and extension `media.json` records for it, and refuses the
// same bytes with their signature zeroed; and it refuses each refused-format
// stand-in under the entry its row names (`projectData/media.ts::hqMediaRefusalEntry`),
// and holds each held-format stand-in as the format its entry names.
// Plausible failures: a stand-in Nova's reading refuses or reads as another
// kind, so every base that maps one (the three starter apps and `hq-media`)
// stops at its first reading for a file no app holds; and a refused format a
// variant attaches read under another entry, or held.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inventoryIndex } from "@/lib/commcare/surface/inventory";
import { hqMediaRefusalEntry } from "@/lib/deployment/reading/projectData/media";
import { mediaFormatOf } from "@/lib/domain/multimedia";
import { validateSniffedMediaBytes } from "@/lib/media/validate";

interface StandIn {
	readonly path: string;
	readonly kind: "image" | "audio" | "video";
	readonly mediaClass: string;
	readonly mimeType: string;
	readonly extension: string;
	readonly sha256: string;
	readonly base64: string;
}

/** A file of a format Nova refuses, and the entry its judge names. */
interface RefusedStandIn {
	readonly path: string;
	readonly mediaClass: "CommCareImage" | "CommCareAudio" | "CommCareVideo";
	readonly extension: string;
	readonly refusedUnder: string;
	readonly sha256: string;
	readonly base64: string;
}

/** A file of a format Nova holds beyond the kinds above, and the entry that holds it. */
interface HeldStandIn extends StandIn {
	readonly heldUnder: string;
}

const ROWS: readonly (StandIn | RefusedStandIn | HeldStandIn)[] = JSON.parse(
	readFileSync(join(import.meta.dirname, "..", "stand-ins.json"), "utf8"),
);
const STAND_INS = ROWS.filter(
	(row): row is StandIn => !("refusedUnder" in row) && !("heldUnder" in row),
);
const REFUSED = ROWS.filter(
	(row): row is RefusedStandIn => "refusedUnder" in row,
);
const HELD = ROWS.filter((row): row is HeldStandIn => "heldUnder" in row);

function bytesOf(row: StandIn | RefusedStandIn | HeldStandIn): Buffer {
	return Buffer.from(row.base64, "base64");
}

describe("the lane's stand-in media files", () => {
	it("holds a file of each kind the lane makes at a path of its own, each its own bytes", () => {
		const extensions = [...new Set(STAND_INS.map((row) => row.extension))];
		expect(extensions.length).toBeGreaterThan(0);
		for (const extension of extensions)
			expect(STAND_INS.map((row) => row.path)).toContain(
				`jr://file/commcare/stand-in.${extension}`,
			);
		const digests = STAND_INS.map((row) =>
			createHash("sha256").update(bytesOf(row)).digest("hex"),
		);
		expect(digests).toEqual(STAND_INS.map((row) => row.sha256));
		expect(new Set(digests).size).toBe(STAND_INS.length);
	});

	it.each(STAND_INS.map((row) => [row.path, row] as const))(
		"Nova reads %s as the file the lane says it is",
		async (_path, row) => {
			const verdict = await validateSniffedMediaBytes(bytesOf(row));
			expect(verdict).toMatchObject({
				ok: true,
				validated: {
					kind: row.kind,
					mimeType: row.mimeType,
					extension: `.${row.extension}`,
					sizeBytes: bytesOf(row).length,
					contentHash: row.sha256,
				},
			});
		},
	);

	it.each(
		[...new Set(STAND_INS.map((row) => row.extension))].map(
			(extension) =>
				[
					extension,
					STAND_INS.find((row) => row.extension === extension) as StandIn,
				] as const,
		),
	)(
		"Nova refuses a .%s stand-in whose signature is broken",
		async (_extension, row) => {
			const bytes = Buffer.from(bytesOf(row));
			// Every kind's signature sits in its first twelve bytes: PNG's eight, MP3's frame sync,
			// MP4's `ftyp` box.
			bytes.fill(0, 0, 12);
			const verdict = await validateSniffedMediaBytes(bytes);
			expect(verdict).toMatchObject({
				ok: false,
				reason: "magic-bytes-sniff-failed",
			});
		},
	);
});

describe("the lane's refused-format stand-ins", () => {
	it("holds one of each refused format, each its own bytes", () => {
		expect(REFUSED.map((row) => row.extension)).toEqual([
			"avi",
			"svg",
			"tif",
			"wav",
		]);
		for (const row of REFUSED)
			expect(createHash("sha256").update(bytesOf(row)).digest("hex")).toBe(
				row.sha256,
			);
	});

	it.each(REFUSED.map((row) => [row.extension, row] as const))(
		"Nova refuses the .%s stand-in under its format's entry",
		async (_extension, row) => {
			const verdict = await validateSniffedMediaBytes(bytesOf(row));
			if (verdict.ok) throw new Error(`Nova held ${row.path}.`);
			expect(
				hqMediaRefusalEntry(
					verdict.sniffedMime,
					verdict.reason,
					row.mediaClass,
				),
			).toBe(row.refusedUnder);
		},
	);
});

describe("the lane's held-format stand-ins", () => {
	it("holds one of each held format beyond png, mp3 and mp4, each its own bytes", () => {
		expect(HELD.map((row) => row.extension)).toEqual([
			"amr",
			"bmp",
			"ico",
			"mkv",
			"ogg",
		]);
		for (const row of HELD)
			expect(createHash("sha256").update(bytesOf(row)).digest("hex")).toBe(
				row.sha256,
			);
	});

	it.each(HELD.map((row) => [row.extension, row] as const))(
		"Nova holds the .%s stand-in as the format its entry holds",
		async (_extension, row) => {
			const verdict = await validateSniffedMediaBytes(bytesOf(row));
			if (!verdict.ok) throw new Error(`Nova refused ${row.path}.`);
			expect(verdict.validated).toMatchObject({
				kind: row.kind,
				mimeType: row.mimeType,
				extension: `.${row.extension}`,
			});
			const format = verdict.validated.mediaFormat;
			if (format === undefined)
				throw new Error(`Nova named no format of ${row.path}.`);
			const holding = inventoryIndex()
				.naming(mediaFormatOf(format).surfaceKey)
				.filter((entry) => entry.standing === "held")
				.map((entry) => entry.id);
			expect(holding).toEqual([row.heldUnder]);
		},
	);
});
