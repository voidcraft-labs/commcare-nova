/**
 * The WAV reader the upload gate holds a WAV to.
 *
 * Both CommCare platforms play a WAV of 8- or 16-bit integer PCM
 * (`lib/commcare/surface/media-formats.json`, `audio/wav-pcm-8-or-16-bit`),
 * and music-metadata names an extensible header "non-PCM" whatever its
 * sub-format holds. So Nova reads the first `fmt ` chunk itself: the format
 * tag and the bits per sample, and for `WAVE_FORMAT_EXTENSIBLE` the
 * sub-format GUID. The channel count and the sample rate are not read: the
 * item says nothing of either.
 */

import type { RandomAccessBytes } from "./randomAccess";

export type WavReading =
	| { readonly kind: "pcm"; readonly bits: 8 | 16 }
	| { readonly kind: "codec"; readonly codec: string }
	| { readonly kind: "unreadable"; readonly detail: string };

const EXTENSIBLE = 0xfffe;
/** The tail every `KSDATAFORMAT_SUBTYPE_*` GUID shares, after its tag. */
const GUID_TAIL = [
	0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];
const TAG_NAMES: ReadonlyMap<number, string> = new Map([
	[2, "Microsoft ADPCM"],
	[6, "A-law"],
	[7, "mu-law"],
	[0x11, "IMA ADPCM"],
	[0x31, "GSM 6.10"],
	[0x55, "MP3"],
]);

function ascii(bytes: Uint8Array, at: number): string {
	return String.fromCharCode(...bytes.subarray(at, at + 4));
}

function pcm(bits: number): WavReading {
	return bits === 8 || bits === 16
		? { kind: "pcm", bits }
		: { kind: "codec", codec: `${bits}-bit PCM` };
}

/** Read a WAV's format chunk and say whether it holds 8- or 16-bit PCM. Reads
 *  the RIFF header, each chunk's header up to the first `fmt ` and that
 *  chunk's first 40 bytes, by position, never a sample. */
export async function readWav(source: RandomAccessBytes): Promise<WavReading> {
	const size = source.size;
	const head = await source.read(0, 12);
	if (size < 12 || ascii(head, 0) !== "RIFF" || ascii(head, 8) !== "WAVE") {
		return { kind: "unreadable", detail: "no format chunk" };
	}
	let at = 12;
	while (at + 8 <= size) {
		const header = await source.read(at, 8);
		const id = ascii(header, 0);
		const chunkSize = new DataView(
			header.buffer,
			header.byteOffset,
			header.byteLength,
		).getUint32(4, true);
		const start = at + 8;
		if (id === "fmt ") {
			if (chunkSize < 16 || start + chunkSize > size) {
				return { kind: "unreadable", detail: "no format chunk" };
			}
			const bytes = await source.read(start, Math.min(chunkSize, 40));
			const view = new DataView(
				bytes.buffer,
				bytes.byteOffset,
				bytes.byteLength,
			);
			const tag = view.getUint16(0, true);
			const bits = view.getUint16(14, true);
			if (tag === 1) return pcm(bits);
			if (tag === 3) return { kind: "codec", codec: `${bits}-bit float` };
			if (tag === EXTENSIBLE) {
				if (chunkSize < 40)
					return { kind: "unreadable", detail: "no format chunk" };
				const guid = bytes.subarray(24, 40);
				const tail = GUID_TAIL.every((byte, index) => guid[index + 4] === byte);
				const subTag = view.getUint32(24, true);
				if (tail && subTag === 1) return pcm(bits);
				if (tail && subTag === 3)
					return { kind: "codec", codec: `${bits}-bit float` };
				return { kind: "codec", codec: "an extensible format" };
			}
			return { kind: "codec", codec: TAG_NAMES.get(tag) ?? `format ${tag}` };
		}
		// A chunk of odd size is followed by one pad byte.
		at = start + chunkSize + (chunkSize % 2);
	}
	return { kind: "unreadable", detail: "no format chunk" };
}
