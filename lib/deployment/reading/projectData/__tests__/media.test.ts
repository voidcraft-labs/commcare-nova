/**
 * Which files an app brought in from CommCare HQ references, what each
 * reference with no file is, and what each verdict on a file's bytes says.
 *
 * Pure, over references and media maps the cases build: a finding that stops
 * the pass, a wrong entry id, a format silently accepted and a video handed to
 * a sound slot (which the birth would refuse) are what these cases catch.
 */

import { describe, expect, it, vi } from "vitest";
import type { HqMediaMapItem } from "@/lib/commcare/hq/appSource";
import type { ReadFacts } from "@/lib/commcare/reader";
import { MAX_MEDIA_EXPORT_ASSETS } from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import type { HqPlace } from "@/lib/publish/hqFindings";
import {
	androidInstallCheckReaches,
	type HqMediaReference,
	type HqMediaVerdict,
	hqMediaReferencesOf,
	hqMediaRefusalEntry,
	type JudgedMediaFile,
	mediaFindings,
	mediaLeftOutOf,
	mediaSlotDrawnOn,
	planHqMedia,
} from "../media";

const E = "expressions-and-data/";
const QUESTION: HqPlace = {
	kind: "question",
	menu: 0,
	form: 0,
	menuName: "Visits",
	formName: "Register",
	path: "/name",
};
const FORM: HqPlace = {
	kind: "form",
	menu: 0,
	form: 0,
	menuName: "Visits",
	name: "Register",
};
const FORM_2: HqPlace = { ...FORM, form: 1, name: "Follow up" };
const CASE_LIST: HqPlace = { kind: "case-list", menu: 0, name: "Visits" };
const MENU_0: HqPlace = { kind: "menu", menu: 0, name: "Visits" };
const MENU_1: HqPlace = { kind: "menu", menu: 1, name: "Reports" };

function ref(
	path: string,
	kind: HqMediaReference["kind"],
	slot: HqMediaReference["slot"],
	place: HqPlace = QUESTION,
): HqMediaReference {
	return { path, kind, slot, place };
}
function entry(
	path: string,
	mediaType: HqMediaMapItem["mediaType"],
	multimediaId: string | null = "f1",
): HqMediaMapItem {
	return {
		path,
		mediaType: multimediaId === null ? null : mediaType,
		multimediaId,
		unreadable: false,
	};
}
const unreadableEntry = (path: string): HqMediaMapItem => ({
	path,
	mediaType: null,
	multimediaId: null,
	unreadable: true,
});

function plan(
	references: readonly HqMediaReference[],
	multimediaMap: readonly HqMediaMapItem[],
	runsOn: readonly ("web-apps" | "android")[] = ["web-apps", "android"],
	contentValid: string | null = "yes",
	lazyLoadVideos = false,
) {
	return planHqMedia({
		references,
		multimediaMap,
		runsOn,
		contentValid,
		lazyLoadVideos,
	});
}

describe("hqMediaReferencesOf", () => {
	const facts = (slot: string) =>
		({
			mediaReferences: [
				{
					path: "jr://file/a.png",
					assetId: "asset",
					mediaKind: "image",
					place: QUESTION,
					slot,
				},
			],
			unheldMedia: [],
			pendingMedia: [
				{
					path: "jr://file/b.mp3",
					mediaKind: "audio",
					resolution: "no-entry",
					place: QUESTION,
					slot,
				},
			],
		}) as unknown as ReadFacts;

	it.each([
		["field_media_bundle", "form"],
		["option_media", "choice"],
		["image_map_mapping", "list-image"],
		["module_icon", "tile"],
		["module_audio_label", "tile"],
		["form_icon", "tile"],
		["form_audio_label", "tile"],
		["case_list_icon", "tile"],
		["case_list_audio_label", "tile"],
		["case_list_registration_icon", "register-action"],
		["case_list_registration_audio_label", "register-action"],
		["app_logo", "logo"],
		["unheld_itext", "unheld-itext"],
	] as const)(
		"reads the reader's %s as %s, resolved and handed off alike",
		(slot, expected) => {
			expect(hqMediaReferencesOf(facts(slot))).toEqual([
				ref("jr://file/a.png", "image", expected),
				ref("jr://file/b.mp3", "audio", expected),
			]);
		},
	);

	it("throws on a slot word the table lacks, so a new carrier cannot pass unjudged", () => {
		expect(() => hqMediaReferencesOf(facts("case_tile_icon"))).toThrow(
			/case_tile_icon/,
		);
		expect(() => hqMediaReferencesOf(facts("toString"))).toThrow(/toString/);
	});
});

describe("planHqMedia", () => {
	it("refuses a mapped path outside jr://file/ and fetches nothing for it", () => {
		const out = plan(
			[ref("commcare/a.png", "image", "form")],
			[entry("commcare/a.png", "CommCareImage")],
		);
		expect(out.files).toEqual([]);
		expect(out.findings).toEqual([
			expect.objectContaining({
				code: `${E}multimedia-map-key-not-under-jr-file-that-the-build-keeps`,
				standing: "fix-in-hq",
				place: { kind: "media", path: "commcare/a.png" },
				detail: { name: "commcare/a.png" },
			}),
		]);
	});

	it("reads a path with no entry by the no-entry rule: a question's image drawn on Android is the source's to fix", () => {
		const out = plan(
			[ref("jr://file/a.png", "image", "form")],
			[],
			["android"],
		);
		expect(out.findings).toEqual([
			{
				code: `${E}a-media-reference-with-no-file-on-a-slot-a-runtime-draws`,
				standing: "fix-in-hq",
				cause: "breaks-when-run",
				place: QUESTION,
				subject: "missing-media-files",
				detail: { name: "jr://file/a.png" },
			},
		]);
		expect(out.inert).toEqual([]);
	});

	it("reads an entry with a null id as no file, not no entry: Web Apps builds an address from it", () => {
		const out = plan(
			[ref("jr://file/a.png", "image", "form")],
			[entry("jr://file/a.png", "CommCareImage", null)],
			["web-apps"],
		);
		expect(out.files).toEqual([]);
		expect(out.findings).toEqual([
			{
				code: "media-file-unreadable",
				standing: "fix-in-hq",
				place: { kind: "media", path: "jr://file/a.png" },
				subject: null,
				detail: { name: "jr://file/a.png" },
			},
		]);
	});

	it("reads an unreadable entry as no file", () => {
		const out = plan(
			[ref("jr://file/a.png", "image", "form")],
			[unreadableEntry("jr://file/a.png")],
			["web-apps"],
		);
		expect(out.findings.map((finding) => finding.code)).toEqual([
			"media-file-unreadable",
		]);
	});

	it("reports an entry HQ files as neither picture, sound nor video as Nova's to classify", () => {
		const out = plan(
			[ref("jr://file/a.png", "image", "form")],
			[entry("jr://file/a.png", "CommCareMultimedia")],
		);
		expect(out.files).toEqual([]);
		expect(out.findings).toEqual([
			{
				code: "unrecognized",
				standing: "not-yet",
				place: QUESTION,
				subject: null,
				detail: { name: "jr://file/a.png" },
			},
		]);
		expect(vi.mocked(log.error)).toHaveBeenCalled();
	});

	it("files a sound slot naming a file HQ filed as video under the M4A entry, and hands the file to no sound slot", () => {
		const out = plan(
			[
				ref("jr://file/clip.m4a", "audio", "form"),
				ref("jr://file/clip.m4a", "video", "form", FORM),
			],
			[entry("jr://file/clip.m4a", "CommCareVideo", "v1")],
		);
		expect(out.findings).toEqual([
			expect.objectContaining({
				code: `${E}audio-m4a-with-another-brand-isom-mp41-mp42-dash`,
				standing: "fix-in-hq",
				cause: "breaks-when-run",
				place: QUESTION,
				detail: { name: "jr://file/clip.m4a" },
			}),
		]);
		expect(out.files).toEqual([
			{
				key: "CommCareVideo/v1",
				mediaType: "CommCareVideo",
				multimediaId: "v1",
				kind: "video",
				paths: ["jr://file/clip.m4a"],
				references: [ref("jr://file/clip.m4a", "video", "form", FORM)],
			},
		]);
	});

	it("fetches no file only a sound slot names when HQ filed it as video", () => {
		const out = plan(
			[ref("jr://file/clip.m4a", "audio", "form")],
			[entry("jr://file/clip.m4a", "CommCareVideo", "v1")],
		);
		expect(out.files).toEqual([]);
	});

	it("reports a picture slot naming a sound as Nova's to classify, naming the slot and the entry", () => {
		const out = plan(
			[ref("jr://file/a.mp3", "image", "form")],
			[entry("jr://file/a.mp3", "CommCareAudio")],
		);
		expect(out.files).toEqual([]);
		expect(out.findings).toEqual([
			expect.objectContaining({
				code: "unrecognized",
				place: QUESTION,
				detail: { name: "jr://file/a.mp3 (image slot, CommCareAudio)" },
			}),
		]);
	});

	it("makes one file of every path that names it, its paths in code-unit order", () => {
		const out = plan(
			[
				ref("jr://file/b.png", "image", "form"),
				ref("jr://file/a.png", "image", "tile", MENU_0),
				ref("jr://file/B.png", "image", "choice"),
				ref("jr://file/c.png", "image", "form"),
			],
			[
				entry("jr://file/a.png", "CommCareImage", "same"),
				entry("jr://file/b.png", "CommCareImage", "same"),
				entry("jr://file/B.png", "CommCareImage", "same"),
				entry("jr://file/c.png", "CommCareImage", "other"),
			],
		);
		expect(out.findings).toEqual([]);
		expect(out.files.map((file) => [file.key, file.paths])).toEqual([
			["CommCareImage/other", ["jr://file/c.png"]],
			[
				"CommCareImage/same",
				["jr://file/B.png", "jr://file/a.png", "jr://file/b.png"],
			],
		]);
		expect(out.files[1]?.references).toHaveLength(3);
	});

	it("lists every one of 501 files, past what one in-memory export takes, with no finding", () => {
		const count = MAX_MEDIA_EXPORT_ASSETS + 1;
		const paths = Array.from({ length: count }, (_, i) => `jr://file/${i}.png`);
		const out = plan(
			paths.map((path) => ref(path, "image", "form")),
			paths.map((path, i) => entry(path, "CommCareImage", `id${i}`)),
		);
		expect(out.files).toHaveLength(count);
		expect(out.findings).toEqual([]);
	});

	it("leaves out what nothing the app runs on draws, and files it under the INERT entry", () => {
		const icon = ref("jr://file/icon.png", "image", "tile", MENU_0);
		const register = ref(
			"jr://file/r.mp3",
			"audio",
			"register-action",
			CASE_LIST,
		);
		const choice = ref("jr://file/c.png", "image", "choice");
		const out = plan([icon, register, choice], [], ["web-apps"]);
		expect(out.findings).toEqual([]);
		expect(out.inert).toEqual([icon, register, choice]);
		expect(out.claims).toEqual(
			[icon, register, choice].map((reference) => ({
				reference,
				entry: `${E}a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map`,
				brokenPicture: false,
			})),
		);
		expect(mediaLeftOutOf(out.claims)).toEqual({
			undrawn: 3,
			brokenPictures: 0,
		});
	});

	it("discloses the broken Web Apps picture for an icon whose map entry has no file id", () => {
		const menu = ref("jr://file/m.png", "image", "tile", MENU_0);
		const form = ref("jr://file/f.png", "image", "tile", FORM);
		const register = ref(
			"jr://file/r.png",
			"image",
			"register-action",
			CASE_LIST,
		);
		const logo = ref("jr://file/logo.png", "image", "logo", { kind: "app" });
		const icons = [menu, form, register, logo];
		// These entries lack file ids. No Android download has been attempted.
		const out = plan(
			icons,
			icons.map((icon) => entry(icon.path, "CommCareImage", null)),
			["web-apps", "android"],
		);
		expect(out.findings).toEqual([]);
		expect(out.inert).toEqual(icons);
		expect(out.claims).toEqual(
			icons.map((reference) => ({
				reference,
				entry: `${E}a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map`,
				brokenPicture: true,
			})),
		);
		expect(mediaLeftOutOf(out.claims)).toEqual({
			undrawn: 0,
			brokenPictures: 4,
		});
		// A sound there is a play button with nothing to play, still CommCare HQ's to fix.
		const sound = ref("jr://file/m.mp3", "audio", "tile", MENU_0);
		expect(
			plan([sound], [entry(sound.path, "CommCareAudio", null)], ["web-apps"])
				.findings,
		).toEqual([expect.objectContaining({ code: "media-file-unreadable" })]);
		// With no entry Web Apps shows no icon at all, which no worker sees.
		expect(plan([menu], [], ["web-apps"]).claims).toEqual([
			{
				reference: menu,
				entry: `${E}a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map`,
				brokenPicture: false,
			},
		]);
	});

	it("refuses a reference Android's install check reaches while the project space checks media at install", () => {
		const choice = ref("jr://file/c.mp3", "audio", "choice");
		for (const contentValid of [null, "no"]) {
			expect(plan([choice], [], ["android"], contentValid).findings).toEqual([
				expect.objectContaining({
					code: `${E}a-media-reference-with-no-file-on-a-slot-android-s-install`,
					standing: "fix-in-hq",
					place: QUESTION,
					detail: { name: "jr://file/c.mp3" },
				}),
			]);
		}
		// With the check off, a choice's sound is still drawn on Android.
		expect(plan([choice], [], ["android"], "yes").findings).toEqual([
			expect.objectContaining({
				code: `${E}a-media-reference-with-no-file-on-a-slot-a-runtime-draws`,
			}),
		]);
		// An app that runs in Web Apps alone meets neither: Web Apps never receives a choice's media.
		const webOnly = plan([choice], [], ["web-apps"], null);
		expect(webOnly.findings).toEqual([]);
		expect(webOnly.inert).toEqual([choice]);
	});
});

describe("the first-match rule over every slot, declaration and install setting", () => {
	/* The four rows of the first-match rule, written out here rather than
	 * recomputed through the functions under test: the install check
	 * (where Android is declared and the project space checks media at install,
	 * a slot the check reaches), then a slot a declared runtime draws (an
	 * unreadable file where the entry names no file), then inert. A tile is a
	 * form's, whose own audio the check reaches and whose icon alone it does
	 * not. */
	const REACHED: Readonly<
		Record<HqMediaReference["slot"], (kind: string) => boolean>
	> = {
		form: () => true,
		choice: () => true,
		"unheld-itext": () => true,
		tile: (kind) => kind === "audio",
		"list-image": () => false,
		"register-action": () => false,
		logo: () => false,
	};
	const DRAWN_ON_ANDROID = new Set(["form", "choice", "list-image"]);
	/* An icon whose map entry has no usable file id: Web Apps can show a broken picture, and
	 * it is left out, said by the first publish. */
	const brokenPicture = (
		slot: HqMediaReference["slot"],
		kind: string,
		missing: "no-entry" | "no-file",
	) =>
		missing === "no-file" &&
		kind === "image" &&
		(slot === "tile" || slot === "register-action" || slot === "logo");
	const drawnInWebApps = (
		slot: HqMediaReference["slot"],
		kind: string,
		missing: "no-entry" | "no-file",
	) =>
		missing === "no-file"
			? slot !== "choice" && slot !== "unheld-itext"
			: slot === "list-image" ||
				(slot === "form" && (kind === "audio" || kind === "video"));
	const KINDS: Readonly<
		Record<HqMediaReference["slot"], readonly HqMediaReference["kind"][]>
	> = {
		form: ["image", "audio", "video"],
		choice: ["image", "audio", "video"],
		"unheld-itext": ["image", "audio"],
		tile: ["image", "audio"],
		"list-image": ["image"],
		"register-action": ["image", "audio"],
		logo: ["image"],
	};
	const PLACE: Readonly<Record<HqMediaReference["slot"], HqPlace>> = {
		form: QUESTION,
		choice: QUESTION,
		"unheld-itext": QUESTION,
		tile: FORM,
		"list-image": CASE_LIST,
		"register-action": CASE_LIST,
		logo: { kind: "app" },
	};
	const DECLARATIONS = [
		["web-apps"],
		["android"],
		["web-apps", "android"],
	] as const;

	it("gives each reference the first row that matches", () => {
		let cases = 0;
		for (const slot of Object.keys(KINDS) as HqMediaReference["slot"][])
			for (const kind of KINDS[slot])
				for (const runsOn of DECLARATIONS)
					for (const contentValid of ["yes", "no", null])
						for (const missing of ["no-entry", "no-file"] as const) {
							const reference = ref(
								`jr://file/x.${kind}`,
								kind,
								slot,
								PLACE[slot],
							);
							const out = plan(
								[reference],
								missing === "no-entry"
									? []
									: [entry(reference.path, "CommCareImage", null)],
								runsOn,
								contentValid,
							);
							const android = (runsOn as readonly string[]).includes("android");
							const web = (runsOn as readonly string[]).includes("web-apps");
							const drawn =
								(android && DRAWN_ON_ANDROID.has(slot)) ||
								(web && drawnInWebApps(slot, kind, missing));
							const broken = drawn && web && brokenPicture(slot, kind, missing);
							const expected =
								android && contentValid !== "yes" && REACHED[slot](kind)
									? `${E}a-media-reference-with-no-file-on-a-slot-android-s-install`
									: broken
										? "inert"
										: drawn
											? missing === "no-entry"
												? `${E}a-media-reference-with-no-file-on-a-slot-a-runtime-draws`
												: "media-file-unreadable"
											: "inert";
							const got =
								out.findings.length > 0
									? out.findings.map((finding) => finding.code).join(", ")
									: out.inert.length === 1
										? "inert"
										: "nothing";
							expect(
								got,
								`${slot} ${kind} on ${runsOn.join("+")}, cc-content-valid ${contentValid}, ${missing}`,
							).toBe(expected);
							if (expected === "inert")
								expect(out.claims).toEqual([
									{
										reference,
										entry: `${E}a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map`,
										brokenPicture: broken,
									},
								]);
							cases++;
						}
		expect(cases).toBe(14 * 3 * 3 * 2);
	});
});

describe("mediaSlotDrawnOn", () => {
	it("draws on Android a question's, a choice's and a list's media, and no tile, Register action, logo or unheld form", () => {
		for (const missing of ["no-entry", "no-file"] as const) {
			for (const slot of ["form", "choice", "list-image"] as const)
				expect(mediaSlotDrawnOn(slot, "image", "android", missing)).toBe(true);
			for (const slot of [
				"tile",
				"register-action",
				"logo",
				"unheld-itext",
			] as const)
				expect(mediaSlotDrawnOn(slot, "audio", "android", missing)).toBe(false);
		}
	});

	it("draws in Web Apps every slot but a choice and an unheld form where the entry names no file, and only a question's sound or video and a list's image cell where there is no entry", () => {
		for (const slot of [
			"form",
			"list-image",
			"tile",
			"register-action",
			"logo",
		] as const)
			expect(mediaSlotDrawnOn(slot, "image", "web-apps", "no-file")).toBe(true);
		for (const slot of ["choice", "unheld-itext"] as const)
			for (const missing of ["no-entry", "no-file"] as const)
				expect(mediaSlotDrawnOn(slot, "audio", "web-apps", missing)).toBe(
					false,
				);
		expect(mediaSlotDrawnOn("form", "audio", "web-apps", "no-entry")).toBe(
			true,
		);
		expect(mediaSlotDrawnOn("form", "video", "web-apps", "no-entry")).toBe(
			true,
		);
		expect(mediaSlotDrawnOn("form", "image", "web-apps", "no-entry")).toBe(
			false,
		);
		expect(mediaSlotDrawnOn("tile", "image", "web-apps", "no-entry")).toBe(
			false,
		);
		// The cell's `<img>` has no address and a no-break space for its text,
		// which the browser draws as a broken picture.
		expect(
			mediaSlotDrawnOn("list-image", "image", "web-apps", "no-entry"),
		).toBe(true);
		for (const slot of ["register-action", "logo"] as const)
			expect(mediaSlotDrawnOn(slot, "image", "web-apps", "no-entry")).toBe(
				false,
			);
	});
});

describe("androidInstallCheckReaches", () => {
	const formIcon = ref("jr://file/fi.png", "image", "tile", FORM);
	const formAudio = ref("jr://file/fa.mp3", "audio", "tile", FORM);
	const listIcon = ref("jr://file/li.png", "image", "tile", CASE_LIST);
	const listAudio = ref("jr://file/la.mp3", "audio", "tile", CASE_LIST);
	const menuIcon = ref("jr://file/mi.png", "image", "tile", MENU_1);
	const menuAudio = ref("jr://file/ma.mp3", "audio", "tile", MENU_1);
	const earlyIcon = ref("jr://file/ei.png", "image", "tile", MENU_0);
	const earlyAudio = ref("jr://file/ea.mp3", "audio", "tile", MENU_0);

	it("reaches every itext media form", () => {
		for (const slot of ["form", "choice", "unheld-itext"] as const)
			expect(androidInstallCheckReaches(ref("p", "image", slot), [])).toBe(
				true,
			);
		for (const slot of ["list-image", "register-action", "logo"] as const)
			expect(androidInstallCheckReaches(ref("p", "image", slot), [])).toBe(
				false,
			);
	});

	it("reaches an entry's audio, and its icon only where the same entry carries audio", () => {
		expect(androidInstallCheckReaches(formAudio, [formAudio])).toBe(true);
		expect(androidInstallCheckReaches(formIcon, [formIcon])).toBe(false);
		expect(androidInstallCheckReaches(formIcon, [formIcon, formAudio])).toBe(
			true,
		);
		// Another form's audio is not this form's.
		const other = ref("jr://file/o.mp3", "audio", "tile", FORM_2);
		expect(androidInstallCheckReaches(formIcon, [formIcon, other])).toBe(false);
		expect(androidInstallCheckReaches(listIcon, [listIcon, listAudio])).toBe(
			true,
		);
	});

	it("reaches a menu only where every entry and every earlier menu carries both", () => {
		const all = [
			formIcon,
			formAudio,
			listIcon,
			listAudio,
			earlyIcon,
			earlyAudio,
			menuIcon,
			menuAudio,
		];
		expect(androidInstallCheckReaches(menuAudio, all)).toBe(true);
		expect(androidInstallCheckReaches(menuIcon, all)).toBe(true);
		// An entry with no icon throws before any menu is checked.
		expect(
			androidInstallCheckReaches(
				menuAudio,
				all.filter((each) => each !== listIcon),
			),
		).toBe(false);
		// So does an earlier menu with no audio.
		expect(
			androidInstallCheckReaches(
				menuAudio,
				all.filter((each) => each !== earlyAudio),
			),
		).toBe(false);
		// A later menu lacking one does not stop an earlier one.
		expect(
			androidInstallCheckReaches(
				earlyAudio,
				all.filter((each) => each !== menuIcon),
			),
		).toBe(true);
		// A menu icon with no audio on that menu is never checked.
		expect(
			androidInstallCheckReaches(
				menuIcon,
				all.filter((each) => each !== menuAudio),
			),
		).toBe(false);
	});
});

describe("hqMediaRefusalEntry", () => {
	it.each([
		["image/svg+xml", "svg-not-accepted", "CommCareImage", "image-svg"],
		["image/tiff", "mime-claim-mismatch", "CommCareImage", "image-tiff-heif"],
		["image/heic", "mime-claim-mismatch", "CommCareImage", "image-tiff-heif"],
		["image/avif", "image-parse-failed", "CommCareImage", "image-tiff-heif"],
		[
			"audio/wav",
			"codec-not-accepted",
			"CommCareAudio",
			"audio-wav-that-is-not-8-or-16-bit-pcm",
		],
		[
			"audio/mp4",
			"container-brand-not-accepted",
			"CommCareAudio",
			"audio-m4a-with-another-brand-isom-mp41-mp42-dash",
		],
		["video/3gpp", "mime-claim-mismatch", "CommCareAudio", "audio-3gp"],
		[
			"video/3gpp",
			"mime-claim-mismatch",
			"CommCareVideo",
			"video-av1-mov-avi-ogg-theora-h-263-3gp",
		],
		[
			"video/quicktime",
			"mime-claim-mismatch",
			"CommCareVideo",
			"video-av1-mov-avi-ogg-theora-h-263-3gp",
		],
		[
			"video/vnd.avi",
			"mime-claim-mismatch",
			"CommCareVideo",
			"video-av1-mov-avi-ogg-theora-h-263-3gp",
		],
		[
			"video/x-msvideo",
			"mime-claim-mismatch",
			"CommCareVideo",
			"video-av1-mov-avi-ogg-theora-h-263-3gp",
		],
		[
			"video/ogg",
			"codec-not-accepted",
			"CommCareVideo",
			"video-av1-mov-avi-ogg-theora-h-263-3gp",
		],
		[
			"video/mp4",
			"codec-not-accepted",
			"CommCareVideo",
			"video-av1-mov-avi-ogg-theora-h-263-3gp",
		],
		[
			"video/mp4",
			"media-parse-failed",
			"CommCareVideo",
			"video-av1-mov-avi-ogg-theora-h-263-3gp",
		],
	] as const)(
		"files %s refused for %s (%s) under %s",
		(mime, reason, mediaType, expected) => {
			expect(hqMediaRefusalEntry(mime, reason, mediaType)).toBe(
				`${E}${expected}`,
			);
		},
	);

	it("answers null for a format no row names, and for an Ogg sound refused for its codec", () => {
		expect(
			hqMediaRefusalEntry(
				"application/pdf",
				"mime-claim-mismatch",
				"CommCareImage",
			),
		).toBeNull();
		expect(
			hqMediaRefusalEntry(null, "magic-bytes-sniff-failed", "CommCareImage"),
		).toBeNull();
		expect(
			hqMediaRefusalEntry("audio/ogg", "codec-not-accepted", "CommCareAudio"),
		).toBeNull();
	});
});

describe("mediaFindings", () => {
	const judged = (
		mediaFormat: JudgedMediaFile["mediaFormat"],
		kind: JudgedMediaFile["kind"] = "image",
	): JudgedMediaFile => ({
		contentHash: `hash-${mediaFormat}`,
		mimeType: "image/png",
		extension: ".png",
		kind,
		sizeBytes: 10,
		mediaFormat,
		originalFilename: "a.png",
	});
	const files = (runsOn: readonly ("web-apps" | "android")[]) =>
		plan(
			[
				ref("jr://file/a.png", "image", "form"),
				ref("jr://file/b.png", "image", "tile", FORM),
			],
			[
				entry("jr://file/a.png", "CommCareImage", "a"),
				entry("jr://file/b.png", "CommCareImage", "b"),
			],
			runsOn,
		);

	it("words each verdict with its entry, standing and name", () => {
		const cases: readonly [HqMediaVerdict, unknown][] = [
			[
				{ kind: "over-limit", mediaKind: "image", capBytes: 5 * 1024 * 1024 },
				{
					code: `${E}an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app`,
					standing: "not-yet",
					place: { kind: "media", path: "jr://file/a.png" },
					subject: "media-files",
					detail: {
						name: "jr://file/a.png (over 5 MB, the most Nova takes for a picture)",
					},
				},
			],
			[
				{
					kind: "refused",
					reason: "svg-not-accepted",
					sniffedMime: "image/svg+xml",
				},
				{
					code: `${E}image-svg`,
					standing: "fix-in-hq",
					cause: "breaks-when-run",
					place: { kind: "media", path: "jr://file/a.png" },
					subject: "media-files",
					detail: { name: "jr://file/a.png" },
				},
			],
			[
				{
					kind: "refused",
					reason: "mime-claim-mismatch",
					sniffedMime: "application/pdf",
				},
				{
					code: "unrecognized",
					standing: "not-yet",
					place: { kind: "media", path: "jr://file/a.png" },
					subject: null,
					detail: { name: "jr://file/a.png" },
				},
			],
			[
				{ kind: "wrong-kind", sniffedKind: "audio" },
				{
					code: "unrecognized",
					standing: "not-yet",
					place: { kind: "media", path: "jr://file/a.png" },
					subject: null,
					detail: { name: "jr://file/a.png" },
				},
			],
		];
		const media = files(["web-apps", "android"]);
		for (const [verdict, finding] of cases) {
			const out = mediaFindings({
				plan: media,
				verdicts: { "CommCareImage/a": verdict },
				runsOn: ["web-apps", "android"],
			});
			expect(out.findings).toEqual([finding]);
			expect(out.complete).toBe(false);
		}
	});

	it("runs the no-file rule over a missing file's references", () => {
		const media = files(["web-apps"]);
		const out = mediaFindings({
			plan: media,
			verdicts: {
				"CommCareImage/a": { kind: "missing" },
				"CommCareImage/b": { kind: "held", file: judged("png") },
			},
			runsOn: ["web-apps"],
		});
		expect(out.findings).toEqual([
			expect.objectContaining({
				code: "media-file-unreadable",
				place: { kind: "media", path: "jr://file/a.png" },
			}),
		]);
		expect(out.complete).toBe(true);
		// The form icon is absent on HQ's existing download URL. A fresh Android install needs it.
		const android = mediaFindings({
			plan: files(["android"]),
			verdicts: { "CommCareImage/b": { kind: "missing" } },
			runsOn: ["android"],
		});
		expect(android.findings).toEqual([]);
		expect(android.inert).toEqual([
			ref("jr://file/b.png", "image", "tile", FORM),
		]);
		expect(android.claims).toEqual([
			{
				reference: ref("jr://file/b.png", "image", "tile", FORM),
				entry: `${E}a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map`,
				brokenPicture: true,
			},
		]);
		// In Web Apps the same icon showed broken: left out, and said.
		const web = mediaFindings({
			plan: files(["web-apps"]),
			verdicts: { "CommCareImage/b": { kind: "missing" } },
			runsOn: ["web-apps"],
		});
		expect(web.findings).toEqual([]);
		expect(web.claims).toEqual([
			{
				reference: ref("jr://file/b.png", "image", "tile", FORM),
				entry: `${E}a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map`,
				brokenPicture: true,
			},
		]);
	});

	it("requires the download of a registered Android menu sound, independently of the media content check", () => {
		const sound = ref("jr://file/visits.mp3", "audio", "tile", MENU_0);
		const mapped = entry(sound.path, "CommCareAudio", "sound");
		const runsOn = ["android"] as const;
		const required = plan([sound], [mapped], runsOn);
		const missing = mediaFindings({
			plan: required,
			verdicts: { "CommCareAudio/sound": { kind: "missing" } },
			runsOn,
		});
		expect(missing.findings.map((finding) => finding.code)).toEqual([
			"media-file-unreadable",
		]);
		expect(missing.claims).toEqual([]);
		expect(
			mediaFindings({ plan: required, verdicts: {}, runsOn }).complete,
		).toBe(false);
		for (const entries of [[], [entry(sound.path, "CommCareAudio", null)]]) {
			const unregistered = plan([sound], entries, runsOn);
			expect(unregistered.files).toEqual([]);
			expect(unregistered.findings).toEqual([]);
			expect(unregistered.claims.map((claim) => claim.brokenPicture)).toEqual([
				false,
			]);
		}
		// HQ drops an unused mapping from a release's media suite.
		expect(plan([], [mapped], runsOn).files).toEqual([]);
	});

	it("only a video explicitly registered for lazy loading can lack a download at Android install", () => {
		const runsOn = ["android"] as const;
		const video = ref("jr://file/video.mp4", "video", "unheld-itext");
		const audio = ref("jr://file/note.mp3", "audio", "unheld-itext");
		const mappings = [
			entry(video.path, "CommCareVideo", "v"),
			entry(audio.path, "CommCareAudio", "a"),
		];
		const verdicts = {
			"CommCareVideo/v": { kind: "missing" },
			"CommCareAudio/a": { kind: "missing" },
		} as const;
		function judge(lazyLoadVideos: boolean) {
			return mediaFindings({
				plan: plan([video, audio], mappings, runsOn, "yes", lazyLoadVideos),
				verdicts,
				runsOn,
			});
		}
		expect(judge(false).findings.map((finding) => finding.code)).toEqual([
			"media-file-unreadable",
			"media-file-unreadable",
		]);
		const lazy = judge(true);
		expect(lazy.findings.map((finding) => finding.place)).toEqual([
			{ kind: "media", path: audio.path },
		]);
		expect(
			lazy.claims.map((claim) => [claim.reference.path, claim.brokenPicture]),
		).toEqual([[video.path, false]]);
		// A lazy video that a question actually draws still needs its file to play.
		const visible = mediaFindings({
			plan: plan([{ ...video, slot: "form" }], mappings, runsOn, "yes", true),
			verdicts,
			runsOn,
		});
		expect(visible.findings.map((finding) => finding.code)).toEqual([
			"media-file-unreadable",
		]);
	});

	it("answers where every held file plays, and refuses a file only where nothing the app runs on is left", () => {
		const both = files(["web-apps", "android"]);
		const png = mediaFindings({
			plan: both,
			verdicts: { "CommCareImage/a": { kind: "held", file: judged("png") } },
			runsOn: ["web-apps", "android"],
		});
		expect(png.playsOn).toEqual(["web-apps", "android"]);
		const amr = mediaFindings({
			plan: both,
			verdicts: {
				"CommCareImage/a": { kind: "held", file: judged("amr", "audio") },
			},
			runsOn: ["web-apps", "android"],
		});
		expect(amr.playsOn).toEqual(["android"]);
		expect(amr.findings).toEqual([]);
		const webOnly = mediaFindings({
			plan: files(["web-apps"]),
			verdicts: {
				"CommCareImage/a": { kind: "held", file: judged("amr", "audio") },
			},
			runsOn: ["web-apps"],
		});
		/* Where every held file plays is answered of every platform, an app that does not run
		 * there included, so a caller tells a file that does not play there from a platform
		 * nothing offered. */
		expect(webOnly.playsOn).toEqual(["android"]);
		const pngWebOnly = mediaFindings({
			plan: files(["web-apps"]),
			verdicts: { "CommCareImage/a": { kind: "held", file: judged("png") } },
			runsOn: ["web-apps"],
		});
		expect(pngWebOnly.playsOn).toEqual(["web-apps", "android"]);
		expect(pngWebOnly.findings).toEqual([]);
		expect(webOnly.findings).toEqual([
			{
				code: "media-not-played-where-app-runs",
				standing: "fix-in-hq",
				place: { kind: "media", path: "jr://file/a.png" },
				subject: null,
				detail: { name: "jr://file/a.png" },
			},
		]);
	});

	it("reports two findings of different kinds side by side", () => {
		const out = mediaFindings({
			plan: files(["web-apps", "android"]),
			verdicts: {
				"CommCareImage/a": {
					kind: "over-limit",
					mediaKind: "image",
					capBytes: 1,
				},
				"CommCareImage/b": {
					kind: "refused",
					reason: "mime-claim-mismatch",
					sniffedMime: "image/tiff",
				},
			},
			runsOn: ["web-apps", "android"],
		});
		expect(out.findings.map((finding) => finding.code)).toEqual([
			`${E}an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app`,
			`${E}image-tiff-heif`,
		]);
		expect(out.complete).toBe(true);
	});
});
