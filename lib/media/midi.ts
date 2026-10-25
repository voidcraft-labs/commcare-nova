/**
 * The MIDI header reader. music-metadata has no MIDI parser, so Nova reads
 * the Standard MIDI File header itself: `MThd`, a length of 6, a format of
 * 0, 1 or 2, at least one track (exactly one for format 0), a nonzero
 * division, and the first `MTrk` right after it.
 */

export type MidiReading =
	| { readonly kind: "midi" }
	| { readonly kind: "unreadable"; readonly detail: string };

function ascii(bytes: Uint8Array, at: number): string {
	return String.fromCharCode(...bytes.subarray(at, at + 4));
}

/** Read a MIDI file's header and say whether it is a standard MIDI file. */
export function readMidi(bytes: Uint8Array): MidiReading {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.byteLength < 18 || ascii(bytes, 0) !== "MThd") {
		return { kind: "unreadable", detail: "it has no MIDI header" };
	}
	if (view.getUint32(4) !== 6) {
		return { kind: "unreadable", detail: "its header is not 6 bytes long" };
	}
	const format = view.getUint16(8);
	if (format > 2) {
		return { kind: "unreadable", detail: `it names format ${format}` };
	}
	const tracks = view.getUint16(10);
	if (tracks === 0 || (format === 0 && tracks !== 1)) {
		return {
			kind: "unreadable",
			detail: `format ${format} can't hold ${tracks} tracks`,
		};
	}
	if (view.getUint16(12) === 0) {
		return { kind: "unreadable", detail: "its time division is 0" };
	}
	if (ascii(bytes, 14) !== "MTrk") {
		return { kind: "unreadable", detail: "no track follows its header" };
	}
	return { kind: "midi" };
}
