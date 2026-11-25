/**
 * Read the image and spoken name of each navigation carrier. Effective files
 * determine the shared value. Sparse entries keep the worker-visible fallback
 * of both the full app and installations limited to selected languages.
 */
import type { MediaKind } from "@/lib/domain";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { applicationReading } from "../appShell";
import { type Claim, defineClaims, derived, take } from "../claims";
import type { ReadContext } from "../context";
import { compareCodePoints } from "../hqText";
import { isJsonObject, type JsonCursor } from "../jsonCursor";

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
	readonly imageDiffers: Claim<"take">;
	readonly audioDiffers: Claim<"take">;
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
		imageDiffers: take(
			`${M}/media-image-media-audio-differing-by-language`,
			`schema:${cls}.media_image`,
		),
		audioDiffers: take(
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
		imageDiffers: take(
			`${F}/media-image-media-audio-differing-by-language`,
			`schema:${cls}.media_image`,
		),
		audioDiffers: take(
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
		imageDiffers: take(
			`${M}/media-image-media-audio-differing-by-language`,
			"schema:CaseList.media_image",
		),
		audioDiffers: take(
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
		imageDiffers: take(
			`${M}/media-image-media-audio-differing-by-language`,
			"schema:CaseListForm.media_image",
		),
		audioDiffers: take(
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
	recordFromEntries(
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
	const map = isJsonObject(stored) ? stored : NO_ENTRIES;
	for (const value of Object.values(map))
		if (value !== null && typeof value !== "string") return undefined;
	const pathOf = (lang: string): string => {
		const value = map[lang];
		return typeof value === "string" ? value : "";
	};
	const first = langs[0] ?? "en";
	const strict = (lang: string): string =>
		pathOf(forAll === true ? first : lang);
	const out = recordFromEntries<string>([]);
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

/** Compare the paths the held carrier will actually write. Switches that
 * made all languages show one file can be expressed by a shared file. */
function recordRespelling(
	ctx: ReadContext,
	node: JsonCursor,
	key: "media_image" | "media_audio",
	shown: Readonly<Record<string, string>>,
	same: Claim<"take">,
): void {
	const stored = node.peek(key);
	const map = isJsonObject(stored) ? stored : NO_ENTRIES;
	const printed = Object.entries(shown);
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

/** Resolve every visible file through the Project index, keeping a missing
 * or blank language separate when a named installation's default can differ. */
function readMap(
	ctx: ReadContext,
	node: JsonCursor,
	key: "media_image" | "media_audio",
	slot: string,
	mediaKind: MediaKind,
	place: HqPlace,
	same: Claim<"take">,
	differs: Claim<"take">,
): {
	asset?: string;
	translations?: Map<string, string | null>;
	former?: [string, string];
} {
	if (!node.used(key)) return {};
	const languages = applicationReading(ctx)?.languages;
	if (!languages?.source) return {};
	const codes = languages.codes;
	const stored = node.peek(key);
	const shown = shownBlockMedia((one) => node.peek(one), key, codes);
	if (!shown || !isJsonObject(stored)) return {}; // The cursor retains the unreadable map for its close.
	const all = node.peek(FOR_ALL[key]) === true;
	const resolved = new Map<string, string>();
	const missing = new Set<string>();
	for (const path of new Set(Object.values(shown))) {
		if (!path) continue;
		const value = ctx.input.media.resolve(path);
		if (value.kind === "asset") {
			resolved.set(path, value.assetId);
			ctx.facts.mediaReferences.push({
				path,
				assetId: value.assetId,
				mediaKind,
				place,
				pointer: `${node.pointer}/${key}`,
				slot,
			});
		} else {
			if (!missing.size)
				ctx.accounting.handOffAt({ json: node, key }, "media-reference", path);
			missing.add(path);
			ctx.facts.pendingMedia.push({
				path,
				mediaKind,
				place,
				pointer: `${node.pointer}/${key}`,
				slot,
				resolution: value.kind,
			});
		}
	}
	if (missing.size) {
		/* The files go to the media plan; the map itself is read here, by the
		 * paths it shows, as the map of one file or of a file a language. */
		const paths = new Set(Object.values(shown).filter(Boolean));
		node.take(key, paths.size > 1 ? differs : same, () => undefined).value;
		return {};
	}
	const asset = resolved.get(shown[languages.source] ?? "");
	const translations = new Map<string, string | null>();
	const printed = recordFromEntries<string>([]);
	for (const code of codes) {
		const tag = languages.tagOf.get(code);
		if (!tag || !asset) continue;
		const original = stored[code];
		const path = shown[code] ?? "";
		const own = resolved.get(path);
		if (!all && !original) {
			translations.set(tag, Object.hasOwn(stored, code) ? "blank" : null);
			if (Object.hasOwn(stored, code)) printed[code] = "";
		} else if (own) {
			printed[code] = path;
			if (own !== asset) translations.set(tag, own);
		}
	}
	let former: [string, string] | undefined;
	const least = Object.keys(stored).sort(compareCodePoints)[0];
	if (!all && least !== undefined && !codes.includes(least)) {
		const current = recordFromEntries(
			codes
				.filter((code) => Object.hasOwn(stored, code))
				.map((code) => [code, stored[code]]),
		);
		const without = shownNavMedia(current, false, codes);
		if (without && codes.some((code) => without[code] !== shown[code])) {
			const raw = stored[least],
				file = typeof raw === "string" && raw ? resolved.get(raw) : "blank";
			if (file) {
				former = [least, file];
				printed[least] = typeof raw === "string" ? raw : "";
			}
		}
	}
	recordRespelling(ctx, node, key, printed, same);
	return node.take(
		key,
		new Set(resolved.values()).size > 1 ? differs : same,
		() => ({ asset, translations, former }),
	).value;
}

/** The two media maps of one menu, list item, form or registration block, each read into the
 *  one asset it names. `slots` are the two `MediaRefLocation` kinds the maps stand in. */
export function readNavMedia(
	ctx: ReadContext,
	node: JsonCursor,
	slots: { readonly image: string; readonly audio: string },
	place: HqPlace,
): {
	readonly icon?: string;
	readonly audioLabel?: string;
	readonly mediaByLanguage?: Record<
		string,
		{ icon?: string | null; audioLabel?: string | null }
	>;
	readonly mediaByFormerCode?: Record<
		string,
		{ icon?: string; audioLabel?: string }
	>;
} {
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
	// Both switches are represented by the files each language reads.
	node.derived("use_default_image_for_all", claims.imageForAll);
	node.derived("use_default_audio_for_all", claims.audioForAll);
	const byLanguage = recordFromEntries<{
		icon?: string | null;
		audioLabel?: string | null;
	}>([]);
	for (const [tag, file] of icon.translations ?? []) {
		byLanguage[tag] = { icon: file };
	}
	for (const [tag, file] of audioLabel.translations ?? []) {
		byLanguage[tag] = { ...byLanguage[tag], audioLabel: file };
	}
	const former = recordFromEntries<{ icon?: string; audioLabel?: string }>([]);
	if (icon.former) {
		const [code, file] = icon.former;
		former[code] = { icon: file };
	}
	if (audioLabel.former) {
		const [code, file] = audioLabel.former;
		former[code] = { ...former[code], audioLabel: file };
	}
	return {
		...(Object.keys(former).length && { mediaByFormerCode: former }),
		...(icon.asset && { icon: icon.asset }),
		...(audioLabel.asset && { audioLabel: audioLabel.asset }),
		...(Object.keys(byLanguage).length && { mediaByLanguage: byLanguage }),
	};
}
