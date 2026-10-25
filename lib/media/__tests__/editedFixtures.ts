/**
 * Files no committed fixture is, made by editing a committed fixture's bytes
 * in place, so the reader and the validator's tests read the same edit.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

function fixture(name: string): Buffer {
	return Buffer.from(readFileSync(join(import.meta.dirname, "fixtures", name)));
}

/**
 * `pattern-h264-main-aac.mp4` with its sound track's handler (`hdlr`, whose
 * handler type follows its version, flags and `pre_defined` fields) renamed
 * from `soun` to `vide`: an MP4 of two video tracks.
 */
export function twoVideoMp4(): Buffer {
	const bytes = fixture("pattern-h264-main-aac.mp4");
	let at = bytes.indexOf("hdlr", 0, "latin1");
	while (at !== -1) {
		if (bytes.toString("latin1", at + 12, at + 16) === "soun") {
			bytes.write("vide", at + 12, "latin1");
			return bytes;
		}
		at = bytes.indexOf("hdlr", at + 4, "latin1");
	}
	throw new Error(
		"pattern-h264-main-aac.mp4 holds no sound track handler to rename. The fixture may have been made again without its AAC track.",
	);
}

/**
 * A committed WebM made an MKV: its EBML header's `DocType` (element
 * `0x4282`, 4 bytes, `webm`) becomes `matroska`, and the header's one-byte
 * size grows by the 4 bytes that adds. Matroska positions count from the
 * Segment's data, so nothing after the header moves.
 */
export function asMatroska(webm: string): Buffer {
	const bytes = fixture(webm);
	const docType = bytes.indexOf(
		Buffer.from([0x42, 0x82, 0x84, ...Buffer.from("webm", "latin1")]),
	);
	if (bytes.readUInt32BE(0) !== 0x1a45dfa3 || docType === -1) {
		throw new Error(
			`${webm} has no EBML header naming the webm document type at its start. The edit reads ffmpeg's header layout.`,
		);
	}
	const header = Buffer.from(bytes.subarray(0, docType + 3 + 4));
	header[4] = (header[4] ?? 0) + 4;
	header[docType + 2] = 0x88;
	return Buffer.concat([
		header.subarray(0, docType + 3),
		Buffer.from("matroska", "latin1"),
		bytes.subarray(docType + 3 + 4),
	]);
}
