/**
 * The gate's entry for bytes with no trustworthy name: the format is sniffed
 * first and the name built from it. Every accepted format runs over the
 * package's committed fixtures (`validate.test.ts` records how each was made)
 * and the bytes `builtFixtures.ts` and `bmpFixtures.ts` build; the TIFF is
 * written by sharp here, since no fixture holds one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
	SVG_REFUSAL_MESSAGE,
	validateMediaBytes,
	validateSniffedMediaBytes,
} from "../validate";
import { BUILT_BMPS } from "./bmpFixtures";
import { amrNb, amrWb, midi } from "./builtFixtures";

function fixture(name: string): Buffer {
	return readFileSync(join(import.meta.dirname, "fixtures", name));
}

/** Validate bytes under the name they truly carry, as an upload would. */
function underTrueName(bytes: Buffer, filename: string) {
	return validateMediaBytes({
		bytes,
		claimedMimeType: "",
		claimedSizeBytes: bytes.length,
		originalFilename: filename,
	});
}

/** One accepted variant of every accepted media format, by its true name. */
const ACCEPTED: readonly { readonly name: string; readonly bytes: Buffer }[] = [
	...[
		"pattern.png",
		"pattern.jpg",
		"pattern.gif",
		"pattern.webp",
		"pattern.avif",
		"pattern-png.ico",
		"pattern-bmp.ico",
		"pattern-8.bmp",
		"pattern-24.bmp",
		"tone.mp3",
		"tone.wav",
		"tone.m4a",
		"tone-m4b.m4a",
		"tone.flac",
		"tone-vorbis.ogg",
		"tone-opus.ogg",
		"tone.aac",
		"pattern-h264-baseline.mp4",
		"pattern-h264-main-aac.mp4",
		"tiny-video.mp4",
		"pattern-hevc.mp4",
		"pattern-mpeg4.mp4",
		"pattern-vp8.webm",
		"pattern-vp9-opus.webm",
		"pattern-vp8.mkv",
	].map((name) => ({ name, bytes: fixture(name) })),
	{ name: "nb.amr", bytes: amrNb() },
	{ name: "wb.amr", bytes: amrWb() },
	{ name: "tune.mid", bytes: midi() },
	...BUILT_BMPS.filter((bmp) => bmp.accepted).map((bmp) => ({
		name: bmp.name,
		bytes: bmp.build(),
	})),
];

describe("validateSniffedMediaBytes", () => {
	it.each(ACCEPTED)(
		"passes $name with the metadata its true name gives it",
		async ({ name, bytes }) => {
			const named = await underTrueName(bytes, name);
			expect(named.ok, name).toBe(true);
			expect(await validateSniffedMediaBytes(bytes)).toEqual(named);
		},
	);

	it("passes a PNG's bytes whatever name CommCare HQ kept them under", async () => {
		const png = fixture("pattern.png");
		expect(await underTrueName(png, "logo.jpg")).toMatchObject({
			ok: false,
			reason: "extension-mime-mismatch",
		});
		expect(await validateSniffedMediaBytes(png)).toMatchObject({
			ok: true,
			validated: {
				mimeType: "image/png",
				extension: ".png",
				kind: "image",
				mediaFormat: "png",
			},
		});
	});

	it("refuses bytes it cannot identify, with no sniffed type", async () => {
		const bytes = Buffer.alloc(512);
		for (let at = 0; at < bytes.length; at++) {
			bytes[at] = (at * 151 + 89) % 251;
		}
		expect(await fileTypeFromBuffer(bytes)).toBeUndefined();
		expect(await validateSniffedMediaBytes(bytes)).toEqual({
			ok: false,
			reason: "magic-bytes-sniff-failed",
			message: expect.any(String),
			sniffedMime: null,
		});
	});

	it("refuses a TIFF as a type Nova does not know, naming it", async () => {
		const tiff = await sharp({
			create: { width: 8, height: 8, channels: 3, background: "#3366cc" },
		})
			.tiff()
			.toBuffer();
		expect(await validateSniffedMediaBytes(tiff)).toEqual({
			ok: false,
			reason: "mime-claim-mismatch",
			message: expect.stringContaining("image/tiff"),
			sniffedMime: "image/tiff",
		});
	});

	it("refuses an MP4 that holds sound and no picture with its own reason", async () => {
		expect(
			await validateSniffedMediaBytes(fixture("tone-audio-only.mp4")),
		).toMatchObject({
			ok: false,
			reason: "codec-not-accepted",
			sniffedMime: "video/mp4",
		});
	});

	describe("an SVG", () => {
		const svg = fixture("pattern.svg").toString("utf8");
		const declared = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${svg}`;
		const utf16 = Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from(declared, "utf16le"),
		]);

		it.each([
			{ way: "bare", bytes: Buffer.from(svg, "utf8"), sniffed: undefined },
			{
				way: "after an XML declaration",
				bytes: Buffer.from(declared, "utf8"),
				sniffed: "application/xml",
			},
			{
				way: "after a byte order mark and a comment",
				bytes: Buffer.concat([
					Buffer.from([0xef, 0xbb, 0xbf]),
					Buffer.from(`<!-- drawn by hand -->\n  ${svg}`, "utf8"),
				]),
				sniffed: undefined,
			},
			{ way: "in UTF-16", bytes: utf16, sniffed: "application/xml" },
			{
				way: "under a namespace prefix, in capitals",
				bytes: Buffer.from(
					'<?xml version="1.0"?><SVG:SVG xmlns:SVG="http://www.w3.org/2000/svg"/>',
					"utf8",
				),
				sniffed: "application/xml",
			},
		])("is refused as SVG $way", async ({ bytes, sniffed }) => {
			expect((await fileTypeFromBuffer(bytes))?.mime).toBe(sniffed);
			expect(await validateSniffedMediaBytes(bytes)).toEqual({
				ok: false,
				reason: "svg-not-accepted",
				message: SVG_REFUSAL_MESSAGE,
				sniffedMime: "image/svg+xml",
			});
		});

		it("is told from an XML document whose root is another element", async () => {
			const bytes = Buffer.from(
				'<?xml version="1.0"?>\n<!-- <svg> -->\n<svgs><svg/></svgs>',
				"utf8",
			);
			expect(await validateSniffedMediaBytes(bytes)).toEqual({
				ok: false,
				reason: "mime-claim-mismatch",
				message: expect.stringContaining("application/xml"),
				sniffedMime: "application/xml",
			});
		});
	});
});
