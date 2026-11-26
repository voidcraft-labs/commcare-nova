// Android's FileUtil.copyExifData copies a small set of tags after re-encoding a photo.
// The source bitmap has its raw sensor orientation. Its orientation tag travels with
// those pixels, just like the date, description and GPS tags.
const CAMERA_TAGS = new Set([0x010e, 0x0112, 0x0132, 0x8298]);
const EXPOSURE_TAGS = new Set([0x9000, 0x9003, 0x9004, 0x9010, 0x9011, 0x9012]);
const GPS_TAGS = new Set([1, 2, 3, 4, 5, 6, 7, 28, 29]);
const EXPOSURE = 0x8769;
const GPS = 0x8825;

interface Tag {
	type: number;
	count: number;
	value: Uint8Array;
}

type Directory = Map<number, Tag>;

const TYPE_BYTES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
const MAX_EXIF_BYTES = 65527;

function retainedExif(
	input: Uint8Array | undefined,
	width: number,
	height: number,
): Uint8Array<ArrayBuffer> {
	const view =
		input && new DataView(input.buffer, input.byteOffset, input.byteLength);
	const little = !view || view.byteLength < 2 || view.getUint16(0) === 0x4949;
	function readDirectory(offset: number, tags: Set<number>): Directory {
		const result: Directory = new Map();
		if (!view || !input || offset < 8 || offset + 2 > input.length)
			return result;
		const entries = view.getUint16(offset, little);
		if (offset + 2 + 12 * entries + 4 > input.length) return result;
		for (let i = 0; i < entries; i++) {
			const at = offset + 2 + 12 * i;
			const id = view.getUint16(at, little);
			if (!tags.has(id)) continue;
			const type = view.getUint16(at + 2, little);
			const unit = TYPE_BYTES[type];
			if (!unit) continue;
			const count = view.getUint32(at + 4, little);
			const size = count * unit;
			const start = size <= 4 ? at + 8 : view.getUint32(at + 8, little);
			if (size > MAX_EXIF_BYTES || start + size > input.length) continue;
			result.set(id, {
				type,
				count,
				value: input.subarray(start, start + size),
			});
		}
		return result;
	}
	const u32 = (n: number): Tag => {
		const bytes = new Uint8Array(4);
		new DataView(bytes.buffer).setUint32(0, n, little);
		return { type: 4, count: 1, value: bytes };
	};
	const root =
		view &&
		view.byteLength >= 8 &&
		[0x4949, 0x4d4d].includes(view.getUint16(0)) &&
		view.getUint16(2, little) === 42
			? readDirectory(
					view.getUint32(4, little),
					new Set([...CAMERA_TAGS, EXPOSURE, GPS]),
				)
			: new Map<number, Tag>();
	const directories = [root];
	const children = new Map<number, Directory>();
	for (const [id, tags] of [
		[EXPOSURE, EXPOSURE_TAGS],
		[GPS, GPS_TAGS],
	] as const) {
		const pointer = root.get(id);
		root.delete(id);
		if (pointer?.type !== 4 || pointer.count !== 1) continue;
		const bytes = pointer.value;
		const offset = new DataView(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength,
		).getUint32(0, little);
		const child = readDirectory(offset, tags);
		if (child.size) {
			children.set(id, child);
			directories.push(child);
			root.set(id, u32(0));
		}
	}
	root.set(0x0100, u32(width));
	root.set(0x0101, u32(height));
	const offsets: { directory: Directory; offset: number }[] = [];
	let length = 8;
	for (const dir of directories) {
		offsets.push({ directory: dir, offset: length });
		for (const [id, child] of children)
			if (child === dir) root.set(id, u32(length));
		length += 6 + 12 * dir.size;
	}
	let tail = length;
	for (const dir of directories)
		for (const { value } of dir.values())
			if (value.length > 4) length += value.length + (value.length % 2);
	// The JPEG carrier has one 16-bit segment. Independently oversized or
	// overlapping malformed source values cannot grow a new metadata block.
	if (length > MAX_EXIF_BYTES) return retainedExif(undefined, width, height);
	const output = new Uint8Array(length);
	const out = new DataView(output.buffer);
	out.setUint16(0, little ? 0x4949 : 0x4d4d);
	out.setUint16(2, 42, little);
	out.setUint32(4, 8, little);
	for (const { directory: dir, offset } of offsets) {
		let at = offset;
		out.setUint16(at, dir.size, little);
		at += 2;
		for (const [tag, { type, count, value }] of [...dir].sort(
			([a], [b]) => a - b,
		)) {
			out.setUint16(at, tag, little);
			out.setUint16(at + 2, type, little);
			out.setUint32(at + 4, count, little);
			if (value.length <= 4) output.set(value, at + 8);
			else {
				out.setUint32(at + 8, tail, little);
				output.set(value, tail);
				tail += value.length + (value.length % 2);
			}
			at += 12;
		}
	}
	return output;
}

interface PhotoMetadata {
	/** Decode sensor pixels without applying the source's orientation a second time. */
	pixels: Blob;
	tiff?: Uint8Array;
}

const JPEG_EXIF = [0x45, 0x78, 0x69, 0x66, 0, 0];
const PNG_EXIF = 0x65584966;

/** JPEG's APP1 segment or PNG's eXIf chunk as one blob slice. Read only
 * headers and the bounded metadata payload; a chosen photo can be large. */
export async function originalPhotoMetadata(
	file: File,
): Promise<PhotoMetadata> {
	const signature = new DataView(await file.slice(0, 8).arrayBuffer());
	if (signature.byteLength < 8) return { pixels: file };
	const jpeg = signature.getUint16(0) === 0xffd8;
	if (
		!jpeg &&
		(signature.getUint32(0) !== 0x89504e47 ||
			signature.getUint32(4) !== 0x0d0a1a0a)
	)
		return { pixels: file };
	let at = jpeg ? 2 : 8;
	// Read adjacent segment headers together. Large compressed pixel chunks
	// are skipped by their lengths so a late PNG EXIF chunk is still found.
	let window = new Uint8Array();
	let start = at;
	while (at + 8 <= file.size) {
		if (at < start || at + 10 > start + window.length) {
			window = new Uint8Array(await file.slice(at, at + 65536).arrayBuffer());
			start = at;
		}
		const n = at - start;
		const view = new DataView(window.buffer, n);
		let size: number, tiffStart: number | undefined;
		if (jpeg) {
			if (window[n] !== 0xff) break;
			const marker = window[n + 1];
			if (marker === 0xda || marker === 0xd9) break;
			if (marker === 0xff) {
				at++;
				continue;
			}
			size = 2 + view.getUint16(2);
			if (size < 4) break;
			if (
				marker === 0xe1 &&
				size >= 10 &&
				JPEG_EXIF.every((b, i) => window[n + 4 + i] === b)
			)
				tiffStart = at + 10;
		} else {
			size = 12 + view.getUint32(0);
			if (view.getUint32(4) === PNG_EXIF) tiffStart = at + 8;
		}
		if (at + size > file.size) break;
		if (tiffStart !== undefined) {
			const end = at + size - (jpeg ? 0 : 4);
			return {
				pixels: new Blob([file.slice(0, at), file.slice(at + size)], {
					type: file.type,
				}),
				...(end - tiffStart <= MAX_EXIF_BYTES && {
					tiff: new Uint8Array(await file.slice(tiffStart, end).arrayBuffer()),
				}),
			};
		}
		at += size;
	}
	return { pixels: file };
}

function crc32(bytes: Uint8Array): number {
	let value = 0xffffffff;
	for (const byte of bytes) {
		value ^= byte;
		for (let bit = 0; bit < 8; bit++)
			value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
	}
	return (value ^ 0xffffffff) >>> 0;
}

/** A fresh canvas encoder has no EXIF. Put the Android tags before the
 * first scan in a JPEG, or just after the mandatory PNG header chunk. */
export function resizedPhotoWithMetadata(
	encoded: Blob,
	tiff: Uint8Array | undefined,
	width: number,
	height: number,
): Blob {
	const tags = retainedExif(tiff, width, height);
	if (encoded.type === "image/jpeg") {
		const prefix = Uint8Array.of(0xff, 0xe1, 0, 0, ...JPEG_EXIF);
		new DataView(prefix.buffer).setUint16(2, tags.length + 8);
		return new Blob([encoded.slice(0, 2), prefix, tags, encoded.slice(2)], {
			type: encoded.type,
		});
	}
	const chunk = new Uint8Array(12 + tags.length);
	const view = new DataView(chunk.buffer);
	view.setUint32(0, tags.length);
	view.setUint32(4, PNG_EXIF);
	chunk.set(tags, 8);
	view.setUint32(8 + tags.length, crc32(chunk.subarray(4, 8 + tags.length)));
	return new Blob([encoded.slice(0, 33), chunk, encoded.slice(33)], {
		type: encoded.type,
	});
}
