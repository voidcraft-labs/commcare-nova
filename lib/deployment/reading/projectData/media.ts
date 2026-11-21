/**
 * The media of an app brought in from CommCare HQ: which files the app's
 * source references, what each reference with no file is, what judging each
 * file's bytes found, and what the review, the birth and acceptance are
 * handed of it.
 *
 * Pure: it imports nothing at run time that reaches CommCare HQ, Postgres or
 * the bucket. `mediaStore.ts` beside it fetches, judges and publishes the
 * bytes.
 */

import type { HqMediaMapItem, HqMediaType } from "@/lib/commcare/hq/appSource";
import type {
	ReaderMediaIndex,
	ReaderMediaResolution,
	ReadFacts,
} from "@/lib/commcare/reader";
import { type SourceTable, tableOf } from "@/lib/commcare/sourceKeys";
import type { exportReadinessFindings } from "@/lib/doc/commitVerdicts";
import type { DeclarationChoices } from "@/lib/doc/platformDeclaration";
import {
	ACCEPTED_FORMATS,
	ASSET_SIZE_CAPS_BYTES,
	type AssetKind,
	type AssetMimeType,
	MAX_MEDIA_EXPORT_ASSETS,
	type MediaAssetId,
	type MediaFormatKey,
	type MediaKind,
	mediaFormatPlaysOn,
} from "@/lib/domain/multimedia";
import { PLATFORMS, type Platform } from "@/lib/domain/platforms";
import { NO_ENTRIES, ownRecordValue } from "@/lib/domain/records";
import { log } from "@/lib/logger";
import { exportBudgetExcess } from "@/lib/media/exportBudget";
import type {
	ValidatedMediaMetadata,
	ValidationFailureReason,
} from "@/lib/media/validate";
import {
	circumstanceFinding,
	type Finding,
	type HqPlace,
} from "@/lib/publish/hqFindings";
import type { AdoptedMediaFile } from "../../adoption";
import { provisionalReadingMediaId } from "../mediaIds";
import { manifestFinding } from "./findings";

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

export const HQ_MEDIA_SLOTS = [
	/** A question's label or help media. */
	"form",
	/** A choice's media. Apart from `form` because the Web Apps client never receives it. */
	"choice",
	/** An image column's image in a case list or a case detail. */
	"list-image",
	/** A menu's, a form's or a case list menu item's icon or audio label. */
	"tile",
	/** The Register action's icon or audio label. */
	"register-action",
	/** The Web Apps logo. */
	"logo",
	/** An itext media form on a slot Nova holds no media for: a hint, a validation message, a
	 *  group's or a repeat's label. Never held; listed only for Android's install check. */
	"unheld-itext",
] as const;
export type HqMediaSlot = (typeof HQ_MEDIA_SLOTS)[number];

/** One reference in the app's source. */
export interface HqMediaReference {
	/** The stored app's source pointer when a JSON value names this file. A question's itext is located by its node. */
	readonly pointer?: string;
	/** The path as the source spells it. */
	readonly path: string;
	/** The kind of slot it stands in. */
	readonly kind: MediaKind;
	readonly slot: HqMediaSlot;
	readonly place: HqPlace;
}

/** The reader's slot words (`lib/domain/mediaRefs.ts::MediaRefLocation` kinds, and
 *  `unheld_itext`), each read as the slot it stands in. */
const SLOT_OF_READER_SLOT: SourceTable<HqMediaSlot> = tableOf({
	field_media_bundle: "form",
	option_media: "choice",
	image_map_mapping: "list-image",
	module_icon: "tile",
	module_audio_label: "tile",
	form_icon: "tile",
	form_audio_label: "tile",
	case_list_icon: "tile",
	case_list_audio_label: "tile",
	case_list_registration_icon: "register-action",
	case_list_registration_audio_label: "register-action",
	app_logo: "logo",
	unheld_itext: "unheld-itext",
});

/**
 * Every media reference a reading read, the resolved ones and the ones handed
 * off alike, so a file's every reference is judged whichever way the index
 * answered. Throws on a slot word the table lacks: a carrier the reader learns
 * to read must be judged here before it can pass.
 */
export function hqMediaReferencesOf(
	facts: ReadFacts,
): readonly HqMediaReference[] {
	return [
		...facts.mediaReferences,
		...facts.unheldMedia,
		...facts.pendingMedia,
	].map((read) => {
		const slot = SLOT_OF_READER_SLOT.get(read.slot);
		if (slot === undefined) {
			throw new Error(
				`The reader handed over a media reference in the slot “${read.slot}”, which bringing media in has no rule for. Add the slot to the table in hqMediaReferencesOf, with what each platform draws there, before the reader reads it.`,
			);
		}
		return {
			path: read.path,
			kind: read.mediaKind,
			slot,
			place: read.place,
			...(read.pointer !== undefined && { pointer: read.pointer }),
		};
	});
}

// ---------------------------------------------------------------------------
// Which files
// ---------------------------------------------------------------------------

/** A file of CommCare HQ's that is no picture, sound or video. */
type HqFileMediaType = Exclude<HqMediaType, "CommCareMultimedia">;

const KIND_OF_MEDIA_TYPE: Readonly<Record<HqFileMediaType, MediaKind>> = {
	CommCareImage: "image",
	CommCareAudio: "audio",
	CommCareVideo: "video",
};

interface FileUse {
	/** Only source itext that no runtime draws names this file. Test its availability, without adopting its bytes. */
	readonly availabilityOnly?: true;
}

/** A single source or a pair of HQ reads takes at most as many distinct file requests as a full export. */
export function mediaReadLimit(files: readonly FileUse[]): Finding | null {
	if (files.length <= MAX_MEDIA_EXPORT_ASSETS) return null;
	return circumstanceFinding("too-large", { kind: "app" }, {});
}

function fileCountLimit(files: readonly FileUse[]): Finding | null {
	if (files.length <= MAX_MEDIA_EXPORT_ASSETS) return null;
	const count = files.filter((file) => !file.availabilityOnly).length;
	return count > MAX_MEDIA_EXPORT_ASSETS
		? fileCountFinding(count)
		: mediaReadLimit(files);
}

export interface HqMediaFile extends FileUse {
	/** `<mediaType>/<multimediaId>`: the key a verdict is filed under. */
	readonly key: string;
	readonly mediaType: HqFileMediaType;
	readonly multimediaId: string;
	/** The kind Nova fetches it as: Image, Audio or Video by `mediaType`. */
	readonly kind: MediaKind;
	/** Paths a held slot names it by, or its source-only paths when there is no held slot. In code-unit order. */
	readonly paths: readonly string[];
	/** All source references, including those that only check this file's availability. Never empty. */
	readonly references: readonly HqMediaReference[];
}

/** A reference with no file that is left out, and the entry it stands under in the claim
 *  log. */
export interface HqMediaClaim {
	readonly reference: HqMediaReference;
	readonly entry: string;
	/**
	 * An omitted icon with a worker-facing change: Web Apps showed a broken
	 * picture, or Android had to download a file HQ no longer serves.
	 */
	readonly brokenPicture: boolean;
}

/** How many references with no file a plan leaves out, by what a worker met before. */
export interface MediaLeftOut {
	/** References no worker sees anything for. */
	readonly undrawn: number;
	/** Omitted icons whose broken picture or required download affected workers. */
	readonly brokenPictures: number;
}

/** What `claims` leaves out, counted by `MediaLeftOut`. */
export function mediaLeftOutOf(claims: readonly HqMediaClaim[]): MediaLeftOut {
	const brokenPictures = claims.filter((claim) => claim.brokenPicture).length;
	return { undrawn: claims.length - brokenPictures, brokenPictures };
}

export interface HqMediaPlan {
	readonly files: readonly HqMediaFile[];
	/** Findings known from the source alone. */
	readonly findings: readonly Finding[];
	/** References with no file Nova leaves out: those nothing draws, and the icons Web Apps
	 *  shows as a broken picture. */
	readonly inert: readonly HqMediaReference[];
	/** The manifest entry each reference with no asset stands under, for the claim log (the
	 *  surface key is `schema:Application.multimedia_map`). */
	readonly claims: readonly HqMediaClaim[];
	/** The input's three values, kept because the rule for a reference with no file is run
	 *  again for a file whose verdict is `missing`. */
	readonly references: readonly HqMediaReference[];
	readonly runsOn: readonly Platform[];
	readonly contentValid: string | null;
	/** HQ defers only videos, and only when the source explicitly selects lazy loading. */
	readonly lazyLoadVideos: boolean;
}

const JR_FILE = "jr://file/";

const ENTRY = {
	keyOutsideJrFile:
		"expressions-and-data/multimedia-map-key-not-under-jr-file-that-the-build-keeps",
	audioFiledAsVideo:
		"expressions-and-data/audio-m4a-with-another-brand-isom-mp41-mp42-dash",
	overLimit:
		"expressions-and-data/an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app",
	androidInstall:
		"expressions-and-data/a-media-reference-with-no-file-on-a-slot-android-s-install",
	runtimeDraws:
		"expressions-and-data/a-media-reference-with-no-file-on-a-slot-a-runtime-draws",
	nothingDraws:
		"expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map",
	svg: "expressions-and-data/image-svg",
	tiffHeif: "expressions-and-data/image-tiff-heif",
	otherWav: "expressions-and-data/audio-wav-that-is-not-8-or-16-bit-pcm",
	audio3gp: "expressions-and-data/audio-3gp",
	video: "expressions-and-data/video-av1-mov-avi-ogg-theora-h-263-3gp",
} as const;

/**
 * The files the app's references name, and what the source alone says of the
 * references: a map key outside `jr://file/`, a reference with no entry or no
 * file, an entry of a type no slot can play, a sound slot naming a file CommCare
 * HQ filed as video, and an app with more files than Nova takes.
 */
/** The most cases one tallied log line names beside its count. */
const LOGGED_SAMPLES = 5;

/**
 * One log line per message for a loop over what CommCare HQ sent, written
 * after the loop with the count of its cases and the first few: the loop's
 * length is an app author's, and each error-level line is a Sentry event.
 */
function loggedOnce(): {
	readonly add: (message: string, sample: Record<string, unknown>) => void;
	readonly flush: () => void;
} {
	const lines = new Map<
		string,
		{ count: number; readonly samples: Record<string, unknown>[] }
	>();
	return {
		add(message, sample) {
			const line = lines.get(message) ?? { count: 0, samples: [] };
			line.count += 1;
			if (line.samples.length < LOGGED_SAMPLES) line.samples.push(sample);
			lines.set(message, line);
		},
		flush() {
			for (const [message, { count, samples }] of lines)
				log.error(message, undefined, { count, samples });
		},
	};
}

export function planHqMedia(input: {
	readonly references: readonly HqMediaReference[];
	/** Published Nova assets take no HQ file read. Their slots still belong to the app Android verifies. */
	readonly ownPaths?: ReadonlySet<string>;
	readonly multimediaMap: readonly HqMediaMapItem[];
	/** The platforms of the declaration the draft proposes: what the app runs on. */
	readonly runsOn: readonly Platform[];
	/** `profile.properties["cc-content-valid"]` as the source holds it, or null. */
	readonly contentValid: string | null;
	/** HQ defers only videos, and only when the source explicitly selects lazy loading. */
	readonly lazyLoadVideos: boolean;
}): HqMediaPlan {
	const { references, runsOn, contentValid } = input;
	const byPath = new Map(input.multimediaMap.map((item) => [item.path, item]));
	const findings: Finding[] = [];
	const inert: HqMediaReference[] = [];
	const claims: HqMediaClaim[] = [];
	const logged = loggedOnce();
	const files = new Map<
		string,
		{
			readonly mediaType: HqFileMediaType;
			readonly multimediaId: string;
			readonly references: HqMediaReference[];
		}
	>();
	const noFile = (reference: HqMediaReference, missing: MissingFile) => {
		const outcome = noFileOutcome(
			reference,
			missing,
			references,
			runsOn,
			contentValid,
			false,
		);
		if (outcome.kind === "finding") findings.push(outcome.finding);
		else {
			inert.push(reference);
			claims.push(outcome.claim);
		}
	};
	for (const reference of references) {
		if (input.ownPaths?.has(reference.path)) continue;
		const item = byPath.get(reference.path);
		if (item !== undefined && !reference.path.startsWith(JR_FILE)) {
			findings.push(
				manifestFinding(
					ENTRY.keyOutsideJrFile,
					{ kind: "media", path: reference.path },
					reference.path,
				),
			);
			continue;
		}
		if (item === undefined) {
			noFile(reference, "no-entry");
			continue;
		}
		if (
			item.unreadable ||
			item.multimediaId === null ||
			item.mediaType === null
		) {
			noFile(reference, "no-file");
			continue;
		}
		if (item.mediaType === "CommCareMultimedia") {
			logged.add(
				"[bring-in:media] media slots name a file CommCare HQ files as neither a picture, a sound nor a video",
				{ slot: reference.slot, kind: reference.kind },
			);
			findings.push(
				circumstanceFinding("unrecognized", reference.place, {
					name: reference.path,
				}),
			);
			continue;
		}
		const fileKind = KIND_OF_MEDIA_TYPE[item.mediaType];
		if (reference.slot !== "unheld-itext" && fileKind !== reference.kind) {
			if (reference.kind === "audio" && item.mediaType === "CommCareVideo") {
				findings.push(
					manifestFinding(
						ENTRY.audioFiledAsVideo,
						reference.place,
						reference.path,
					),
				);
				continue;
			}
			logged.add("[bring-in:media] media slots name a file of another kind", {
				slot: reference.slot,
				kind: reference.kind,
				mediaType: item.mediaType,
			});
			findings.push(
				circumstanceFinding("unrecognized", reference.place, {
					name: `${reference.path} (${reference.kind} slot, ${item.mediaType})`,
				}),
			);
			continue;
		}
		const key = mediaFileKey(item.mediaType, item.multimediaId);
		let file = files.get(key);
		if (file === undefined) {
			file = {
				mediaType: item.mediaType,
				multimediaId: item.multimediaId,
				references: [],
			};
			files.set(key, file);
		}
		file.references.push(reference);
	}
	logged.flush();
	const planned: HqMediaFile[] = [...files.entries()]
		.sort(([a], [b]) => compareCodeUnits(a, b))
		.map(([key, file]) => {
			const adopted = file.references.filter(
				(ref) => ref.slot !== "unheld-itext",
			);
			const paths = (adopted.length ? adopted : file.references).map(
				(ref) => ref.path,
			);
			return {
				...(adopted.length === 0 && { availabilityOnly: true as const }),
				key,
				mediaType: file.mediaType,
				multimediaId: file.multimediaId,
				kind: KIND_OF_MEDIA_TYPE[file.mediaType],
				paths: [...new Set(paths)].sort(compareCodeUnits),
				references: file.references,
			};
		});
	const countLimit = fileCountLimit(planned);
	if (countLimit) findings.push(countLimit);
	return {
		files: planned,
		findings: distinct(findings),
		inert,
		claims,
		references,
		runsOn,
		contentValid,
		lazyLoadVideos: input.lazyLoadVideos,
	};
}

function mediaFileKey(mediaType: HqMediaType, multimediaId: string): string {
	return `${mediaType}/${multimediaId}`;
}

// ---------------------------------------------------------------------------
// A reference with no file
// ---------------------------------------------------------------------------

/** No entry: the path is in no `multimedia_map` entry. No file: the entry names no file, or
 *  one CommCare HQ does not serve. */
type MissingFile = "no-entry" | "no-file";

/**
 * Whether an already running app draws something for a missing file of this kind in
 * this slot. Downloading a release's required resources precedes these screens. Android draws the missing-file prompt, an audio button or the archive
 * icon for a question's or a choice's media and a list's image, and nothing
 * for a menu's, a form's, a case list menu item's or the Register action's
 * icon or audio, the logo or an itext form no slot holds. Web Apps never
 * receives a choice's media; it builds an address from any entry, so a
 * picture with an entry and no file shows broken; and with no entry it shows
 * a question's audio or video player, and a list's image cell as a broken
 * picture: the cell's `<img>` has no address and, as its alternative text,
 * the no-break space CommCare HQ's build writes for a value that names a
 * picture (`case_list/item.html`, `commcare_translations.py::dumps`), which
 * the browser draws its stand-in for. It shows nothing else with no entry.
 */
export function mediaSlotDrawnOn(
	slot: HqMediaSlot,
	kind: MediaKind,
	platform: Platform,
	missing: MissingFile,
): boolean {
	if (platform === "android")
		return slot === "form" || slot === "choice" || slot === "list-image";
	if (slot === "choice" || slot === "unheld-itext") return false;
	if (missing === "no-file" || slot === "list-image") return true;
	return slot === "form" && (kind === "audio" || kind === "video");
}

/**
 * Whether Android's install check reaches the reference: every itext media
 * form; a form's or a case list menu item's audio, and its icon where the same
 * carrier also carries audio; and a menu's only where every form, every case
 * list menu item and every earlier menu carries both, then its audio, and its
 * icon where that menu also carries audio.
 *
 * A carrier with no reference at all is not in `all`, so the menu rule is
 * judged over the carriers the app's references name: a form with no media
 * stops the real check before any menu, and is not seen here, which can only
 * make a menu's reference reached where the device would not reach it.
 */
export function androidInstallCheckReaches(
	reference: HqMediaReference,
	all: readonly HqMediaReference[],
): boolean {
	if (
		reference.slot === "form" ||
		reference.slot === "choice" ||
		reference.slot === "unheld-itext"
	)
		return true;
	if (reference.slot !== "tile") return false;
	const carrier = tileCarrier(reference.place);
	if (carrier === null) return false;
	const tiles = all.filter((each) => each.slot === "tile");
	const carries = (key: string, kind: "image" | "audio") =>
		tiles.some(
			(each) => each.kind === kind && tileCarrier(each.place)?.key === key,
		);
	const ownReached =
		reference.kind === "audio" ||
		(reference.kind === "image" && carries(carrier.key, "audio"));
	if (carrier.kind === "entry") return ownReached;
	const carriesBoth = (key: string) =>
		carries(key, "image") && carries(key, "audio");
	const entries = new Set<string>();
	const earlierMenus = new Set<string>();
	for (const tile of tiles) {
		const other = tileCarrier(tile.place);
		if (other === null) continue;
		if (other.kind === "entry") entries.add(other.key);
		else if (other.menu < carrier.menu) earlierMenus.add(other.key);
	}
	return [...entries, ...earlierMenus].every(carriesBoth) && ownReached;
}

/** The carrier of a tile: a suite entry (a form, or a case list menu item) or a menu. */
function tileCarrier(
	place: HqPlace,
):
	| { readonly kind: "entry"; readonly key: string }
	| { readonly kind: "menu"; readonly key: string; readonly menu: number }
	| null {
	switch (place.kind) {
		case "form":
			return { kind: "entry", key: `form/${place.menu}/${place.form}` };
		case "case-list":
			return { kind: "entry", key: `case-list/${place.menu}` };
		case "menu":
			return { kind: "menu", key: `menu/${place.menu}`, menu: place.menu };
		default:
			return null;
	}
}

type NoFileOutcome =
	| { readonly kind: "finding"; readonly finding: Finding }
	| { readonly kind: "inert"; readonly claim: HqMediaClaim };

/** The icon slots the reading can omit and disclose. Web Apps can show a broken picture.
 * A media-suite resource can stop a fresh Android installation before a menu is shown. */
const BROKEN_PICTURE_SLOTS: ReadonlySet<HqMediaSlot> = new Set([
	"tile",
	"register-action",
	"logo",
]);

/**
 * A reference with no entry or no file, by the first rule that matches: one
 * Android's content verification reaches stops the reading. An icon missing
 * from the worker's Web Apps screen or required Android downloads is omitted
 * and disclosed. Other missing files that a runtime draws or needs to install
 * are the source's to fix. An incomplete map entry has no verified download.
 */
function noFileOutcome(
	reference: HqMediaReference,
	missing: MissingFile,
	all: readonly HqMediaReference[],
	runsOn: readonly Platform[],
	contentValid: string | null,
	requiredDownload: boolean,
): NoFileOutcome {
	if (
		runsOn.includes("android") &&
		contentValid !== "yes" &&
		androidInstallCheckReaches(reference, all)
	) {
		return {
			kind: "finding",
			finding: manifestFinding(
				ENTRY.androidInstall,
				reference.place,
				reference.path,
			),
		};
	}
	const drawn = runsOn.some((platform) =>
		mediaSlotDrawnOn(reference.slot, reference.kind, platform, missing),
	);
	if (
		(drawn || requiredDownload) &&
		missing === "no-file" &&
		reference.kind === "image" &&
		BROKEN_PICTURE_SLOTS.has(reference.slot)
	)
		return {
			kind: "inert",
			claim: { reference, entry: ENTRY.nothingDraws, brokenPicture: true },
		};
	if (drawn || requiredDownload) {
		return {
			kind: "finding",
			finding:
				missing === "no-entry"
					? manifestFinding(ENTRY.runtimeDraws, reference.place, reference.path)
					: circumstanceFinding(
							"media-file-unreadable",
							{ kind: "media", path: reference.path },
							{ name: reference.path },
						),
		};
	}
	return {
		kind: "inert",
		claim: { reference, entry: ENTRY.nothingDraws, brokenPicture: false },
	};
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** What judging a file's bytes found. */
export interface JudgedMediaFile {
	readonly contentHash: string;
	readonly mimeType: AssetMimeType;
	readonly extension: string;
	readonly kind: MediaKind;
	readonly sizeBytes: number;
	readonly mediaFormat: MediaFormatKey;
	readonly dimensions?: { readonly width: number; readonly height: number };
	readonly durationMs?: number;
	/** The name Files shows for it. */
	readonly originalFilename: string;
}

export type HqMediaVerdict =
	| { readonly kind: "held"; readonly file: JudgedMediaFile }
	| { readonly kind: "available" }
	| { readonly kind: "missing" }
	| {
			readonly kind: "over-limit";
			readonly mediaKind: MediaKind;
			readonly capBytes: number;
	  }
	| {
			readonly kind: "refused";
			readonly reason: ValidationFailureReason;
			readonly sniffedMime: string | null;
	  }
	| { readonly kind: "wrong-kind"; readonly sniffedKind: AssetKind };

/**
 * The held facts of a file whose bytes the gate admitted as its own kind, named
 * as its author named it in CommCare HQ: the last segment of the file's first
 * path, with the format's extension added where the segment does not already
 * end in one the format declares.
 */
export function judgedMediaFile(
	paths: readonly string[],
	kind: MediaKind,
	validated: ValidatedMediaMetadata,
): JudgedMediaFile {
	if (validated.mediaFormat === undefined) {
		throw new Error(
			`The gate admitted a ${validated.kind} file with no media format, which it gives every picture, sound and video it admits. Bringing media in reads the format to say where the file plays.`,
		);
	}
	const first = paths[0] ?? "";
	const segment = first.slice(first.lastIndexOf("/") + 1) || "file";
	const declared =
		ACCEPTED_FORMATS.find((format) => format.mime === validated.mimeType)
			?.declaredExtensions ?? [];
	const lower = segment.toLowerCase();
	const named = declared.some((extension) => lower.endsWith(extension))
		? segment
		: `${segment}${validated.extension}`;
	return {
		contentHash: validated.contentHash,
		mimeType: validated.mimeType,
		extension: validated.extension,
		kind,
		sizeBytes: validated.sizeBytes,
		mediaFormat: validated.mediaFormat,
		...(validated.dimensions === undefined
			? {}
			: { dimensions: validated.dimensions }),
		...(validated.durationMs === undefined
			? {}
			: { durationMs: validated.durationMs }),
		originalFilename: named,
	};
}

/**
 * The manifest entry a refused format stands under, by the type the bytes
 * sniffed as (a substring of its subtype, since `file-type` has spelled
 * several of these two ways) and the gate's reason, first match. Null for a
 * format no entry names, which is Nova's to classify.
 */
export function hqMediaRefusalEntry(
	sniffedMime: string | null,
	reason: ValidationFailureReason,
	mediaType: HqMediaFile["mediaType"],
): string | null {
	const type = (sniffedMime ?? "").toLowerCase();
	const subtype = type.slice(type.indexOf("/") + 1);
	const video = type.startsWith("video/");
	if (reason === "svg-not-accepted" || subtype.includes("svg"))
		return ENTRY.svg;
	if (
		subtype.includes("tiff") ||
		subtype.includes("heic") ||
		subtype.includes("heif") ||
		(subtype === "avif" && reason === "image-parse-failed")
	)
		return ENTRY.tiffHeif;
	if (subtype.includes("wav")) return ENTRY.otherWav;
	if (reason === "container-brand-not-accepted") return ENTRY.audioFiledAsVideo;
	if (subtype.includes("3gpp") && mediaType === "CommCareAudio")
		return ENTRY.audio3gp;
	if (
		subtype.includes("3gpp") ||
		subtype.includes("quicktime") ||
		subtype.includes("avi") ||
		subtype.includes("msvideo") ||
		(video && subtype.includes("ogg")) ||
		(video &&
			(reason === "codec-not-accepted" || reason === "media-parse-failed"))
	)
		return ENTRY.video;
	return null;
}

const KIND_NOUN: Readonly<Record<MediaKind, string>> = {
	image: "a picture",
	audio: "a sound",
	video: "a video",
};

/** What the verdicts of a plan's files found. */
export interface MediaVerdictFindings {
	readonly findings: readonly Finding[];
	/** Every platform each held file plays on, whether or not `runsOn` offers it, so a caller
	 *  tells "a held file does not play there" from "the app does not run there". (Answered over
	 *  every platform by the bring-in layer, which reads it for the platforms it leaves out.) */
	readonly playsOn: readonly Platform[];
	/** True when every file of the plan has a verdict. */
	readonly complete: boolean;
	/** References of a `missing` file that nothing the app runs on draws: left out, as the
	 *  source's references with no file are (`HqMediaPlan.inert`). */
	readonly inert: readonly HqMediaReference[];
	/** The entry each of `inert` stands under, as `HqMediaPlan.claims`. */
	readonly claims: readonly HqMediaClaim[];
}

/**
 * The findings of judged files: a file over its kind's cap, a format the
 * manifest refuses (or one no entry names), bytes of another kind than the
 * entry says, each reference of a file CommCare HQ does not serve, and a held
 * file that plays where the rest of the app cannot run.
 */
export function mediaFindings(input: {
	readonly plan: HqMediaPlan;
	readonly verdicts: Readonly<Record<string, HqMediaVerdict>>;
	/** Every platform some declaration choice of the draft declares: what the rest of the
	 *  app can run on. Not `plan.runsOn`, which is the one proposed choice's. */
	readonly runsOn: readonly Platform[];
}): MediaVerdictFindings {
	const { plan, verdicts, runsOn } = input;
	const held = plan.files.flatMap((file) => {
		const verdict = verdictOf(verdicts, file.key);
		return verdict?.kind === "held" ? [verdict.file] : [];
	});
	const playsOn = PLATFORMS.filter((platform) =>
		held.every((file) =>
			mediaFormatPlaysOn(file.mediaFormat).includes(platform),
		),
	);
	const findings: Finding[] = [];
	const inert: HqMediaReference[] = [];
	const claims: HqMediaClaim[] = [];
	const logged = loggedOnce();
	for (const file of plan.files) {
		const verdict = verdictOf(verdicts, file.key);
		if (verdict === undefined) continue;
		const path = file.paths[0] as string;
		const place: HqPlace = { kind: "media", path };
		switch (verdict.kind) {
			case "over-limit":
				findings.push(
					manifestFinding(
						ENTRY.overLimit,
						place,
						`${path} (over ${Math.round(verdict.capBytes / 1024 / 1024)} MB, the most Nova takes for ${KIND_NOUN[verdict.mediaKind]})`,
					),
				);
				break;
			case "refused": {
				const entry = hqMediaRefusalEntry(
					verdict.sniffedMime,
					verdict.reason,
					file.mediaType,
				);
				if (entry !== null) {
					findings.push(manifestFinding(entry, place, path));
					break;
				}
				logged.add(
					"[bring-in:media] media files were refused for a format no manifest entry names",
					{
						reason: verdict.reason,
						sniffedMime: verdict.sniffedMime ?? "none",
						mediaType: file.mediaType,
					},
				);
				findings.push(
					circumstanceFinding("unrecognized", place, { name: path }),
				);
				break;
			}
			case "wrong-kind":
				logged.add(
					"[bring-in:media] media files' bytes are another kind than CommCare HQ files them as",
					{ sniffedKind: verdict.sniffedKind, mediaType: file.mediaType },
				);
				findings.push(
					circumstanceFinding("unrecognized", place, { name: path }),
				);
				break;
			case "missing":
				for (const reference of file.references) {
					const outcome = noFileOutcome(
						reference,
						"no-file",
						plan.references,
						plan.runsOn,
						plan.contentValid,
						// HQ's media suite registers each used mapping as a download. Only
						// videos can be lazy (MediaSuiteGenerator.media_resources). This
						// verdict comes from HQ's 404 at the mapped class and id.
						plan.runsOn.includes("android") &&
							!(file.mediaType === "CommCareVideo" && plan.lazyLoadVideos),
					);
					if (outcome.kind === "finding") findings.push(outcome.finding);
					else {
						inert.push(reference);
						claims.push(outcome.claim);
					}
				}
				break;
			case "available":
				break;
			case "held":
				if (
					!runsOn.some((platform) => playsOn.includes(platform)) &&
					!runsOn.every((platform) =>
						mediaFormatPlaysOn(verdict.file.mediaFormat).includes(platform),
					)
				)
					findings.push(
						circumstanceFinding("media-not-played-where-app-runs", place, {
							name: path,
						}),
					);
				break;
		}
	}
	logged.flush();
	return {
		findings: distinct(findings),
		playsOn,
		complete: plan.files.every(
			(file) => verdictOf(verdicts, file.key) !== undefined,
		),
		inert,
		claims,
	};
}

function verdictOf(
	verdicts: Readonly<Record<string, HqMediaVerdict>>,
	key: string,
): HqMediaVerdict | undefined {
	return ownRecordValue(verdicts, key);
}

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

function fileCountFinding(count: number): Finding {
	return manifestFinding(
		ENTRY.overLimit,
		{ kind: "app" },
		`${count} media files (Nova takes ${MAX_MEDIA_EXPORT_ASSETS} in one app)`,
	);
}

/**
 * The app over Nova's media budget: more files than Nova takes, known from the
 * source, or the files held so far, one per distinct content, past the bytes
 * Nova takes. Null where neither.
 */
export function mediaBudgetFinding(
	plan: { readonly files: readonly (FileUse & { readonly key: string })[] },
	verdicts: Readonly<Record<string, HqMediaVerdict>>,
): Finding | null {
	const countLimit = fileCountLimit(plan.files);
	if (countLimit) return countLimit;
	const rows = new Map<
		string,
		{
			readonly status: "ready";
			readonly kind: MediaKind;
			readonly sizeBytes: number;
		}
	>();
	for (const file of plan.files) {
		const verdict = verdictOf(verdicts, file.key);
		if (verdict?.kind !== "held") continue;
		rows.set(verdict.file.contentHash, {
			status: "ready",
			kind: verdict.file.kind,
			sizeBytes: verdict.file.sizeBytes,
		});
	}
	const excess = exportBudgetExcess([...rows.values()]);
	return excess === null
		? null
		: manifestFinding(
				ENTRY.overLimit,
				{ kind: "app" },
				excess.reasons.join(" and "),
			);
}

/** The most bytes of a file of each kind Nova reads. */
export function mediaCapBytes(kind: MediaKind): number {
	return ASSET_SIZE_CAPS_BYTES[kind];
}

// ---------------------------------------------------------------------------
// The media of one request
// ---------------------------------------------------------------------------

/** The media of one request. Never stored. */
export interface ReadingMediaPlan {
	/** One per referenced HQ file the reading must check, in `key` order. */
	readonly files: readonly (FileUse & {
		readonly key: string;
		readonly mediaType: HqMediaFile["mediaType"];
		readonly multimediaId: string;
		readonly kind: MediaKind;
		readonly paths: readonly string[];
		/** `provisionalReadingMediaId(appId, mediaType, multimediaId)`: the id the document names
		 *  the file by until the file is published. It never reaches storage. */
		readonly provisionalId: MediaAssetId;
	})[];
	readonly verdicts: Readonly<Record<string, HqMediaVerdict>>;
	/** In a create: the bytes of each held file, by its content hash (a held verdict's
	 *  `file.contentHash`), one buffer however many files hold those bytes, from the verdict
	 *  to the publication. What the media budget counts is exactly what this holds. */
	readonly kept: ReadonlyMap<string, Buffer>;
	/** In a create, after the publish: the asset each held file became, by file key. */
	readonly published: Readonly<Record<string, MediaAssetId>>;
}

/**
 * The reader's media index over the source's map: a path with no entry is
 * `no-entry`; an entry naming no file Nova can ask for, an entry of a type no
 * slot plays, and a file judged `missing` are `unreadable`; any other entry is
 * an asset, named by its published asset where the plan holds one and by its
 * provisional id otherwise. With no plan, every mapped file is named by its
 * provisional id: the reader's first run, before any byte is fetched.
 */
export function readingMediaIndex(input: {
	readonly source: { readonly multimediaMap: readonly HqMediaMapItem[] | null };
	readonly appId: string;
	readonly plan: ReadingMediaPlan | null;
}): ReaderMediaIndex {
	const { appId, plan } = input;
	const byPath = new Map(
		(input.source.multimediaMap ?? []).map((item) => [item.path, item]),
	);
	return {
		resolve(path: string): ReaderMediaResolution {
			const item = byPath.get(path);
			if (item === undefined) return { kind: "no-entry" };
			if (
				item.unreadable ||
				item.multimediaId === null ||
				item.mediaType === null ||
				item.mediaType === "CommCareMultimedia"
			)
				return { kind: "unreadable" };
			const key = mediaFileKey(item.mediaType, item.multimediaId);
			if (plan !== null && verdictOf(plan.verdicts, key)?.kind === "missing")
				return { kind: "unreadable" };
			const published =
				plan === null ? undefined : ownRecordValue(plan.published, key);
			return {
				kind: "asset",
				assetId:
					published ??
					provisionalReadingMediaId(appId, item.mediaType, item.multimediaId),
				mediaKind: KIND_OF_MEDIA_TYPE[item.mediaType],
			};
		},
	};
}

/**
 * `planHqMedia` over the reader's references and the source's map, and one plan
 * file per file it names, with its provisional id, no verdict, nothing kept and
 * nothing published.
 */
export function planReadingMedia(input: {
	readonly source: {
		readonly multimediaMap: readonly HqMediaMapItem[] | null;
		readonly profile: {
			readonly properties?: Readonly<Record<string, unknown>>;
		};
	};
	readonly appId: string;
	readonly references: readonly HqMediaReference[];
	/** Published Nova assets take no HQ file read. Their slots still belong to the app Android verifies. */
	readonly ownPaths?: ReadonlySet<string>;
	/** The platforms of the declaration the draft proposes (`planHqMedia`'s `runsOn`). */
	readonly runsOn: readonly Platform[];
}): { readonly plan: ReadingMediaPlan; readonly media: HqMediaPlan } {
	const contentValid = input.source.profile.properties?.["cc-content-valid"];
	const media = planHqMedia({
		references: input.references,
		ownPaths: input.ownPaths,
		multimediaMap: input.source.multimediaMap ?? [],
		runsOn: input.runsOn,
		contentValid: typeof contentValid === "string" ? contentValid : null,
		lazyLoadVideos:
			input.source.profile.properties?.["lazy-load-video-files"] === "true",
	});
	return {
		media,
		plan: {
			files: media.files.map((file) => ({
				...(file.availabilityOnly && { availabilityOnly: true as const }),
				key: file.key,
				mediaType: file.mediaType,
				multimediaId: file.multimediaId,
				kind: file.kind,
				paths: file.paths,
				provisionalId: provisionalReadingMediaId(
					input.appId,
					file.mediaType,
					file.multimediaId,
				),
			})),
			verdicts: NO_ENTRIES,
			kept: new Map(),
			published: NO_ENTRIES,
		},
	};
}

/**
 * Every finding of this request's media: what the source says, then what the
 * verdicts say, then the budget. `complete` is false until every file has a
 * verdict, which a request that stopped at the budget never reaches.
 */
export function readingMediaFindings(input: {
	readonly media: HqMediaPlan;
	readonly plan: ReadingMediaPlan;
	/** Every platform some declaration choice of the draft declares (`mediaFindings`'
	 *  `runsOn`). */
	readonly runsOn: readonly Platform[];
}): MediaVerdictFindings {
	const judged = mediaFindings({
		plan: input.media,
		verdicts: input.plan.verdicts,
		runsOn: input.runsOn,
	});
	// More files than Nova takes is known from the source, so `media.findings` holds it already.
	const budget =
		input.media.files.length > MAX_MEDIA_EXPORT_ASSETS
			? null
			: mediaBudgetFinding(input.media, input.plan.verdicts);
	return {
		...judged,
		findings: distinct([
			...input.media.findings,
			...judged.findings,
			...(budget === null ? [] : [budget]),
		]),
	};
}

/** The asset id the document names a plan file by: its published asset, else its provisional
 *  id. */
function documentAssetId(
	plan: ReadingMediaPlan,
	file: ReadingMediaPlan["files"][number],
): MediaAssetId {
	return ownRecordValue(plan.published, file.key) ?? file.provisionalId;
}

/** One adopted file per path of each held file, with CommCare HQ's path as the source spells
 *  it. */
export function adoptedMediaFiles(
	plan: ReadingMediaPlan,
): readonly AdoptedMediaFile[] {
	return plan.files.flatMap((file) => {
		const verdict = verdictOf(plan.verdicts, file.key);
		if (verdict?.kind !== "held") return [];
		const assetId = documentAssetId(plan, file);
		return file.paths.map((hqPath) => ({
			hqPath,
			assetId,
			contentHash: verdict.file.contentHash,
			extension: verdict.file.extension,
		}));
	});
}

/**
 * The declarations the review offers, narrowed to where every held file plays:
 * a choice that declares a platform outside `playsOn` leaves, and the proposal
 * stays on its choice, or moves to the first choice left. Where none is left
 * the answer is `none`, which only a reading with `media-not-played-where-app-runs`
 * reaches.
 */
export function narrowDeclarationsByMedia(
	choices: DeclarationChoices,
	playsOn: readonly Platform[],
): DeclarationChoices {
	if (choices.kind === "none") return choices;
	const declares = (runsOnlyOn: Platform | undefined): readonly Platform[] =>
		runsOnlyOn === undefined ? ["web-apps", "android"] : [runsOnlyOn];
	const left = choices.choices
		.map((choice, index) => ({ choice, index }))
		.filter(({ choice }) =>
			declares(choice.runsOnlyOn).every((platform) =>
				playsOn.includes(platform),
			),
		);
	if (left.length === 0) return { kind: "none", blocking: [] };
	const stays = left.findIndex(({ index }) => index === choices.proposed);
	return {
		kind: "choices",
		choices: left.map(({ choice }) => choice),
		proposed: stays === -1 ? 0 : stays,
		narrowedByHq: choices.narrowedByHq,
		keepsWebApps: choices.keepsWebApps,
	};
}

/**
 * The media rows export readiness takes, from the held files' verdicts: one
 * `ready` record per held file under the id the document names it by. The
 * plan names no Project and no time, so those fields are empty and the epoch:
 * the gate's media rules read `status`, `kind`, `mimeType`, `mediaFormat` and
 * `sizeBytes` alone.
 */
export function readingMediaRows(
	plan: ReadingMediaPlan,
): ReadonlyMap<string, MediaRow> {
	const rows = new Map<string, MediaRow>();
	for (const file of plan.files) {
		const verdict = verdictOf(plan.verdicts, file.key);
		if (verdict?.kind !== "held") continue;
		const id = documentAssetId(plan, file);
		const judged = verdict.file;
		rows.set(id, {
			id,
			project_id: "",
			owner: "",
			contentHash: judged.contentHash,
			mimeType: judged.mimeType,
			extension: judged.extension,
			sizeBytes: judged.sizeBytes,
			...(judged.dimensions === undefined
				? {}
				: { dimensions: { ...judged.dimensions } }),
			...(judged.durationMs === undefined
				? {}
				: { durationMs: judged.durationMs }),
			mediaFormat: judged.mediaFormat,
			kind: judged.kind,
			gcsObjectKey: "",
			originalFilename: judged.originalFilename,
			status: "ready",
			created_at: new Date(0),
		});
	}
	return rows;
}

type MediaRow =
	NonNullable<
		Parameters<typeof exportReadinessFindings>[2]
	> extends ReadonlyMap<string, infer Row>
		? Row
		: never;

// ---------------------------------------------------------------------------

function compareCodeUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The findings with each repeat of an equal finding left out, in first-seen order. */
function distinct(findings: readonly Finding[]): Finding[] {
	const seen = new Set<string>();
	return findings.filter((finding) => {
		const key = JSON.stringify([finding.code, finding.place, finding.detail]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
