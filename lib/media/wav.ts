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

/** Read a WAV's format chunk and say whether it holds 8- or 16-bit PCM. */
export function readWav(bytes: Uint8Array): WavReading {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (
		bytes.byteLength < 12 ||
		ascii(bytes, 0) !== "RIFF" ||
		ascii(bytes, 8) !== "WAVE"
	) {
		return { kind: "unreadable", detail: "no format chunk" };
	}
	let at = 12;
	while (at + 8 <= bytes.byteLength) {
		const id = ascii(bytes, at);
		const size = view.getUint32(at + 4, true);
		const start = at + 8;
		if (id === "fmt ") {
			if (size < 16 || start + size > bytes.byteLength) {
				return { kind: "unreadable", detail: "no format chunk" };
			}
			const tag = view.getUint16(start, true);
			const bits = view.getUint16(start + 14, true);
			if (tag === 1) return pcm(bits);
			if (tag === 3) return { kind: "codec", codec: `${bits}-bit float` };
			if (tag === EXTENSIBLE) {
				if (size < 40) return { kind: "unreadable", detail: "no format chunk" };
				const guid = bytes.subarray(start + 24, start + 40);
				const tail = GUID_TAIL.every((byte, index) => guid[index + 4] === byte);
				const subTag = view.getUint32(start + 24, true);
				if (tail && subTag === 1) return pcm(bits);
				if (tail && subTag === 3)
					return { kind: "codec", codec: `${bits}-bit float` };
				return { kind: "codec", codec: "an extensible format" };
			}
			return { kind: "codec", codec: TAG_NAMES.get(tag) ?? `format ${tag}` };
		}
		// A chunk of odd size is followed by one pad byte.
		at = start + size + (size % 2);
	}
	return { kind: "unreadable", detail: "no format chunk" };
}
