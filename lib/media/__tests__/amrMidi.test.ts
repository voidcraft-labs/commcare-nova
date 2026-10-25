/**
 * The AMR and MIDI header readers over the files `builtFixtures.ts` builds.
 */

import { describe, expect, it } from "vitest";
import { readAmr } from "../amr";
import { readMidi } from "../midi";
import { amrEmpty, amrMultichannel, amrNb, amrWb, midi } from "./builtFixtures";

describe("readAmr", () => {
	it("reads narrowband and wideband as AMR", () => {
		expect(readAmr(amrNb())).toEqual({ kind: "amr" });
		expect(readAmr(amrWb())).toEqual({ kind: "amr" });
	});

	it("refuses multichannel and a header with no audio", () => {
		expect(readAmr(amrMultichannel())).toEqual({ kind: "multichannel" });
		expect(readAmr(amrEmpty())).toEqual({ kind: "empty" });
	});
});

describe("readMidi", () => {
	it("reads a format 0 file of one track", () => {
		expect(readMidi(midi())).toEqual({ kind: "midi" });
	});

	it("refuses format 0 with two tracks", () => {
		const bytes = midi();
		bytes.writeUInt16BE(2, 10);
		expect(readMidi(bytes)).toEqual({
			kind: "unreadable",
			detail: "format 0 can't hold 2 tracks",
		});
	});
});
