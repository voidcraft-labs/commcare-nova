/**
 * The media of a menu, a case list menu item, a form and an always-offered
 * registration: two maps of a path by language (`media_image`,
 * `media_audio`), each read into the one asset Nova holds for every
 * language. A map is read as CommCare HQ's build shows it in each app
 * language (`shownNavMedia`): a language with no path of its own shows the
 * path of HQ's `default` table, so a map that shows one path in every
 * language reads as that one asset, whichever languages store it, and a map
 * that shows two differs by language. A path the media index gives no asset
 * for is handed to project data with its node, and its slot stays absent.
 */
import type { MediaKind } from "@/lib/domain";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { applicationReading } from "../appShell";
import { type Claim, defineClaims, derived, refuse, take } from "../claims";
import type { ReadContext } from "../context";
import { compareCodePoints } from "../hqText";
import { isJsonObject, type JsonCursor } from "../jsonCursor";
import { readMediaMap } from "../xform/media";

const M = "menus-and-case-lists";
const F = "forms-and-case-writes";

/** The classes whose two maps this reader reads. */
type MediaClass =
	| "Module"
	| "AdvancedModule"
	| "Form"
	| "AdvancedForm"
	| "CaseList"
	| "CaseListForm";

interface ClassClaims {
	readonly image: Claim<"take">;
	readonly audio: Claim<"take">;
	readonly imageDiffers: Claim<"refuse">;
	readonly audioDiffers: Claim<"refuse">;
	readonly imageForAll: Claim<"derived">;
	readonly audioForAll: Claim<"derived">;
}

function menuClaims(cls: "Module" | "AdvancedModule"): ClassClaims {
	return {
		image: take(
			`${M}/media-image-media-audio-same-asset-in-every-language`,
			`schema:${cls}.media_image`,
		),
		audio: take(
			`${M}/media-image-media-audio-same-asset-in-every-language`,
			`schema:${cls}.media_audio`,
		),
		imageDiffers: refuse(
			`${M}/media-image-media-audio-differing-by-language`,
			`schema:${cls}.media_image`,
		),
		audioDiffers: refuse(
			`${M}/media-image-media-audio-differing-by-language`,
			`schema:${cls}.media_audio`,
		),
		imageForAll: derived(
			`${M}/use-default-image-for-all-use-default-audio-for-all`,
			`schema:${cls}.use_default_image_for_all`,
		),
		audioForAll: derived(
			`${M}/use-default-image-for-all-use-default-audio-for-all`,
			`schema:${cls}.use_default_audio_for_all`,
		),
	};
}

function formClaims(cls: "Form" | "AdvancedForm"): ClassClaims {
	return {
		image: take(
			`${F}/media-image-media-audio-same-asset-every-language`,
			`schema:${cls}.media_image`,
		),
		audio: take(
			`${F}/media-image-media-audio-same-asset-every-language`,
			`schema:${cls}.media_audio`,
		),
		imageDiffers: refuse(
			`${F}/media-image-media-audio-differing-by-language`,
			`schema:${cls}.media_image`,
		),
		audioDiffers: refuse(
			`${F}/media-image-media-audio-differing-by-language`,
			`schema:${cls}.media_audio`,
		),
		imageForAll: derived(
			`${F}/use-default-image-for-all-use-default-audio-for-all`,
			`schema:${cls}.use_default_image_for_all`,
		),
		audioForAll: derived(
			`${F}/use-default-image-for-all-use-default-audio-for-all`,
			`schema:${cls}.use_default_audio_for_all`,
		),
	};
}

const CLAIMS: Readonly<Record<MediaClass, ClassClaims>> = {
	Module: menuClaims("Module"),
	AdvancedModule: menuClaims("AdvancedModule"),
	Form: formClaims("Form"),
	AdvancedForm: formClaims("AdvancedForm"),
	CaseList: {
		image: take(
			`${M}/module-case-list-media-image-media-audio`,
			"schema:CaseList.media_image",
		),
		audio: take(
			`${M}/module-case-list-media-image-media-audio`,
			"schema:CaseList.media_audio",
		),
		imageDiffers: refuse(
			`${M}/media-image-media-audio-differing-by-language`,
			"schema:CaseList.media_image",
		),
		audioDiffers: refuse(
			`${M}/media-image-media-audio-differing-by-language`,
			"schema:CaseList.media_audio",
		),
		imageForAll: derived(
			`${M}/use-default-image-for-all-use-default-audio-for-all`,
			"schema:CaseList.use_default_image_for_all",
		),
		audioForAll: derived(
			`${M}/use-default-image-for-all-use-default-audio-for-all`,
			"schema:CaseList.use_default_audio_for_all",
		),
	},
	CaseListForm: {
		image: take(
			`${M}/case-list-form-media-image-media-audio`,
			"schema:CaseListForm.media_image",
		),
		audio: take(
			`${M}/case-list-form-media-image-media-audio`,
			"schema:CaseListForm.media_audio",
		),
		imageDiffers: refuse(
			`${M}/media-image-media-audio-differing-by-language`,
			"schema:CaseListForm.media_image",
		),
		audioDiffers: refuse(
			`${M}/media-image-media-audio-differing-by-language`,
			"schema:CaseListForm.media_audio",
		),
		imageForAll: derived(
			`${M}/use-default-image-for-all-use-default-audio-for-all`,
			"schema:CaseListForm.use_default_image_for_all",
		),
		audioForAll: derived(
			`${M}/use-default-image-for-all-use-default-audio-for-all`,
			"schema:CaseListForm.use_default_audio_for_all",
		),
	},
};

defineClaims(
	"menus.navMedia",
	Object.fromEntries(
		Object.entries(CLAIMS).flatMap(([cls, claims]) =>
			Object.entries(claims).map(([name, one]) => [`${name}@${cls}`, one]),
		),
	) as Record<string, Claim>,
);

function isMediaClass(cls: string): cls is MediaClass {
	return Object.hasOwn(CLAIMS, cls);
}

/** The switch that has every language use the default language's file, by map. */
const FOR_ALL = {
	media_image: "use_default_image_for_all",
	media_audio: "use_default_audio_for_all",
} as const;

/**
 * The path each of the app's languages `langs` shows for one stored media map, as CommCare HQ's
 * build writes it (`models/mixins.py::NavMenuItemMediaMixin`) and a device or Web Apps reads it:
 *
 * - the suite references the media only where some language holds a path of its own
 *   (`uses_image`, `uses_audio`, over the strict lookup), so a map no language holds a path in
 *   shows nothing anywhere, whatever other keys it holds;
 * - a language's own `app_strings.txt` holds its own path (`icon_app_string` without
 *   `for_default`, the strict lookup);
 * - the `default` table holds, over the languages in order, the first path the loose lookup
 *   gives (`app_strings.py::create_default_app_strings`, which never lets a blank overwrite a
 *   path): the language's own, else the value under the map's least key
 *   (`_get_media_by_language`, `sorted(media_dict.items())`);
 * - a language with no path of its own shows the `default` table's, because Core loads the
 *   `default` locale under every locale (`Localizer.getLocaleData`);
 * - `forAll` (`use_default_image_for_all`, `use_default_audio_for_all`) has every lookup read
 *   the first language (`app.default_language`).
 *
 * A language that shows nothing maps to `""`. Undefined where the map stores a value that is
 * neither text nor null, which HQ's `DictProperty(StringProperty)` never holds.
 */
export function shownNavMedia(
	stored: unknown,
	forAll: unknown,
	langs: readonly string[],
): Readonly<Record<string, string>> | undefined {
	const map = isJsonObject(stored) ? stored : {};
	for (const value of Object.values(map))
		if (value !== null && typeof value !== "string") return undefined;
	const pathOf = (lang: string): string => {
		const value = map[lang];
		return typeof value === "string" ? value : "";
	};
	const first = langs[0] ?? "en";
	const strict = (lang: string): string =>
		pathOf(forAll === true ? first : lang);
	const out: Record<string, string> = {};
	if (!langs.some((lang) => strict(lang) !== "")) {
		for (const lang of langs) out[lang] = "";
		return out;
	}
	const least = Object.keys(map).sort(compareCodePoints)[0];
	const loose = (lang: string): string =>
		strict(lang) || (least === undefined ? "" : pathOf(least));
	const fallback =
		langs
			.filter((lang) => lang !== "default")
			.map(loose)
			.find((path) => path !== "") ?? "";
	for (const lang of langs) out[lang] = strict(lang) || fallback;
	return out;
}

/**
 * `shownNavMedia` of a block's `key` map under the block's own switch for it, the block read
 * through `get` (a stored object's key, or a cursor's `peek`).
 */
export function shownBlockMedia(
	get: (key: string) => unknown,
	key: "media_image" | "media_audio",
	langs: readonly string[],
): Readonly<Record<string, string>> | undefined {
	return shownNavMedia(get(key), get(FOR_ALL[key]), langs);
}

/**
 * Records the first publish's rewrite of a stored map that is not the map Nova prints for what
 * every language shows: Nova writes the shown path under every app language and nothing else
 * (`multimedia/navMenuMedia.ts::buildNavMediaDicts`), with both switches off, so a map stored in
 * one language, holding a blank or a language the app no longer lists, or read under the switch,
 * is written again, every language showing what it showed (`media-maps-respelled`).
 */
function recordRespelling(
	ctx: ReadContext,
	node: JsonCursor,
	key: "media_image" | "media_audio",
	shown: Readonly<Record<string, string>>,
	same: Claim<"take">,
): void {
	const stored = node.peek(key);
	const map = isJsonObject(stored) ? stored : {};
	const printed = Object.entries(shown).filter(([, path]) => path !== "");
	const exact =
		Object.keys(map).length === printed.length &&
		printed.every(([lang, path]) => map[lang] === path);
	if (!exact)
		ctx.facts.sameStateRewrites.push({
			entry: same.entry,
			path: `${node.pointer}/${key}`,
			register: "media-maps-respelled",
		});
	if (node.peek(FOR_ALL[key]) === true)
		ctx.facts.sameStateRewrites.push({
			entry: same.entry,
			path: `${node.pointer}/${FOR_ALL[key]}`,
			register: "media-maps-respelled",
		});
}

/**
 * One map read into the asset it shows, or absent: the path every app language shows
 * (`shownNavMedia`), which must be one file in every language, else the map differs by
 * language.
 */
function readMap(
	ctx: ReadContext,
	node: JsonCursor,
	key: "media_image" | "media_audio",
	slot: string,
	mediaKind: MediaKind,
	place: HqPlace,
	same: Claim<"take">,
	differs: Claim<"refuse">,
): string | undefined {
	if (!node.used(key)) return undefined;
	const codes = applicationReading(ctx)?.languages.codes ?? [];
	const shown = shownBlockMedia((one) => node.peek(one), key, codes);
	const read =
		shown === undefined
			? ({ kind: "differs" } as const)
			: readMediaMap(ctx, shown, {
					site: { json: node, key },
					place,
					slot,
					mediaKind,
				});
	if (shown !== undefined && read.kind !== "differs")
		recordRespelling(ctx, node, key, shown, same);
	switch (read.kind) {
		case "asset":
			node.take(key, same, (value) => value).value;
			return read.assetId;
		case "differs":
			node.refuse(key, differs);
			return undefined;
		case "none":
			node.take(key, same, (value) => value).value;
			return undefined;
		case "handed-off":
			return undefined;
	}
}

/** The two media maps of one menu, list item, form or registration block, each read into the
 *  one asset it names. `slots` are the two `MediaRefLocation` kinds the maps stand in. */
export function readNavMedia(
	ctx: ReadContext,
	node: JsonCursor,
	slots: { readonly image: string; readonly audio: string },
	place: HqPlace,
): { readonly icon?: string; readonly audioLabel?: string } {
	if (!isMediaClass(node.cls))
		throw new Error(
			`The reader asked for the menu media of a ${node.cls}, which holds none. Read menu media only on a menu, a case list menu item, a form or a registration block.`,
		);
	const claims = CLAIMS[node.cls];
	const icon = readMap(
		ctx,
		node,
		"media_image",
		slots.image,
		"image",
		place,
		claims.image,
		claims.imageDiffers,
	);
	const audioLabel = readMap(
		ctx,
		node,
		"media_audio",
		slots.audio,
		"audio",
		place,
		claims.audio,
		claims.audioDiffers,
	);
	// Both switches are read into the maps' readings (`shownNavMedia`), and Nova holds one
	// file for every language, which it writes with both switches off.
	node.derived("use_default_image_for_all", claims.imageForAll);
	node.derived("use_default_audio_for_all", claims.audioForAll);
	return {
		...(icon === undefined ? {} : { icon }),
		...(audioLabel === undefined ? {} : { audioLabel }),
	};
}
