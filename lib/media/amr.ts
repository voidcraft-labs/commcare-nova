/**
 * The AMR header reader. music-metadata has no AMR parser, so Nova reads the
 * storage format's magic (RFC 4867 §5) itself: `#!AMR\n` (narrowband) or
 * `#!AMR-WB\n` (wideband), each followed by at least one byte of frames.
 * Android's documented decoders take both; the multichannel spellings are
 * refused.
 */

export type AmrReading =
	| { readonly kind: "amr" }
	| { readonly kind: "multichannel" }
	| { readonly kind: "empty" }
	| { readonly kind: "unreadable" };

const SINGLE = ["#!AMR\n", "#!AMR-WB\n"];
const MULTICHANNEL = ["#!AMR_MC1.0\n", "#!AMR-WB_MC1.0\n"];

function startsWith(bytes: Uint8Array, magic: string): boolean {
	if (bytes.byteLength < magic.length) return false;
	for (let index = 0; index < magic.length; index++) {
		if (bytes[index] !== magic.charCodeAt(index)) return false;
	}
	return true;
}

/** Read an AMR file's header and say whether it holds single-channel audio. */
export function readAmr(bytes: Uint8Array): AmrReading {
	if (MULTICHANNEL.some((magic) => startsWith(bytes, magic))) {
		return { kind: "multichannel" };
	}
	const magic = SINGLE.find((candidate) => startsWith(bytes, candidate));
	if (magic === undefined) return { kind: "unreadable" };
	return bytes.byteLength > magic.length ? { kind: "amr" } : { kind: "empty" };
}
