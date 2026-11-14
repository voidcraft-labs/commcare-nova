/**
 * The media of a menu, a case list menu item, a form and an always-offered
 * registration: two maps of a path by language (`media_image`,
 * `media_audio`), each read into the one asset Nova holds for every
 * language. The same path in every language the app has reads as that one
 * asset; a path present in one language and absent in another, or two
 * paths, differ by language. A path the media index gives no asset for is
 * handed to project data with its node, and its slot stays absent.
 */
import type { MediaKind } from "@/lib/domain";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { applicationReading } from "../appShell";
import { type Claim, defineClaims, derived, refuse, take } from "../claims";
import type { ReadContext } from "../context";
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
	/** Where the manifest names the class's maps differing by language. */
	readonly imageDiffers?: Claim<"refuse">;
	readonly audioDiffers?: Claim<"refuse">;
	readonly imageForAll?: Claim<"derived">;
	readonly audioForAll?: Claim<"derived">;
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

/** A map's non-blank paths by language code, every value a string. */
function pathsOf(value: unknown): Readonly<Record<string, string>> {
	if (!isJsonObject(value)) return {};
	const paths: Record<string, string> = {};
	for (const [code, path] of Object.entries(value))
		if (typeof path === "string" && path !== "") paths[code] = path;
	return paths;
}

/**
 * One map read into the asset it names, or absent. Every app language must
 * hold the one path; a map where some language holds none, or two paths,
 * differs by language.
 */
function readMap(
	ctx: ReadContext,
	node: JsonCursor,
	key: "media_image" | "media_audio",
	slot: string,
	mediaKind: MediaKind,
	place: HqPlace,
	same: Claim<"take">,
	differs: Claim<"refuse"> | undefined,
): string | undefined {
	if (!node.used(key)) return undefined;
	const paths = pathsOf(node.peek(key));
	const codes = applicationReading(ctx)?.languages.codes ?? [];
	const held = codes.filter((code) => paths[code] !== undefined);
	const distinct = new Set(held.map((code) => paths[code]));
	if (held.length === 0) {
		node.take(key, same, (value) => value).value;
		return undefined;
	}
	if (held.length < codes.length || distinct.size > 1) {
		// A class the manifest names no such reading for is left for the close.
		if (differs !== undefined) node.refuse(key, differs);
		return undefined;
	}
	const read = readMediaMap(ctx, paths, {
		site: { json: node, key },
		place,
		slot,
		mediaKind,
	});
	switch (read.kind) {
		case "asset":
			node.take(key, same, (value) => value).value;
			return read.assetId;
		case "differs":
			if (differs !== undefined) node.refuse(key, differs);
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
	// Nova holds one file for every language, which is what both switches say.
	if (claims.imageForAll !== undefined)
		node.derived("use_default_image_for_all", claims.imageForAll);
	if (claims.audioForAll !== undefined)
		node.derived("use_default_audio_for_all", claims.audioForAll);
	return {
		...(icon === undefined ? {} : { icon }),
		...(audioLabel === undefined ? {} : { audioLabel }),
	};
}
