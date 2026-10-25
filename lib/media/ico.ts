/**
 * The ICO reader the upload gate holds an icon to.
 *
 * CommCare HQ stores an image only once Pillow opens it
 * (`hqmedia/models.py::CommCareImage.attach_data`), and one image it cannot
 * open stops the whole bulk upload. So Nova holds an ICO to what Pillow's
 * ICO loader reads and decodes: the `ICONDIR` (reserved 0, type 1, one to
 * 255 images), one 16-byte entry per image with its bytes inside the file,
 * and the image Pillow opens (the largest, the lowest color depth among
 * images of that size) either a PNG sharp reads at the entry's size or a
 * 40-byte `BITMAPINFOHEADER` without compression at 1, 4, 8, 24 or 32 bits,
 * the header `bmp.ts` reads for a BMP without its file header. A cursor
 * (type 2) is not an icon, and any other image encoding is a variant Nova
 * does not accept.
 */

import sharp from "sharp";

export type IcoReading =
	| { readonly kind: "icon"; readonly width: number; readonly height: number }
	| { readonly kind: "cursor" }
	| { readonly kind: "variant" }
	| { readonly kind: "unreadable"; readonly detail: string };

const DIRECTORY_BYTES = 6;
const ENTRY_BYTES = 16;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const DIB_DEPTHS: ReadonlySet<number> = new Set([1, 4, 8, 24, 32]);

interface Entry {
	readonly width: number;
	readonly height: number;
	/** Pillow's `color_depth`: the bit count, else log2 of the palette size, else 256. */
	readonly depth: number;
	readonly size: number;
	readonly offset: number;
}

/** Read an ICO's directory and its largest image. */
export async function readIco(bytes: Uint8Array): Promise<IcoReading> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.byteLength < DIRECTORY_BYTES || view.getUint16(0, true) !== 0) {
		return { kind: "unreadable", detail: "it has no icon directory" };
	}
	const type = view.getUint16(2, true);
	if (type === 2) return { kind: "cursor" };
	if (type !== 1) {
		return { kind: "unreadable", detail: `its directory names type ${type}` };
	}
	const count = view.getUint16(4, true);
	if (count === 0 || count > 255) {
		return {
			kind: "unreadable",
			detail: `its directory lists ${count} images`,
		};
	}
	if (bytes.byteLength < DIRECTORY_BYTES + count * ENTRY_BYTES) {
		return { kind: "unreadable", detail: "its directory is cut short" };
	}
	const entries: Entry[] = [];
	for (let index = 0; index < count; index++) {
		const at = DIRECTORY_BYTES + index * ENTRY_BYTES;
		const entry: Entry = {
			width: bytes[at] || 256,
			height: bytes[at + 1] || 256,
			depth:
				view.getUint16(at + 6, true) ||
				(bytes[at + 2] ? Math.ceil(Math.log2(bytes[at + 2] ?? 0)) : 0) ||
				256,
			size: view.getUint32(at + 8, true),
			offset: view.getUint32(at + 12, true),
		};
		if (entry.size === 0 || entry.offset + entry.size > bytes.byteLength) {
			return {
				kind: "unreadable",
				detail: "an image runs past the end of the file",
			};
		}
		entries.push(entry);
	}
	// The image Pillow opens: the largest by width times height and, among
	// images of that area, the lowest color depth, the first listed of those
	// (`IcoFile.__init__` sorts by depth, then by area descending, both stable).
	const largest = entries.reduce((best, entry) => {
		const area = entry.width * entry.height;
		const bestArea = best.width * best.height;
		return area > bestArea || (area === bestArea && entry.depth < best.depth)
			? entry
			: best;
	});
	const image = bytes.subarray(largest.offset, largest.offset + largest.size);
	const dimensions = { width: largest.width, height: largest.height };
	if (PNG_SIGNATURE.every((byte, index) => image[index] === byte)) {
		try {
			const meta = await sharp(image).metadata();
			return meta.width === largest.width && meta.height === largest.height
				? { kind: "icon", ...dimensions }
				: { kind: "variant" };
		} catch {
			return { kind: "variant" };
		}
	}
	if (image.byteLength < 40) return { kind: "variant" };
	const dib = new DataView(image.buffer, image.byteOffset, image.byteLength);
	const accepted =
		dib.getUint32(0, true) === 40 &&
		dib.getUint16(12, true) === 1 &&
		DIB_DEPTHS.has(dib.getUint16(14, true)) &&
		dib.getUint32(16, true) === 0;
	return accepted ? { kind: "icon", ...dimensions } : { kind: "variant" };
}
