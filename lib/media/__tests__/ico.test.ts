/**
 * The ICO reader over ffmpeg's two icons and bytes edited from them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readIco } from "../ico";

function fixture(name: string): Buffer {
	return Buffer.from(readFileSync(join(import.meta.dirname, "fixtures", name)));
}

describe("readIco", () => {
	it("reads a PNG icon and a BMP icon at 64 by 64", async () => {
		for (const file of ["pattern-png.ico", "pattern-bmp.ico"]) {
			expect(await readIco(fixture(file))).toEqual({
				kind: "icon",
				width: 64,
				height: 64,
			});
		}
	});

	it("reads type 2 as a cursor", async () => {
		const bytes = fixture("pattern-png.ico");
		bytes.writeUInt16LE(2, 2);
		expect(await readIco(bytes)).toEqual({ kind: "cursor" });
	});

	it("refuses an entry past the end of the file", async () => {
		const bytes = fixture("pattern-png.ico");
		bytes.writeUInt32LE(bytes.length, 6 + 12);
		expect(await readIco(bytes)).toEqual({
			kind: "unreadable",
			detail: "an image runs past the end of the file",
		});
	});

	it("refuses a DIB with compression as a variant", async () => {
		const bytes = fixture("pattern-bmp.ico");
		const dib = bytes.readUInt32LE(6 + 12);
		bytes.writeUInt32LE(3, dib + 16);
		expect(await readIco(bytes)).toEqual({ kind: "variant" });
	});
});
