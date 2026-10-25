/**
 * Where a media file plays, judged against the platforms an app runs on.
 *
 * A file's variant is a fact of its bytes, stored once on its row
 * (`media_assets.media_format`); whether a reference to it is accepted is a
 * fact of each reference, because two apps of one Project may run on
 * different platforms. This module is the one rule every judgment reads: the
 * commit kernel's media admission, the attach verdicts, the export boundary,
 * the builder's guard and pickers, Preview's stand-in, and the platform
 * change's preflight. It imports only `lib/domain`, so the builder reads it
 * in the browser.
 *
 * A ready media row with no format (one the platforms cutover's backfill has
 * not reached) reads as `unplayable` in every judgment of one row, as the
 * kernel reads NULL, so no earlier check admits what the kernel refuses.
 */

import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { isBuiltinIconRef } from "@/lib/domain/builtinIcons";
import {
	type AssetRef,
	describeCarrier,
	walkAuthoredAssetRefs,
} from "@/lib/domain/mediaRefs";
import {
	type AssetKind,
	acceptedFormatFor,
	isMediaKind,
	MEDIA_FORMATS,
	type MediaFormatValue,
	type MediaKind,
	mediaFormatLabel,
	mediaFormatPlaysOn,
	UNPLAYABLE_MEDIA_FORMAT,
} from "@/lib/domain/multimedia";
import {
	inPlatform,
	PLATFORM_LABELS,
	PLATFORMS,
	type Platform,
	platformDeclarationPhrase,
} from "@/lib/domain/platforms";

/** One authored reference whose file a declared platform cannot play. */
export interface UnplayableReference {
	readonly ref: AssetRef;
	readonly mediaFormat: MediaFormatValue;
	/** `mediaFormatLabel` of the file. */
	readonly label: string;
	/** The declared platforms that cannot play it; all of them for `unplayable`. */
	readonly missing: readonly Platform[];
}

/** The row fields every judgment of one file reads. */
export interface PlaybackRow {
	readonly kind: AssetKind;
	readonly mimeType: string;
	readonly mediaFormat?: MediaFormatValue;
}

/**
 * The one source of re-export advice: a variant of each kind that plays on
 * both platforms. The refusals, the boundary rule and the cutover's notice
 * read it.
 */
export const REEXPORT_AS: Readonly<Record<MediaKind, string>> = {
	image: "a PNG or JPEG",
	audio: "MP3, or M4A with AAC audio",
	video: "MP4 with H.264 Main video",
};

/** The advice as it sits mid-sentence: one holding a comma closes with one. */
function advice(kind: MediaKind): string {
	const text = REEXPORT_AS[kind];
	return text.includes(",") ? `${text},` : text;
}

/** Whether a stored value plays on every one of `platforms`. */
export function playsOnEvery(
	value: MediaFormatValue,
	platforms: readonly Platform[],
): boolean {
	const playsOn = mediaFormatPlaysOn(value);
	return platforms.every((platform) => playsOn.includes(platform));
}

/** The stored value of a row: an absent format reads as `unplayable`. */
function storedValue(row: PlaybackRow): MediaFormatValue {
	return row.mediaFormat ?? UNPLAYABLE_MEDIA_FORMAT;
}

/** The declared platforms a value does not play on. */
function missingFrom(
	value: MediaFormatValue,
	platforms: readonly Platform[],
): Platform[] {
	const playsOn = mediaFormatPlaysOn(value);
	return platforms.filter((platform) => !playsOn.includes(platform));
}

/**
 * Every authored reference whose file a declared platform cannot play, in
 * walk order. Built-in icons are skipped (they are PNG and play everywhere),
 * as is a reference with no entry in `formats` (the existence rules own it)
 * and a row with no format.
 */
export function unplayableReferences(
	doc: BlueprintDoc,
	formats: ReadonlyMap<
		string,
		{ readonly mediaFormat?: MediaFormatValue; readonly mimeType: string }
	>,
	platforms: readonly Platform[],
): UnplayableReference[] {
	const found: UnplayableReference[] = [];
	for (const ref of walkAuthoredAssetRefs(doc)) {
		if (isBuiltinIconRef(ref.assetId)) continue;
		const row = formats.get(ref.assetId);
		if (row?.mediaFormat === undefined) continue;
		if (playsOnEvery(row.mediaFormat, platforms)) continue;
		found.push({
			ref,
			mediaFormat: row.mediaFormat,
			label: mediaFormatLabel(row.mediaFormat, row.mimeType),
			missing:
				row.mediaFormat === UNPLAYABLE_MEDIA_FORMAT
					? [...platforms]
					: missingFrom(row.mediaFormat, platforms),
		});
	}
	return found;
}

/** "a, b and c". */
function joined(parts: readonly string[]): string {
	if (parts.length <= 1) return parts.join("");
	return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "a file" or "2 files", by the distinct files the references name. */
function filesNoun(references: readonly UnplayableReference[]): string {
	const files = new Set(references.map((reference) => reference.ref.assetId));
	return files.size === 1 ? "a file" : `${files.size} files`;
}

function listed(references: readonly UnplayableReference[]): string {
	return joined(
		references.map(
			(reference) => `${describeCarrier(reference.ref)} in ${reference.label}`,
		),
	);
}

/**
 * Every reference a declared platform cannot play, named: one sentence per
 * platform over the references only it cannot play, one for the references
 * no CommCare app plays, then an invitation to replace or remove them.
 */
export function describeUnplayableReferences(
	references: readonly UnplayableReference[],
): string {
	const sentences: string[] = [];
	const playable = references.filter(
		(reference) => reference.mediaFormat !== UNPLAYABLE_MEDIA_FORMAT,
	);
	for (const platform of PLATFORMS) {
		const missing = playable.filter((reference) =>
			reference.missing.includes(platform),
		);
		if (missing.length === 0) continue;
		sentences.push(
			`${PLATFORM_LABELS[platform]} can't play ${filesNoun(missing)} this app uses: ${listed(missing)}.`,
		);
	}
	const nowhere = references.filter(
		(reference) => reference.mediaFormat === UNPLAYABLE_MEDIA_FORMAT,
	);
	if (nowhere.length > 0) {
		sentences.push(
			`No CommCare app can play ${filesNoun(nowhere)} this app uses: ${listed(nowhere)}.`,
		);
	}
	sentences.push(
		references.length === 1
			? "You can replace it or remove it, then try again."
			: "You can replace or remove them, then try again.",
	);
	return sentences.join(" ");
}

/**
 * The attach verdict's line for a file the app's platforms cannot play, or
 * `null` when it plays on every one of them (or is not a media file).
 */
export function attachPlatformLine(args: {
	readonly assetId: string;
	readonly slot: string;
	readonly row: PlaybackRow;
	readonly platforms: readonly Platform[];
}): string | null {
	const { row, platforms } = args;
	if (!isMediaKind(row.kind)) return null;
	const value = storedValue(row);
	if (playsOnEvery(value, platforms)) return null;
	const label = mediaFormatLabel(value, row.mimeType);
	const fix = `Exporting it again as ${advice(row.kind)} and uploading that fixes it.`;
	if (value === UNPLAYABLE_MEDIA_FORMAT) {
		return `Tried to attach asset "${args.assetId}" as ${args.slot}, but no CommCare app can play it (${label}). ${fix}`;
	}
	const [missing] = missingFrom(value, platforms);
	if (missing === undefined) return null;
	return `Tried to attach asset "${args.assetId}" as ${args.slot}, but it is ${label}, which ${PLATFORM_LABELS[missing]} can't play, and this app runs ${inPlatform(missing)}. ${fix}`;
}

/**
 * The builder's sentence for a file the app's platforms cannot play, shown
 * where its slot shows a refusal, or `null` when it plays on every one.
 */
export function attachPlatformSentence(
	row: PlaybackRow,
	platforms: readonly Platform[],
): string | null {
	if (!isMediaKind(row.kind)) return null;
	const value = storedValue(row);
	if (playsOnEvery(value, platforms)) return null;
	const label = mediaFormatLabel(value, row.mimeType);
	const fix = `Exporting it again as ${advice(row.kind)} fixes that.`;
	if (value === UNPLAYABLE_MEDIA_FORMAT) {
		return `No CommCare app can play this ${row.kind} (${label}). ${fix}`;
	}
	const [missing] = missingFrom(value, platforms);
	if (missing === undefined) return null;
	return `This ${row.kind} is ${label}, which ${PLATFORM_LABELS[missing]} can't play, and this app runs ${inPlatform(missing)}. ${fix}`;
}

/** A picker row's disabled line, with no period, or `undefined` when the file plays. */
export function assetUnavailableReason(
	row: PlaybackRow,
	platforms: readonly Platform[],
): string | undefined {
	if (!isMediaKind(row.kind)) return undefined;
	const value = storedValue(row);
	if (playsOnEvery(value, platforms)) return undefined;
	if (value === UNPLAYABLE_MEDIA_FORMAT) {
		return "No CommCare app can play this file";
	}
	const [missing] = missingFrom(value, platforms);
	if (missing === undefined) return undefined;
	return `${PLATFORM_LABELS[missing]} can't play ${mediaFormatLabel(value, row.mimeType)}`;
}

const KIND_PLURAL: Readonly<Record<MediaKind, string>> = {
	image: "images",
	audio: "audio",
	video: "video",
};

/**
 * The Upload tab's sentence for a MIME none of whose variants plays on every
 * declared platform (ICO, AVIF, AAC, AMR, MIDI, MKV in an app declaring
 * both), or `undefined` where some variant plays everywhere the app runs.
 */
export function formatUnavailableReason(
	mimeType: string,
	platforms: readonly Platform[],
): string | undefined {
	const format = acceptedFormatFor(mimeType);
	if (format === undefined || !isMediaKind(format.kind)) return undefined;
	const variants = MEDIA_FORMATS.filter((variant) => variant.mime === mimeType);
	if (variants.some((variant) => playsOnEvery(variant.key, platforms))) {
		return undefined;
	}
	const missing =
		platforms.find(
			(platform) =>
				!variants.some((variant) => variant.playsOn.includes(platform)),
		) ?? platforms[0];
	if (missing === undefined) return undefined;
	return `${PLATFORM_LABELS[missing]} can't play ${format.label} ${KIND_PLURAL[format.kind]}, and this app runs ${inPlatform(missing)}. Exporting it again as ${advice(format.kind)} fixes that.`;
}

/** The file manager's line: "Plays in Web Apps and on Android", "Plays only on Android". */
export function playsOnLine(playsOn: readonly Platform[]): string {
	return playsOn.length === 0
		? "No CommCare app plays this file"
		: `Plays ${platformDeclarationPhrase(playsOn)}`;
}

/**
 * Preview's line for an audio or video file only Android plays, or `null`.
 * Preview plays media in the browser, so it plays what Web Apps plays. An
 * `unplayable` row and a row with no format keep the player: no CommCare app
 * plays the first, and the browser may play either.
 */
export function browserStandIn(row: {
	readonly kind: AssetKind;
	readonly playsOn?: readonly Platform[];
}): string | null {
	if (row.kind !== "audio" && row.kind !== "video") return null;
	const playsOn = row.playsOn ?? [];
	if (!playsOn.includes("android") || playsOn.includes("web-apps")) return null;
	return `This ${row.kind} plays on Android devices. Your browser can't play it here.`;
}
