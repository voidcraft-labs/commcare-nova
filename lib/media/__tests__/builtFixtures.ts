/**
 * The AMR and MIDI files ffmpeg 9.0.2 cannot write (it has no AMR encoder and
 * no MIDI muxer), built from fixed bytes as the BMPs of `bmpFixtures.ts` are.
 * The validator's tests, the readers' tests and the Android decode probe
 * (`proof/android/decode/run.sh`, through `writeBuiltFixtures`) read these
 * builders, so all hold the same bytes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 50 frames of 20 ms each: one second a decoder outputs. */
const FRAMES = 50;

function amr(magic: string, header: number, payload: number): Buffer {
	const frame = Buffer.alloc(1 + payload);
	frame[0] = header;
	return Buffer.concat([
		Buffer.from(magic, "latin1"),
		...Array.from({ length: FRAMES }, () => frame),
	]);
}

/**
 * AMR narrowband (RFC 4867 §5): `#!AMR\n` and 50 speech frames of mode 7
 * (12.2 kbit/s), each the header byte `0x3C` (frame type 7, quality bit set)
 * and 31 payload bytes of zero, which decode as speech parameters.
 */
export function amrNb(): Buffer {
	return amr("#!AMR\n", 0x3c, 31);
}

/** AMR wideband: `#!AMR-WB\n` and 50 frames of mode 8 (23.85 kbit/s), header `0x44` and 60 payload bytes. */
export function amrWb(): Buffer {
	return amr("#!AMR-WB\n", 0x44, 60);
}

/** Multichannel AMR, which Nova refuses: its magic and the narrowband frames. */
export function amrMultichannel(): Buffer {
	return Buffer.concat([
		Buffer.from("#!AMR_MC1.0\n", "latin1"),
		amrNb().subarray("#!AMR\n".length),
	]);
}

/** An AMR header with no audio after it, which Nova refuses. */
export function amrEmpty(): Buffer {
	return Buffer.from("#!AMR\n", "latin1");
}

/**
 * A format 0 Standard MIDI File of one track at division 96: middle C on at
 * velocity 64, off a quarter note later, then the end of the track.
 */
export function midi(): Buffer {
	const header = Buffer.alloc(14);
	header.write("MThd", 0, "latin1");
	header.writeUInt32BE(6, 4);
	header.writeUInt16BE(0, 8);
	header.writeUInt16BE(1, 10);
	header.writeUInt16BE(96, 12);
	const events = Buffer.from([
		0x00, 0x90, 0x3c, 0x40, 0x60, 0x80, 0x3c, 0x40, 0x00, 0xff, 0x2f, 0x00,
	]);
	const track = Buffer.alloc(8);
	track.write("MTrk", 0, "latin1");
	track.writeUInt32BE(events.length, 4);
	return Buffer.concat([header, track, events]);
}

/** The built files Nova accepts, by the filename each is written under. */
export const BUILT_FIXTURES: readonly {
	readonly name: string;
	readonly build: () => Buffer;
}[] = [
	{ name: "amr-nb.amr", build: amrNb },
	{ name: "amr-wb.amr", build: amrWb },
	{ name: "midi.mid", build: midi },
];

/** Write every accepted built file into `directory`, for a reader outside this process. */
export function writeBuiltFixtures(directory: string): void {
	mkdirSync(directory, { recursive: true });
	for (const { name, build } of BUILT_FIXTURES) {
		writeFileSync(join(directory, name), build());
	}
}
