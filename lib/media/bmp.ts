/**
 * The BMP header reader the upload gate holds a BMP to.
 *
 * sharp has no BMP loader (sharp 0.35.5, the version installed: it answers
 * "Input buffer contains unsupported image format" for every BMP), and one
 * image Pillow refuses stops CommCare HQ's whole bulk upload, the good files
 * in it included (`hqmedia/models.py::CommCareImage.attach_data`, reached
 * from `hqmedia/tasks.py::process_bulk_upload_zip`). So Nova reads the header
 * itself, and accepts exactly the two DIB headers every reader decoded:
 * CommCare Android on Android 6.0, 10 and 15, every browser engine Web Apps
 * runs in, and HQ (`lib/commcare/surface/media-formats.json`, the
 * `executions` its BMP item names).
 *
 *   - a 40-byte `BITMAPINFOHEADER`, compression `BI_RGB`, at 1, 4, 8, 16, 24
 *     or 32 bits per pixel;
 *   - a 124-byte `BITMAPV5HEADER` at 32 bits per pixel, compression
 *     `BI_BITFIELDS`, colour space `LCS_sRGB`.
 *
 * Both need one plane, a width and a height above 0, and the pixel array
 * (its offset and its size) inside the file. Every other header,
 * compression, depth or colour space is a variant Nova does not accept: a
 * 108-byte `BITMAPV4HEADER`, which WebKit on macOS refuses when its colour
 * space is sRGB or Windows; RLE, whose stream size the reader cannot hold to
 * the file without decoding it; and the 12-byte core header. The reader reads
 * the header and the sizes it states, never a pixel.
 */

/** What the reader found in a file. */
export type BmpReading =
	| {
			readonly kind: "accepted";
			readonly width: number;
			readonly height: number;
	  }
	/** A well-formed BMP in a variant Nova does not accept. */
	| { readonly kind: "variant"; readonly detail: string }
	/** Bytes that are not a whole BMP: a header or a pixel array cut short. */
	| { readonly kind: "malformed"; readonly detail: string };

const FILE_HEADER_BYTES = 14;
const INFO_HEADER_BYTES = 40;
const V5_HEADER_BYTES = 124;
const BI_RGB = 0;
const BI_BITFIELDS = 3;
/** `LCS_sRGB`, the four bytes `sRGB` read as a little-endian integer. */
const LCS_SRGB = 0x73524742;
const INFO_HEADER_DEPTHS: ReadonlySet<number> = new Set([1, 4, 8, 16, 24, 32]);

/** Read a BMP's header and say whether the upload gate accepts it. */
export function readBmp(bytes: Uint8Array): BmpReading {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (
		bytes.byteLength < FILE_HEADER_BYTES + 4 ||
		bytes[0] !== 0x42 ||
		bytes[1] !== 0x4d
	) {
		return { kind: "malformed", detail: "it has no BMP file header" };
	}
	const pixelOffset = view.getUint32(10, true);
	const headerSize = view.getUint32(FILE_HEADER_BYTES, true);
	if (headerSize !== INFO_HEADER_BYTES && headerSize !== V5_HEADER_BYTES) {
		return {
			kind: "variant",
			detail: `its ${headerSize}-byte header is neither a BITMAPINFOHEADER nor a BITMAPV5HEADER`,
		};
	}
	if (bytes.byteLength < FILE_HEADER_BYTES + headerSize) {
		return { kind: "malformed", detail: "its header is cut short" };
	}
	const width = view.getInt32(18, true);
	const height = view.getInt32(22, true);
	const planes = view.getUint16(26, true);
	const depth = view.getUint16(28, true);
	const compression = view.getUint32(30, true);
	if (headerSize === INFO_HEADER_BYTES) {
		if (compression !== BI_RGB) {
			return {
				kind: "variant",
				detail: `its BITMAPINFOHEADER names compression ${compression}`,
			};
		}
		if (!INFO_HEADER_DEPTHS.has(depth)) {
			return {
				kind: "variant",
				detail: `its BITMAPINFOHEADER holds ${depth} bits per pixel`,
			};
		}
	} else {
		const colourSpace = view.getUint32(FILE_HEADER_BYTES + 56, true);
		if (
			depth !== 32 ||
			compression !== BI_BITFIELDS ||
			colourSpace !== LCS_SRGB
		) {
			return {
				kind: "variant",
				detail: "its BITMAPV5HEADER is not 32-bit BI_BITFIELDS in sRGB",
			};
		}
	}
	if (planes !== 1) {
		return { kind: "variant", detail: `it holds ${planes} planes` };
	}
	if (width <= 0 || height <= 0) {
		return {
			kind: "variant",
			detail: `its width and height are ${width} and ${height}`,
		};
	}
	const rowBytes = Math.floor((depth * width + 31) / 32) * 4;
	const pixelBytes = rowBytes * height;
	if (
		pixelOffset < FILE_HEADER_BYTES + headerSize ||
		pixelOffset + pixelBytes > bytes.byteLength
	) {
		return {
			kind: "malformed",
			detail: "its pixel array runs past the end of the file",
		};
	}
	return { kind: "accepted", width, height };
}
