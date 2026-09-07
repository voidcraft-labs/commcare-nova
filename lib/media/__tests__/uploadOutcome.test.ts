// lib/media/__tests__/uploadOutcome.test.ts
//
// Unit coverage for the media-attach interpreter + reporter — the pieces that
// turn HQ's bare `unmatched_files` report into "which media, where, didn't
// attach", separate the by-design app-logo case from a genuine failure, and
// emit the warn/error log decision.
//
// `interpretMediaAttach` runs against a real `walkAssetRefs` over a normalized
// doc + a plain asset → wire-path map (what the route projects from the
// resolved manifest). `reportMediaAttach` is tested with the logger mocked so
// its log decision (and the empty-detail guard) is asserted directly.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
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

const LOGO_ID = testMediaAssetId("logo");
const IMAGE_ID = testMediaAssetId("image");

function doc(): BlueprintDoc {
	const blueprint = buildDoc({
		modules: [
			{
				name: "Registration",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [
							{
								kind: "text",
								id: "photo",
								label: proseText("Photo"),
								label_media: { image: IMAGE_ID },
							},
						],
					},
				],
			},
		],
	});
	blueprint.logo = LOGO_ID;
	return blueprint;
}

const WIRE_PATHS = new Map([
	[LOGO_ID, "commcare/logo.png"],
	[IMAGE_ID, "commcare/img.png"],
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

	it("treats an image reused as logo and form media as a failure, naming every carrier", () => {
		// One asset is the logo and two label images. A bulk-upload failure
		// must still report the form media even though it also serves the logo.
		const sharedId = testMediaAssetId("shared");
		const shared = buildDoc({
			modules: [
				{
					name: "Registration",
					forms: [
						{
							name: "Intake",
							type: "survey",
							fields: ["front", "back"].map((id) => ({
								kind: "text",
								id,
								label_media: { image: sharedId },
							})),
						},
					],
				},
			],
		});
		shared.logo = sharedId;

		const out = interpretMediaAttach({
			unmatched: [{ path: "commcare/s.png", reason: "?" }],
			hqErrors: [],
			assetWirePath: new Map([[sharedId, "commcare/s.png"]]),
			doc: shared,
		});
		expect(out.failures).toHaveLength(1);
		expect(out.failures[0].where).toContain('"front"');
		expect(out.failures[0].where).toContain('"back"');
		expect(out.failures[0].where).toContain("logo");
		expect(out.logoNotCarried).toBe(false);
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
		expect(log.error).toHaveBeenCalledExactlyOnceWith(
			expect.any(String),
			undefined,
			{
				appId: "hq-1",
				matched: 0,
				unmatched: 1,
				failures: [
					{
						where: expect.stringContaining("photo"),
						path: IMG.path,
						reason: IMG.reason,
					},
				],
			},
		);
		expect(lines.join(" ")).not.toContain(IMG.path);
		expect(lines.join(" ")).not.toContain(IMG.reason);
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
