// lib/media/__tests__/uploadOutcome.test.ts
//
// Unit coverage for the media-attach interpreter + reporter — the pieces that
// turn HQ's bare `unmatched_files` report into "which media, where, didn't
// attach", separate the by-design app-logo case from a genuine failure, and
// emit the warn/error log decision.
//
// `interpretMediaAttach` runs against a real `walkAssetRefs` over a hand-built
// doc + a plain asset → wire-path map (what the route projects from the
// resolved manifest). `reportMediaAttach` is tested with the logger mocked so
// its log decision (and the empty-detail guard) is asserted directly.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { log } from "@/lib/logger";
import {
	interpretMediaAttach,
	type MediaAttachResult,
	mediaAttachWarnings,
	reportMediaAttach,
} from "../uploadOutcome";

vi.mock("@/lib/logger", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

/**
 * A doc with a standalone logo (`logo-asset`) and a `photo` question whose
 * label image is `img-asset`. The cast is sound: `walkAssetRefs` reads only
 * the order/entity maps + media slots present here.
 */
function doc(): BlueprintDoc {
	return {
		appId: "a",
		appName: "A",
		connectType: null,
		caseTypes: null,
		logo: "logo-asset",
		moduleOrder: ["m1"],
		modules: { m1: { uuid: "m1", id: "reg", name: "Registration" } },
		formOrder: { m1: ["f1"] },
		forms: {
			f1: { uuid: "f1", id: "intake", name: "Intake", type: "registration" },
		},
		fieldOrder: { f1: ["fld1"] },
		fields: {
			fld1: {
				kind: "text",
				uuid: "fld1",
				id: "photo",
				label: "Photo",
				label_media: { image: "img-asset" },
			},
		},
		fieldParent: {},
	} as unknown as BlueprintDoc;
}

const WIRE_PATHS = new Map([
	["logo-asset", "commcare/logo.png"],
	["img-asset", "commcare/img.png"],
]);

const LOGO = { path: "commcare/logo.png", reason: "Did not match any Image." };
const IMG = { path: "commcare/img.png", reason: "Did not match any Image." };

describe("interpretMediaAttach", () => {
	it("flags a logo-only unmatched file as expected, not a failure", () => {
		const out = interpretMediaAttach({
			unmatched: [LOGO],
			hqErrors: [],
			assetWirePath: WIRE_PATHS,
			doc: doc(),
		});
		expect(out.logoNotCarried).toBe(true);
		expect(out.failures).toEqual([]);
	});

	it("names the carrier for a genuine (form-media) unmatched file", () => {
		const out = interpretMediaAttach({
			unmatched: [IMG],
			hqErrors: [],
			assetWirePath: WIRE_PATHS,
			doc: doc(),
		});
		expect(out.logoNotCarried).toBe(false);
		expect(out.failures).toHaveLength(1);
		expect(out.failures[0].where).toBe(
			`the image on field "photo"'s label (form "Intake")`,
		);
		expect(out.failures[0].path).toBe("commcare/img.png");
	});

	it("separates the logo case from a co-occurring genuine failure", () => {
		const out = interpretMediaAttach({
			unmatched: [LOGO, IMG],
			hqErrors: [],
			assetWirePath: WIRE_PATHS,
			doc: doc(),
		});
		expect(out.logoNotCarried).toBe(true);
		expect(out.failures).toHaveLength(1);
		expect(out.failures[0].where).toContain('"photo"');
	});

	it("treats HQ processing errors as carrier-less genuine failures", () => {
		const out = interpretMediaAttach({
			unmatched: [],
			hqErrors: ["Error while processing zip"],
			assetWirePath: WIRE_PATHS,
			doc: doc(),
		});
		expect(out.failures).toEqual([
			{ where: "a media file", path: "", reason: "Error while processing zip" },
		]);
	});

	it("falls back to a generic phrase for an unmappable wire path", () => {
		const out = interpretMediaAttach({
			unmatched: [{ path: "commcare/ghost.png", reason: "?" }],
			hqErrors: [],
			assetWirePath: WIRE_PATHS,
			doc: doc(),
		});
		expect(out.failures).toHaveLength(1);
		expect(out.failures[0].where).toBe("an unrecognized media file");
		expect(out.logoNotCarried).toBe(false);
	});

	it("joins multiple carriers for one shared asset", () => {
		// `shared` is the label image on two questions; HQ reports its one wire
		// path unmatched → both carriers are named (Intl.ListFormat conjunction).
		const shared = {
			appId: "a",
			appName: "A",
			connectType: null,
			caseTypes: null,
			moduleOrder: ["m1"],
			modules: { m1: { uuid: "m1", id: "reg", name: "Registration" } },
			formOrder: { m1: ["f1"] },
			forms: {
				f1: { uuid: "f1", id: "intake", name: "Intake", type: "registration" },
			},
			fieldOrder: { f1: ["a1", "a2"] },
			fields: {
				a1: {
					kind: "text",
					uuid: "a1",
					id: "front",
					label: "Front",
					label_media: { image: "shared" },
				},
				a2: {
					kind: "text",
					uuid: "a2",
					id: "back",
					label: "Back",
					label_media: { image: "shared" },
				},
			},
			fieldParent: {},
		} as unknown as BlueprintDoc;

		const out = interpretMediaAttach({
			unmatched: [{ path: "commcare/s.png", reason: "?" }],
			hqErrors: [],
			assetWirePath: new Map([["shared", "commcare/s.png"]]),
			doc: shared,
		});
		expect(out.failures).toHaveLength(1);
		expect(out.failures[0].where).toBe(
			`the image on field "front"'s label (form "Intake") and the image on field "back"'s label (form "Intake")`,
		);
	});

	it("is clean when nothing is unmatched", () => {
		const out = interpretMediaAttach({
			unmatched: [],
			hqErrors: [],
			assetWirePath: WIRE_PATHS,
			doc: doc(),
		});
		expect(out).toEqual({ failures: [], logoNotCarried: false });
	});
});

describe("mediaAttachWarnings", () => {
	it("produces no lines for a clean outcome", () => {
		expect(
			mediaAttachWarnings({ failures: [], logoNotCarried: false }),
		).toEqual([]);
	});

	it("writes a 'couldn't attach' line per failure, naming the carrier", () => {
		const lines = mediaAttachWarnings({
			failures: [
				{ where: 'the image on field "photo"', path: "x", reason: "r" },
			],
			logoNotCarried: false,
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^Couldn't attach the image on field "photo"/);
	});

	it("writes a gentle logo line that points at CommCare HQ, not a re-upload", () => {
		const lines = mediaAttachWarnings({ failures: [], logoNotCarried: true });
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/logo/i);
		expect(lines[0]).toContain("CommCare HQ");
		expect(lines[0]).not.toMatch(/couldn't attach/i);
	});

	it("emits both a failure line and the logo line when both occur", () => {
		const lines = mediaAttachWarnings({
			failures: [{ where: "a media file", path: "", reason: "r" }],
			logoNotCarried: true,
		});
		expect(lines).toHaveLength(2);
	});
});

describe("reportMediaAttach", () => {
	beforeEach(() => vi.clearAllMocks());

	function result(over: Partial<MediaAttachResult> = {}): MediaAttachResult {
		return {
			matched: 0,
			unmatched: 0,
			unmatchedFiles: [],
			errors: [],
			...over,
		};
	}

	function run(result: MediaAttachResult): string[] {
		return reportMediaAttach({
			result,
			assetWirePath: WIRE_PATHS,
			doc: doc(),
			logPrefix: "[test]",
			logContext: { appId: "hq-1" },
		});
	}

	it("returns nothing and logs nothing for a clean result", () => {
		expect(run(result({ matched: 2 }))).toEqual([]);
		expect(log.warn).not.toHaveBeenCalled();
		expect(log.error).not.toHaveBeenCalled();
	});

	it("warns (Cloud-Logging only) for a standalone logo", () => {
		const lines = run(result({ unmatched: 1, unmatchedFiles: [LOGO] }));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/logo/i);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.error).not.toHaveBeenCalled();
	});

	it("errors (Sentry) and names the carrier for a genuine failure", () => {
		const lines = run(result({ unmatched: 1, unmatchedFiles: [IMG] }));
		expect(lines[0]).toMatch(/couldn't attach/i);
		expect(lines[0]).toContain("photo");
		expect(log.error).toHaveBeenCalledTimes(1);
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("does not go silent when a positive count carries no per-file detail", () => {
		// HQ couples unmatched_count to len(unmatched_files), so this shouldn't
		// happen — but a truncated/proxied response must still surface SOMETHING.
		const lines = run(result({ unmatched: 2, unmatchedFiles: [], errors: [] }));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/may not have attached/i);
		expect(log.error).toHaveBeenCalledTimes(1);
	});
});
