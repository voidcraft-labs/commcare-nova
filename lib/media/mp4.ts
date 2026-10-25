/**
 * The MP4 reader the upload gate holds a video to.
 *
 * music-metadata names an MP4 track by its sample entry alone (`<avc1>`,
 * `<hvc1>`, `<mp4v>`), and calls every `mp4a` track AAC whatever its stream
 * holds, while the platforms differ by profile: both play H.264 Baseline,
 * Main and High, and only Android plays HEVC Main and MPEG-4 Part 2 Simple
 * (`lib/domain/multimedia.ts::MEDIA_FORMATS`). So Nova walks the ISO boxes
 * itself: the first top-level `moov`, each `trak`'s handler (`mdia/hdlr`) and
 * its one sample description (`mdia/minf/stbl/stsd`), and in that the
 * profile byte of `avcC` or `hvcC`, or the object type and profile of
 * `esds`.
 *
 * The walk reads box headers bounded by the buffer and by each parent's
 * end, and never a sample. Its verdict follows WebM's order of checks: sound
 * only first, then several videos, then another track, then audio codecs,
 * then the video codec.
 */

export type Mp4VariantKey =
	| "mp4-h264-baseline"
	| "mp4-h264-main"
	| "mp4-h264-high"
	| "mp4-hevc"
	| "mp4-mpeg4-part2";

export type Mp4Reading =
	| { readonly kind: "variant"; readonly key: Mp4VariantKey }
	| { readonly kind: "no-video" }
	| { readonly kind: "several-videos" }
	| { readonly kind: "other-track"; readonly handler: string }
	| {
			readonly kind: "codec";
			readonly codec: string;
			readonly accepted: string;
	  }
	| { readonly kind: "unreadable"; readonly detail: string };

/** What an MP4 holds for video, as a refusal names it. */
export const MP4_VIDEO_ADVICE = "MP4 with H.264 Main video";
/** What an MP4 holds for audio, as a refusal names it. */
export const MP4_AUDIO_ADVICE = "MP4 with AAC audio, or with none";

interface Box {
	readonly type: string;
	/** Where the box's payload starts. */
	readonly start: number;
	/** Where the box ends. */
	readonly end: number;
}

class Unreadable extends Error {}

function fourcc(bytes: Uint8Array, at: number): string {
	return String.fromCharCode(
		bytes[at] ?? 0,
		bytes[at + 1] ?? 0,
		bytes[at + 2] ?? 0,
		bytes[at + 3] ?? 0,
	);
}

/** The boxes inside `[start, end)`, each held inside it. */
function boxes(
	view: DataView,
	bytes: Uint8Array,
	start: number,
	end: number,
): Box[] {
	const found: Box[] = [];
	let at = start;
	while (at + 8 <= end) {
		let size = view.getUint32(at);
		const type = fourcc(bytes, at + 4);
		let header = 8;
		if (size === 1) {
			if (at + 16 > end)
				throw new Unreadable("a box runs past the end of the file");
			const high = view.getUint32(at + 8);
			const low = view.getUint32(at + 12);
			size = high * 2 ** 32 + low;
			header = 16;
		} else if (size === 0) {
			size = end - at;
		}
		if (size < header || at + size > end) {
			throw new Unreadable("a box runs past the end of the file");
		}
		found.push({ type, start: at + header, end: at + size });
		at += size;
	}
	return found;
}

function child(
	view: DataView,
	bytes: Uint8Array,
	parent: Box,
	type: string,
): Box | undefined {
	return boxes(view, bytes, parent.start, parent.end).find(
		(box) => box.type === type,
	);
}

/** A descriptor's payload: its tag, where its body starts, where it ends. */
function descriptor(
	bytes: Uint8Array,
	at: number,
	end: number,
): { readonly tag: number; readonly start: number; readonly end: number } {
	if (at >= end) throw new Unreadable("a descriptor runs past its box");
	const tag = bytes[at] ?? 0;
	let size = 0;
	let cursor = at + 1;
	for (let index = 0; index < 4; index++) {
		if (cursor >= end) throw new Unreadable("a descriptor runs past its box");
		const byte = bytes[cursor] ?? 0;
		cursor++;
		size = (size << 7) | (byte & 0x7f);
		if ((byte & 0x80) === 0) break;
	}
	if (cursor + size > end)
		throw new Unreadable("a descriptor runs past its box");
	return { tag, start: cursor, end: cursor + size };
}

interface DecoderConfig {
	readonly objectType: number;
	/** The `DecoderSpecificInfo` bytes, when present. */
	readonly specific?: Uint8Array;
}

/** `esds`'s `DecoderConfigDescriptor`: its object type and specific info. */
function decoderConfig(bytes: Uint8Array, esds: Box): DecoderConfig {
	// A full box: version and flags first.
	const es = descriptor(bytes, esds.start + 4, esds.end);
	if (es.tag !== 0x03) throw new Unreadable("its stream descriptor is missing");
	let at = es.start + 2;
	const flags = bytes[at] ?? 0;
	at += 1;
	if (flags & 0x80) at += 2;
	if (flags & 0x40) at += 1 + (bytes[at] ?? 0);
	if (flags & 0x20) at += 2;
	const config = descriptor(bytes, at, es.end);
	if (config.tag !== 0x04)
		throw new Unreadable("its decoder configuration is missing");
	const objectType = bytes[config.start] ?? 0;
	const specificAt = config.start + 13;
	if (specificAt < config.end && bytes[specificAt] === 0x05) {
		const specific = descriptor(bytes, specificAt, config.end);
		return {
			objectType,
			specific: bytes.subarray(specific.start, specific.end),
		};
	}
	return { objectType };
}

const H264_PROFILES: ReadonlyMap<number, Mp4VariantKey> = new Map([
	[66, "mp4-h264-baseline"],
	[77, "mp4-h264-main"],
	[100, "mp4-h264-high"],
]);
const H264_NAMES: ReadonlyMap<number, string> = new Map([
	[88, "H.264 Extended"],
	[110, "H.264 High 10"],
	[122, "H.264 High 4:2:2"],
	[244, "H.264 High 4:4:4"],
]);
const HEVC_NAMES: ReadonlyMap<number, string> = new Map([
	[2, "HEVC Main 10"],
	[3, "HEVC Main Still Picture"],
]);
const OTHER_VIDEO_NAMES: ReadonlyMap<string, string> = new Map([
	["av01", "AV1"],
	["vp09", "VP9 in MP4"],
	["dvh1", "Dolby Vision"],
	["dvhe", "Dolby Vision"],
	["avc2", "H.264 with its settings inside the video stream"],
	["avc3", "H.264 with its settings inside the video stream"],
	["avc4", "H.264 with its settings inside the video stream"],
]);
const OTHER_AUDIO_NAMES: ReadonlyMap<string, string> = new Map([
	["ac-3", "AC-3"],
	["ec-3", "E-AC-3"],
	["Opus", "Opus"],
	["fLaC", "FLAC"],
	["alac", "Apple Lossless"],
	["samr", "AMR"],
	["sawb", "AMR-WB"],
]);
/** ISO/IEC 14496-2 Table G-1: the Simple Profile levels. */
const SIMPLE_PROFILE_LEVELS: ReadonlySet<number> = new Set([
	0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x08, 0x09,
]);

type VideoVerdict =
	| { readonly kind: "variant"; readonly key: Mp4VariantKey }
	| { readonly kind: "codec"; readonly codec: string };

function mpeg4Part2(specific: Uint8Array | undefined): VideoVerdict {
	const named = (profile: number | undefined): VideoVerdict => ({
		kind: "codec",
		codec:
			profile !== undefined && profile >= 0xf0 && profile <= 0xf7
				? "MPEG-4 Part 2 Advanced Simple"
				: "MPEG-4 Part 2 of another profile",
	});
	if (specific === undefined || specific.length < 5) return named(undefined);
	const startCode =
		specific[0] === 0 && specific[1] === 0 && specific[2] === 1
			? specific[3]
			: undefined;
	if (startCode === 0xb0) {
		const profile = specific[4] ?? 0;
		return SIMPLE_PROFILE_LEVELS.has(profile)
			? { kind: "variant", key: "mp4-mpeg4-part2" }
			: named(profile);
	}
	if (startCode !== undefined && startCode >= 0x20 && startCode <= 0x2f) {
		// One `random_accessible_vol` bit, then 8 bits of
		// `video_object_type_indication`; 1 is the Simple object.
		const objectType =
			(((specific[4] ?? 0) << 1) | ((specific[5] ?? 0) >> 7)) & 0xff;
		return objectType === 1
			? { kind: "variant", key: "mp4-mpeg4-part2" }
			: named(undefined);
	}
	return named(undefined);
}

function videoEntry(
	view: DataView,
	bytes: Uint8Array,
	entry: Box,
): VideoVerdict {
	// 6 reserved bytes, the data reference index, then VisualSampleEntry's 70.
	const inner: Box = {
		type: entry.type,
		start: entry.start + 78,
		end: entry.end,
	};
	if (inner.start > inner.end)
		throw new Unreadable("a video sample entry is cut short");
	switch (entry.type) {
		case "avc1": {
			const avcC = child(view, bytes, inner, "avcC");
			if (avcC === undefined || avcC.start + 1 >= avcC.end) {
				throw new Unreadable("its H.264 settings are missing");
			}
			const profile = bytes[avcC.start + 1] ?? 0;
			const key = H264_PROFILES.get(profile);
			if (key !== undefined) return { kind: "variant", key };
			return {
				kind: "codec",
				codec: H264_NAMES.get(profile) ?? `H.264 profile ${profile}`,
			};
		}
		case "hvc1":
		case "hev1": {
			const hvcC = child(view, bytes, inner, "hvcC");
			if (hvcC === undefined || hvcC.start + 1 >= hvcC.end) {
				throw new Unreadable("its HEVC settings are missing");
			}
			const profile = (bytes[hvcC.start + 1] ?? 0) & 0x1f;
			if (profile === 1) return { kind: "variant", key: "mp4-hevc" };
			return {
				kind: "codec",
				codec: HEVC_NAMES.get(profile) ?? `HEVC profile ${profile}`,
			};
		}
		case "mp4v": {
			const esds = child(view, bytes, inner, "esds");
			if (esds === undefined)
				throw new Unreadable("its MPEG-4 settings are missing");
			const config = decoderConfig(bytes, esds);
			if (config.objectType !== 0x20) {
				return { kind: "codec", codec: "MPEG-4 Part 2 of another profile" };
			}
			return mpeg4Part2(config.specific);
		}
		default:
			return {
				kind: "codec",
				codec: OTHER_VIDEO_NAMES.get(entry.type) ?? `"${entry.type}" video`,
			};
	}
}

/** The audio codec's name, or `undefined` for AAC. */
function audioCodec(
	view: DataView,
	bytes: Uint8Array,
	entry: Box,
): string | undefined {
	if (entry.type !== "mp4a") {
		return OTHER_AUDIO_NAMES.get(entry.type) ?? `"${entry.type}" audio`;
	}
	if (entry.start + 10 > entry.end)
		throw new Unreadable("an audio sample entry is cut short");
	const version = view.getUint16(entry.start + 8);
	const offset = version === 1 ? 44 : version === 2 ? 64 : 28;
	const inner: Box = {
		type: entry.type,
		start: entry.start + offset,
		end: entry.end,
	};
	if (inner.start > inner.end)
		throw new Unreadable("an audio sample entry is cut short");
	const esds = child(view, bytes, inner, "esds");
	if (esds === undefined)
		throw new Unreadable("its audio settings are missing");
	const { objectType } = decoderConfig(bytes, esds);
	if (
		objectType === 0x40 ||
		objectType === 0x66 ||
		objectType === 0x67 ||
		objectType === 0x68
	) {
		return undefined;
	}
	if (objectType === 0x69 || objectType === 0x6b) return "MP3";
	return `audio of object type ${objectType}`;
}

interface Track {
	readonly handler: string;
	readonly entry: Box;
}

function track(
	view: DataView,
	bytes: Uint8Array,
	trak: Box,
): Track | { readonly codec: string } {
	const mdia = child(view, bytes, trak, "mdia");
	const hdlr = mdia && child(view, bytes, mdia, "hdlr");
	if (mdia === undefined || hdlr === undefined || hdlr.start + 12 > hdlr.end) {
		throw new Unreadable("a track has no handler");
	}
	const handler = fourcc(bytes, hdlr.start + 8);
	const minf = child(view, bytes, mdia, "minf");
	const stbl = minf && child(view, bytes, minf, "stbl");
	const stsd = stbl && child(view, bytes, stbl, "stsd");
	if (stsd === undefined || stsd.start + 8 > stsd.end) {
		throw new Unreadable("a track has no sample description");
	}
	const count = view.getUint32(stsd.start + 4);
	if (count !== 1) return { codec: "several encodings in one track" };
	const [entry] = boxes(view, bytes, stsd.start + 8, stsd.end);
	if (entry === undefined)
		throw new Unreadable("a track has no sample description");
	return { handler, entry };
}

/** Read an MP4's tracks and say which variant it is, or why it is none. */
export function readMp4(bytes: Uint8Array): Mp4Reading {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	try {
		const moov = boxes(view, bytes, 0, bytes.byteLength).find(
			(box) => box.type === "moov",
		);
		if (moov === undefined)
			return { kind: "unreadable", detail: "no movie header" };
		const tracks = boxes(view, bytes, moov.start, moov.end)
			.filter((box) => box.type === "trak")
			.map((trak) => track(view, bytes, trak));
		const several = tracks.find(
			(t): t is { readonly codec: string } => "codec" in t,
		);
		const read = tracks.filter((t): t is Track => "handler" in t);
		const videos = read.filter((t) => t.handler === "vide");
		const audios = read.filter((t) => t.handler === "soun");
		const other = read.find(
			(t) => t.handler !== "vide" && t.handler !== "soun",
		);
		if (videos.length === 0 && several === undefined)
			return { kind: "no-video" };
		if (videos.length > 1) return { kind: "several-videos" };
		if (other !== undefined)
			return { kind: "other-track", handler: other.handler };
		if (several !== undefined) {
			return {
				kind: "codec",
				codec: several.codec,
				accepted: MP4_VIDEO_ADVICE,
			};
		}
		for (const audio of audios) {
			const codec = audioCodec(view, bytes, audio.entry);
			if (codec !== undefined)
				return { kind: "codec", codec, accepted: MP4_AUDIO_ADVICE };
		}
		const [video] = videos;
		if (video === undefined) return { kind: "no-video" };
		const verdict = videoEntry(view, bytes, video.entry);
		return verdict.kind === "variant"
			? verdict
			: { kind: "codec", codec: verdict.codec, accepted: MP4_VIDEO_ADVICE };
	} catch (error) {
		if (error instanceof Unreadable)
			return { kind: "unreadable", detail: error.message };
		throw error;
	}
}
