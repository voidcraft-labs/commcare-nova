/**
 * The media surface one bring-in request calls: the reader's index, the plan
 * of files, the findings over its verdicts, the files the birth records, the
 * declarations the review offers and the rows acceptance reads.
 *
 * Pure. A document whose asset ids differ between the read and the create, a
 * review answered before every file is judged, and a proposal moved though its
 * choice was still offered are what these cases catch.
 */

import { describe, expect, it } from "vitest";
import type { HqMediaMapItem } from "@/lib/commcare/hq/appSource";
import type {
	DeclarationChoice,
	DeclarationChoices,
} from "@/lib/doc/platformDeclaration";
import {
	asMediaAssetId,
	MAX_MEDIA_EXPORT_BYTES,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { provisionalReadingMediaId } from "../../mediaIds";
import {
	adoptedMediaFiles,
	type HqMediaReference,
	type HqMediaVerdict,
	type JudgedMediaFile,
	narrowDeclarationsByMedia,
	planReadingMedia,
	type ReadingMediaPlan,
	readingMediaFindings,
	readingMediaIndex,
	readingMediaRows,
} from "../media";

const APP = "7c0f1a52-5d3e-4a8b-9a51-2c3c2d4e5f60";
const QUESTION: HqPlace = {
	kind: "question",
	menu: 0,
	form: 0,
	menuName: "Visits",
	formName: "Register",
	path: "/photo",
};

const MAP: readonly HqMediaMapItem[] = [
	{
		path: "jr://file/a.png",
		mediaType: "CommCareImage",
		multimediaId: "a",
		unreadable: false,
	},
	{
		path: "jr://file/a2.png",
		mediaType: "CommCareImage",
		multimediaId: "a",
		unreadable: false,
	},
	{
		path: "jr://file/b.png",
		mediaType: "CommCareImage",
		multimediaId: "b",
		unreadable: false,
	},
	{
		path: "jr://file/s.mp3",
		mediaType: "CommCareAudio",
		multimediaId: "s",
		unreadable: false,
	},
	{
		path: "jr://file/none.png",
		mediaType: null,
		multimediaId: null,
		unreadable: false,
	},
	{
		path: "jr://file/bad.png",
		mediaType: null,
		multimediaId: null,
		unreadable: true,
	},
	{
		path: "jr://file/doc.png",
		mediaType: "CommCareMultimedia",
		multimediaId: "d",
		unreadable: false,
	},
];
const SOURCE = {
	multimediaMap: MAP,
	profile: { properties: { "cc-content-valid": "yes" } },
};
const ref = (
	path: string,
	kind: HqMediaReference["kind"] = "image",
): HqMediaReference => ({
	path,
	kind,
	slot: "form",
	place: QUESTION,
});
const REFERENCES = [
	ref("jr://file/a.png"),
	ref("jr://file/a2.png"),
	ref("jr://file/b.png"),
	ref("jr://file/s.mp3", "audio"),
];

function judged(contentHash: string, sizeBytes = 100): JudgedMediaFile {
	return {
		contentHash,
		mimeType: "image/png",
		extension: ".png",
		kind: "image",
		sizeBytes,
		mediaFormat: "png",
		dimensions: { width: 2, height: 3 },
		originalFilename: `${contentHash}.png`,
	};
}
const held = (contentHash: string, sizeBytes?: number): HqMediaVerdict => ({
	kind: "held",
	file: judged(contentHash, sizeBytes),
});

function planned() {
	return planReadingMedia({
		source: SOURCE,
		appId: APP,
		references: REFERENCES,
		runsOn: ["web-apps", "android"],
	});
}
function withVerdicts(
	plan: ReadingMediaPlan,
	verdicts: Record<string, HqMediaVerdict>,
	published: Record<string, string> = {},
): ReadingMediaPlan {
	return {
		...plan,
		verdicts,
		published: Object.fromEntries(
			Object.entries(published).map(([key, id]) => [key, asMediaAssetId(id)]),
		),
	};
}
const ASSET_A = "11111111-1111-4111-8111-111111111111";

describe("readingMediaIndex", () => {
	it("answers each row of the map: no entry, no file Nova can ask for, and an asset by its provisional id", () => {
		const index = readingMediaIndex({ source: SOURCE, appId: APP, plan: null });
		expect(index.resolve("jr://file/missing.png")).toEqual({
			kind: "no-entry",
		});
		expect(index.resolve("jr://file/none.png")).toEqual({ kind: "unreadable" });
		expect(index.resolve("jr://file/bad.png")).toEqual({ kind: "unreadable" });
		expect(index.resolve("jr://file/doc.png")).toEqual({ kind: "unreadable" });
		expect(index.resolve("jr://file/a.png")).toEqual({
			kind: "asset",
			assetId: provisionalReadingMediaId(APP, "CommCareImage", "a"),
			mediaKind: "image",
		});
		expect(index.resolve("jr://file/a2.png")).toEqual(
			index.resolve("jr://file/a.png"),
		);
		expect(index.resolve("jr://file/s.mp3")).toEqual({
			kind: "asset",
			assetId: provisionalReadingMediaId(APP, "CommCareAudio", "s"),
			mediaKind: "audio",
		});
	});

	it("answers a file judged missing as unreadable, and a published file by its asset", () => {
		const { plan } = planned();
		const index = readingMediaIndex({
			source: SOURCE,
			appId: APP,
			plan: withVerdicts(
				plan,
				{
					"CommCareImage/b": { kind: "missing" },
					"CommCareImage/a": held("h"),
				},
				{ "CommCareImage/a": ASSET_A },
			),
		});
		expect(index.resolve("jr://file/b.png")).toEqual({ kind: "unreadable" });
		expect(index.resolve("jr://file/a2.png")).toEqual({
			kind: "asset",
			assetId: ASSET_A,
			mediaKind: "image",
		});
		expect(index.resolve("jr://file/s.mp3")).toMatchObject({
			assetId: provisionalReadingMediaId(APP, "CommCareAudio", "s"),
		});
	});
});

describe("planReadingMedia", () => {
	it("makes one plan file per file, with its provisional id, no verdict, nothing kept and nothing published", () => {
		const { plan, media } = planned();
		expect(media.contentValid).toBe("yes");
		expect(plan).toEqual({
			files: [
				{
					key: "CommCareAudio/s",
					mediaType: "CommCareAudio",
					multimediaId: "s",
					kind: "audio",
					paths: ["jr://file/s.mp3"],
					provisionalId: provisionalReadingMediaId(APP, "CommCareAudio", "s"),
				},
				{
					key: "CommCareImage/a",
					mediaType: "CommCareImage",
					multimediaId: "a",
					kind: "image",
					paths: ["jr://file/a.png", "jr://file/a2.png"],
					provisionalId: provisionalReadingMediaId(APP, "CommCareImage", "a"),
				},
				{
					key: "CommCareImage/b",
					mediaType: "CommCareImage",
					multimediaId: "b",
					kind: "image",
					paths: ["jr://file/b.png"],
					provisionalId: provisionalReadingMediaId(APP, "CommCareImage", "b"),
				},
			],
			verdicts: {},
			kept: new Map(),
			published: {},
		});
	});

	it("names the same file alike in two calls for one app, and apart for another app", () => {
		const ids = (appId: string) =>
			planReadingMedia({
				source: SOURCE,
				appId,
				references: REFERENCES,
				runsOn: ["web-apps"],
			}).plan.files.map((file) => file.provisionalId);
		expect(ids(APP)).toEqual(ids(APP));
		expect(ids("1d6d2c0b-6a0a-4f33-8a1f-7a0e3d9c1b22")).not.toEqual(ids(APP));
	});

	it("reads only HQ’s explicit string preference as a lazy video registration", () => {
		for (const value of ["true", true, "false", undefined]) {
			const { media } = planReadingMedia({
				source: {
					multimediaMap: null,
					profile: { properties: { "lazy-load-video-files": value } },
				},
				appId: APP,
				references: [],
				runsOn: ["android"],
			});
			expect(media.lazyLoadVideos).toBe(value === "true");
		}
	});

	it("reads a media check at install that the source does not hold as on", () => {
		const { media } = planReadingMedia({
			source: { multimediaMap: null, profile: {} },
			appId: APP,
			references: [ref("jr://file/a.png")],
			runsOn: ["android"],
		});
		expect(media.contentValid).toBeNull();
		expect(media.findings.map((finding) => finding.code)).toEqual([
			"expressions-and-data/a-media-reference-with-no-file-on-a-slot-android-s-install",
		]);
	});
});

describe("planReadingMedia's log", () => {
	it("reports every reference of another kind as a finding, and logs them in one line with their count", () => {
		const count = 1_000;
		const map: HqMediaMapItem[] = [];
		const references: HqMediaReference[] = [];
		for (let index = 0; index < count; index++) {
			const path = `jr://file/sound-${index}.png`;
			map.push({
				path,
				mediaType: "CommCareAudio",
				multimediaId: `sound-${index}`,
				unreadable: false,
			});
			references.push(ref(path));
		}
		const { media } = planReadingMedia({
			source: { multimediaMap: map, profile: {} },
			appId: APP,
			references,
			runsOn: ["web-apps", "android"],
		});
		expect(media.findings).toHaveLength(count);
		expect(log.error).toHaveBeenCalledExactlyOnceWith(
			"[bring-in:media] media slots name a file of another kind",
			undefined,
			{
				count,
				samples: Array.from({ length: 5 }, () => ({
					slot: "form",
					kind: "image",
					mediaType: "CommCareAudio",
				})),
			},
		);
	});
});

describe("readingMediaFindings", () => {
	it("is complete once every file has a verdict", () => {
		const { plan, media } = planned();
		const out = readingMediaFindings({
			media,
			plan: withVerdicts(plan, {
				"CommCareAudio/s": held("s"),
				"CommCareImage/a": held("a"),
				"CommCareImage/b": held("b"),
			}),
			runsOn: ["web-apps", "android"],
		});
		expect(out).toMatchObject({
			findings: [],
			complete: true,
			playsOn: ["web-apps", "android"],
		});
	});

	it("is not complete where the request stopped at the byte ceiling, and carries the budget finding", () => {
		const { plan, media } = planned();
		const half = MAX_MEDIA_EXPORT_BYTES / 2 + 10 * 1024 * 1024;
		const out = readingMediaFindings({
			media,
			plan: withVerdicts(plan, {
				"CommCareAudio/s": held("s", half),
				"CommCareImage/a": held("a", half),
			}),
			runsOn: ["web-apps", "android"],
		});
		expect(out.complete).toBe(false);
		expect(out.findings).toEqual([
			{
				code: "expressions-and-data/an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app",
				standing: "not-yet",
				place: { kind: "app" },
				subject: "media-files",
				detail: { name: "220 MB of media (the limit is 200 MB)" },
			},
		]);
	});

	it("counts two files of the same bytes once against the budget", () => {
		const { plan, media } = planned();
		const half = MAX_MEDIA_EXPORT_BYTES / 2 + 10 * 1024 * 1024;
		const out = readingMediaFindings({
			media,
			plan: withVerdicts(plan, {
				"CommCareImage/a": held("same", half),
				"CommCareImage/b": held("same", half),
			}),
			runsOn: ["web-apps", "android"],
		});
		expect(out.findings).toEqual([]);
	});
});

describe("adoptedMediaFiles", () => {
	it("gives one file per path of each held file, two assets for one content before the publish and one after", () => {
		const { plan } = planned();
		const verdicts = {
			"CommCareImage/a": held("same"),
			"CommCareImage/b": held("same"),
			"CommCareAudio/s": { kind: "missing" } as const,
		};
		const before = adoptedMediaFiles(withVerdicts(plan, verdicts));
		expect(before).toEqual([
			{
				hqPath: "jr://file/a.png",
				assetId: provisionalReadingMediaId(APP, "CommCareImage", "a"),
				contentHash: "same",
				extension: ".png",
			},
			{
				hqPath: "jr://file/a2.png",
				assetId: provisionalReadingMediaId(APP, "CommCareImage", "a"),
				contentHash: "same",
				extension: ".png",
			},
			{
				hqPath: "jr://file/b.png",
				assetId: provisionalReadingMediaId(APP, "CommCareImage", "b"),
				contentHash: "same",
				extension: ".png",
			},
		]);
		const after = adoptedMediaFiles(
			withVerdicts(plan, verdicts, {
				"CommCareImage/a": ASSET_A,
				"CommCareImage/b": ASSET_A,
			}),
		);
		expect(new Set(after.map((file) => file.assetId))).toEqual(
			new Set([ASSET_A]),
		);
		expect(after.map((file) => file.hqPath)).toEqual(
			before.map((file) => file.hqPath),
		);
	});
});

describe("narrowDeclarationsByMedia", () => {
	const choice = (
		runsOnlyOn: DeclarationChoice["runsOnlyOn"],
	): DeclarationChoice => ({
		runsOnlyOn,
		split: false,
		mutations: [],
		splits: [],
	});
	const BOTH = choice(undefined);
	const ANDROID = choice("android");
	const WEB = choice("web-apps");
	const choices = (proposed: number): DeclarationChoices => ({
		kind: "choices",
		choices: [BOTH, ANDROID, WEB],
		proposed,
		narrowedByHq: true,
		keepsWebApps: false,
	});

	it("drops a choice that declares a platform no held file plays on, keeping the proposal on its choice", () => {
		expect(narrowDeclarationsByMedia(choices(1), ["android"])).toEqual({
			kind: "choices",
			choices: [ANDROID],
			proposed: 0,
			narrowedByHq: true,
			keepsWebApps: false,
		});
		expect(
			narrowDeclarationsByMedia(choices(2), ["web-apps", "android"]),
		).toEqual(choices(2));
	});

	it("moves a proposal whose choice left to the first choice left", () => {
		expect(narrowDeclarationsByMedia(choices(0), ["web-apps"])).toEqual({
			kind: "choices",
			choices: [WEB],
			proposed: 0,
			narrowedByHq: true,
			keepsWebApps: false,
		});
	});

	it("answers none where no choice is left, and gives a none input back as it is", () => {
		expect(narrowDeclarationsByMedia(choices(0), [])).toEqual({
			kind: "none",
			blocking: [],
		});
		const none: DeclarationChoices = {
			kind: "none",
			blocking: [],
			splitRefused: undefined,
		};
		expect(narrowDeclarationsByMedia(none, ["android"])).toBe(none);
	});
});

describe("readingMediaRows", () => {
	it("gives one ready record per held file under the id the document names, the published id once there is one", () => {
		const { plan } = planned();
		const verdicts = {
			"CommCareImage/a": held("ha"),
			"CommCareImage/b": {
				kind: "over-limit",
				mediaKind: "image",
				capBytes: 1,
			} as const,
			"CommCareAudio/s": { kind: "missing" } as const,
		};
		const record = {
			project_id: "",
			owner: "",
			contentHash: "ha",
			mimeType: "image/png",
			extension: ".png",
			sizeBytes: 100,
			dimensions: { width: 2, height: 3 },
			mediaFormat: "png",
			kind: "image",
			gcsObjectKey: "",
			originalFilename: "ha.png",
			status: "ready",
			created_at: new Date(0),
		};
		const provisional = provisionalReadingMediaId(APP, "CommCareImage", "a");
		expect(readingMediaRows(withVerdicts(plan, verdicts))).toEqual(
			new Map([[provisional, { id: provisional, ...record }]]),
		);
		expect(
			readingMediaRows(
				withVerdicts(plan, verdicts, { "CommCareImage/a": ASSET_A }),
			),
		).toEqual(new Map([[ASSET_A, { id: ASSET_A, ...record }]]));
	});
});
