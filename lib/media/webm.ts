/**
 * The VP9 profile of a WebM or MKV file's first video track, read from its
 * first frame.
 *
 * music-metadata names every VP9 profile `VP9`, and the profile is what
 * decides whether a device plays the file: Android 6.0's decoder refuses
 * profiles 1 and 2, Android 10's profile 1, and WebKit on macOS profile 1
 * (`lib/commcare/surface/media-formats.json`, the VP9 item). So the upload
 * gate reads it here, by walking the EBML itself: the Segment's Tracks for
 * the first video track's number and `CodecID`, then the first Cluster's
 * first `SimpleBlock`, or `Block` inside a `BlockGroup`, of that track. The
 * first byte of that frame holds VP9's frame marker (its top two bits are
 * `10`) and then the profile's low and high bits.
 *
 * The walk reads element headers and one byte of one frame, bounded by the
 * buffer at every step. A laced block is answered as unreadable, as is a
 * file in which no frame of the video track is found.
 */

export type Vp9ProfileReading =
	| { readonly kind: "profile"; readonly profile: number }
	| { readonly kind: "unreadable"; readonly detail: string };

const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const CLUSTER = 0x1f43b675;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const VIDEO_TRACK_TYPE = 1;

interface ElementHeader {
	readonly id: number;
	/** Where the element's data starts. */
	readonly start: number;
	/** Where the element's data ends: the parent's end for an unknown size. */
	readonly end: number;
}

/** An EBML variable-length integer at `at`, with the length marker removed. */
function readVint(
	bytes: Uint8Array,
	at: number,
):
	| {
			readonly value: number;
			readonly length: number;
			readonly unknown: boolean;
	  }
	| undefined {
	const first = bytes[at];
	if (first === undefined || first === 0) return undefined;
	let length = 1;
	while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length++;
	if (length > 8 || at + length > bytes.length) return undefined;
	let value = first & (0xff >> length);
	let allOnes = value === 0xff >> length;
	for (let index = 1; index < length; index++) {
		const byte = bytes[at + index] ?? 0;
		value = value * 256 + byte;
		allOnes = allOnes && byte === 0xff;
	}
	return { value, length, unknown: allOnes };
}

/** An element ID at `at`: the vint with its length marker kept. */
function readId(
	bytes: Uint8Array,
	at: number,
): { readonly id: number; readonly length: number } | undefined {
	const size = readVint(bytes, at);
	if (size === undefined || size.length > 4) return undefined;
	let id = 0;
	for (let index = 0; index < size.length; index++) {
		id = id * 256 + (bytes[at + index] ?? 0);
	}
	return { id, length: size.length };
}

/** The element headers directly inside `[from, to)`. */
function* children(
	bytes: Uint8Array,
	from: number,
	to: number,
): Generator<ElementHeader> {
	let at = from;
	while (at < to) {
		const id = readId(bytes, at);
		if (id === undefined) return;
		const size = readVint(bytes, at + id.length);
		if (size === undefined) return;
		const start = at + id.length + size.length;
		const end = size.unknown ? to : start + size.value;
		if (start > to || end > to) {
			// An element that runs past its parent: the file is cut short, and
			// its data is read only as far as the parent reaches.
			yield { id: id.id, start, end: to };
			return;
		}
		yield { id: id.id, start, end };
		at = end;
	}
}

/** An unsigned integer element's value. */
function readUint(bytes: Uint8Array, element: ElementHeader): number {
	let value = 0;
	for (let at = element.start; at < element.end; at++) {
		value = value * 256 + (bytes[at] ?? 0);
	}
	return value;
}

function readText(bytes: Uint8Array, element: ElementHeader): string {
	return new TextDecoder("latin1").decode(
		bytes.subarray(element.start, element.end),
	);
}

/** The first video track's number and codec id, from the Segment's Tracks. */
function firstVideoTrack(
	bytes: Uint8Array,
	segment: ElementHeader,
): { readonly number: number; readonly codecId: string } | undefined {
	for (const tracks of children(bytes, segment.start, segment.end)) {
		if (tracks.id !== TRACKS) continue;
		for (const entry of children(bytes, tracks.start, tracks.end)) {
			if (entry.id !== TRACK_ENTRY) continue;
			let number: number | undefined;
			let type: number | undefined;
			let codecId = "";
			for (const field of children(bytes, entry.start, entry.end)) {
				if (field.id === TRACK_NUMBER) number = readUint(bytes, field);
				else if (field.id === TRACK_TYPE) type = readUint(bytes, field);
				else if (field.id === CODEC_ID) codecId = readText(bytes, field);
			}
			if (type === VIDEO_TRACK_TYPE && number !== undefined) {
				return { number, codecId };
			}
		}
	}
	return undefined;
}

/**
 * The first frame byte of a block of `track`, or why there is none. A block
 * opens with its track number, a 16-bit timecode and a flags byte whose
 * lacing bits say whether several frames share it.
 */
function blockFrameByte(
	bytes: Uint8Array,
	block: ElementHeader,
	track: number,
): { readonly byte: number } | { readonly laced: true } | undefined {
	const number = readVint(bytes, block.start);
	if (number === undefined || number.value !== track) return undefined;
	const flags = bytes[block.start + number.length + 2];
	const frame = block.start + number.length + 3;
	if (flags === undefined || frame >= block.end) return undefined;
	if ((flags & 0x06) !== 0) return { laced: true };
	const byte = bytes[frame];
	return byte === undefined ? undefined : { byte };
}

/** Read the VP9 profile of a WebM file's first video track. */
export function readVp9Profile(bytes: Uint8Array): Vp9ProfileReading {
	for (const segment of children(bytes, 0, bytes.length)) {
		if (segment.id !== SEGMENT) continue;
		const track = firstVideoTrack(bytes, segment);
		if (track === undefined) {
			return { kind: "unreadable", detail: "it holds no video track" };
		}
		if (track.codecId !== "V_VP9") {
			return {
				kind: "unreadable",
				detail: `its video track is ${track.codecId || "unnamed"}, not VP9`,
			};
		}
		for (const cluster of children(bytes, segment.start, segment.end)) {
			if (cluster.id !== CLUSTER) continue;
			for (const element of children(bytes, cluster.start, cluster.end)) {
				const blocks =
					element.id === SIMPLE_BLOCK
						? [element]
						: element.id === BLOCK_GROUP
							? [...children(bytes, element.start, element.end)].filter(
									(inner) => inner.id === BLOCK,
								)
							: [];
				for (const block of blocks) {
					const frame = blockFrameByte(bytes, block, track.number);
					if (frame === undefined) continue;
					if ("laced" in frame) {
						return {
							kind: "unreadable",
							detail: "its first VP9 frame is in a laced block",
						};
					}
					if (frame.byte >> 6 !== 0b10) {
						return {
							kind: "unreadable",
							detail: "its first VP9 frame has no frame marker",
						};
					}
					const low = (frame.byte >> 5) & 1;
					const high = (frame.byte >> 4) & 1;
					return { kind: "profile", profile: (high << 1) | low };
				}
			}
		}
		return { kind: "unreadable", detail: "no VP9 frame was found in it" };
	}
	return { kind: "unreadable", detail: "it holds no WebM segment" };
}
