/**
 * The BMP files ffmpeg does not write, built from bytes: one exported builder
 * for each. The validator's test, the browser playback spec
 * (`e2e/tests/browser/media-play.spec.ts`) and the Android decode probe
 * (`proof/android/decode/run.sh`) all read these builders, so the three hold
 * the same bytes. ffmpeg writes the 8-, 16-, 24- and 32-bit `BITMAPINFOHEADER`
 * files, which are committed under `fixtures/`.
 *
 * Each image is 8 by 8 pixels of a pattern a decoder cannot mistake for a
 * blank image: a checkerboard in the palette's colours, or colour bars.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SIZE = 8;
/** `BI_RGB`, `BI_RLE8`, `BI_BITFIELDS`. */
const BI_RGB = 0;
const BI_RLE8 = 1;
const BI_BITFIELDS = 3;
/** `LCS_sRGB`: the four bytes `sRGB` as a little-endian integer. */
const LCS_SRGB = 0x73524742;
/** `LCS_GM_IMAGES`, the rendering intent a `BITMAPV5HEADER` names. */
const LCS_GM_IMAGES = 4;

/** Eight colours as blue, green, red. */
const BARS: readonly (readonly [number, number, number])[] = [
	[255, 255, 255],
	[0, 255, 255],
	[255, 255, 0],
	[0, 255, 0],
	[255, 0, 255],
	[0, 0, 255],
	[255, 0, 0],
	[0, 0, 0],
];

/** The 14-byte `BITMAPFILEHEADER` before a DIB header and its pixels. */
function file(header: Buffer, palette: Buffer, pixels: Buffer): Buffer {
	const offset = 14 + header.length + palette.length;
	const head = Buffer.alloc(14);
	head.write("BM", 0, "latin1");
	head.writeUInt32LE(offset + pixels.length, 2);
	head.writeUInt32LE(offset, 10);
	return Buffer.concat([head, header, palette, pixels]);
}

/** A 40-byte `BITMAPINFOHEADER`, or its first 40 bytes inside a longer one. */
function infoHeader(
	size: number,
	depth: number,
	compression: number,
	imageBytes: number,
	colours: number,
): Buffer {
	const header = Buffer.alloc(size);
	header.writeUInt32LE(size, 0);
	header.writeInt32LE(SIZE, 4);
	header.writeInt32LE(SIZE, 8);
	header.writeUInt16LE(1, 12);
	header.writeUInt16LE(depth, 14);
	header.writeUInt32LE(compression, 16);
	header.writeUInt32LE(imageBytes, 20);
	header.writeInt32LE(2835, 24);
	header.writeInt32LE(2835, 28);
	header.writeUInt32LE(colours, 32);
	return header;
}

/** A palette of blue, green, red and a zero byte per colour. */
function palette(
	colours: readonly (readonly [number, number, number])[],
): Buffer {
	return Buffer.concat(
		colours.map(([blue, green, red]) => Buffer.from([blue, green, red, 0])),
	);
}

/** Bottom-up rows, each padded to four bytes. */
function rows(rowBytes: number, row: (y: number) => readonly number[]): Buffer {
	const padded = Math.ceil(rowBytes / 4) * 4;
	return Buffer.concat(
		Array.from({ length: SIZE }, (_, y) => {
			const line = Buffer.alloc(padded);
			Buffer.from(row(y)).copy(line);
			return line;
		}),
	);
}

/** 1 bit per pixel, two colours, a checkerboard. */
export function bmp1Bit(): Buffer {
	const pixels = rows(1, (y) => [y % 2 === 0 ? 0b10101010 : 0b01010101]);
	return file(
		infoHeader(40, 1, BI_RGB, pixels.length, 2),
		palette([BARS[7], BARS[0]]),
		pixels,
	);
}

/** 4 bits per pixel, eight colours, one bar per column. */
export function bmp4Bit(): Buffer {
	const pixels = rows(4, () => [0x01, 0x23, 0x45, 0x67]);
	return file(
		infoHeader(40, 4, BI_RGB, pixels.length, 8),
		palette(BARS),
		pixels,
	);
}

/** The bars at 24 bits per pixel: blue, green, red per pixel. */
function bars24(): Buffer {
	return rows(SIZE * 3, () => BARS.flatMap((bar) => [...bar]));
}

/**
 * A 124-byte `BITMAPV5HEADER` at 32 bits per pixel, `BI_BITFIELDS`, colour
 * space sRGB: the second header Nova accepts.
 */
export function bmpV5Srgb32(): Buffer {
	const pixels = rows(SIZE * 4, () => BARS.flatMap((bar) => [...bar, 255]));
	const header = infoHeader(124, 32, BI_BITFIELDS, pixels.length, 0);
	header.writeUInt32LE(0x00ff0000, 40);
	header.writeUInt32LE(0x0000ff00, 44);
	header.writeUInt32LE(0x000000ff, 48);
	header.writeUInt32LE(0xff000000, 52);
	header.writeUInt32LE(LCS_SRGB, 56);
	header.writeUInt32LE(LCS_GM_IMAGES, 108);
	return file(header, Buffer.alloc(0), pixels);
}

/**
 * A 108-byte `BITMAPV4HEADER` at 24 bits per pixel, colour space sRGB: the
 * near miss WebKit on macOS refuses, so Nova refuses it.
 */
export function bmpV4Srgb24(): Buffer {
	const pixels = bars24();
	const header = infoHeader(108, 24, BI_RGB, pixels.length, 0);
	header.writeUInt32LE(LCS_SRGB, 56);
	return file(header, Buffer.alloc(0), pixels);
}

/** 8 bits per pixel, `BI_RLE8`: one run per bar, then each row's end. */
export function bmpRle8(): Buffer {
	const line = [...BARS.keys()].flatMap((index) => [1, index]);
	const data = Buffer.from([
		...Array.from({ length: SIZE }, () => [...line, 0, 0]).flat(),
		0,
		1,
	]);
	return file(infoHeader(40, 8, BI_RLE8, data.length, 8), palette(BARS), data);
}

/** The 12-byte `BITMAPCOREHEADER` at 24 bits per pixel. */
export function bmpCoreHeader(): Buffer {
	const header = Buffer.alloc(12);
	header.writeUInt32LE(12, 0);
	header.writeUInt16LE(SIZE, 4);
	header.writeUInt16LE(SIZE, 6);
	header.writeUInt16LE(1, 8);
	header.writeUInt16LE(24, 10);
	return file(header, Buffer.alloc(0), bars24());
}

/** Every built BMP, by the filename each is written under, and whether Nova accepts it. */
export const BUILT_BMPS: readonly {
	readonly name: string;
	readonly build: () => Buffer;
	readonly accepted: boolean;
}[] = [
	{ name: "pattern-1.bmp", build: bmp1Bit, accepted: true },
	{ name: "pattern-4.bmp", build: bmp4Bit, accepted: true },
	{ name: "pattern-v5-srgb-32.bmp", build: bmpV5Srgb32, accepted: true },
	{ name: "pattern-v4-srgb-24.bmp", build: bmpV4Srgb24, accepted: false },
	{ name: "pattern-rle8.bmp", build: bmpRle8, accepted: false },
	{ name: "pattern-core-24.bmp", build: bmpCoreHeader, accepted: false },
];

/** Write every built BMP into `directory`, for a reader outside this process. */
export function writeBuiltBmps(directory: string): void {
	mkdirSync(directory, { recursive: true });
	for (const { name, build } of BUILT_BMPS) {
		writeFileSync(join(directory, name), build());
	}
}
