/**
 * Read the image and spoken name of each navigation carrier. Effective files
 * determine the shared value. Sparse entries keep the worker-visible fallback
 * of both the full app and installations limited to selected languages.
 */
import { existsOne, textContent } from "domutils";
import {
	type BlueprintDoc,
	effectiveAppLocalization,
	type MediaKind,
} from "@/lib/domain";
import type { IconRef } from "@/lib/domain/builtinIcons";
import {
	navigationMediaOverride,
	ordinaryNavigationAsset,
	otherLanguageFormPacksMenuFile,
	storedNavigationFile,
} from "@/lib/domain/navigationMedia";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { applicationReading, type HeldTranslationKey } from "../appShell";
import {
	account,
	type Claim,
	defineClaims,
	derived,
	refuse,
	take,
} from "../claims";
import type { ReadContext } from "../context";
import { compareCodePoints } from "../hqText";
import { isJsonObject, type JsonCursor, pointerToken } from "../jsonCursor";
import type { PendingMedia } from "../types";

const M = "menus-and-case-lists";
const F = "forms-and-case-writes";

/** The classes whose two maps this reader reads. */
type MediaClass =
	| "Module"
	| "AdvancedModule"
	| "ShadowModule"
	| "Form"
	| "AdvancedForm"
	| "ShadowForm"
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

function menuClaims(
	cls: "Module" | "AdvancedModule" | "ShadowModule",
): ClassClaims {
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

function formClaims(cls: "Form" | "AdvancedForm" | "ShadowForm"): ClassClaims {
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
	ShadowModule: menuClaims("ShadowModule"),
	Form: formClaims("Form"),
	AdvancedForm: formClaims("AdvancedForm"),
	ShadowForm: formClaims("ShadowForm"),
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

const generatedMediaClaim = take(
	"application-and-settings/translations-generated-navigation-file",
	"schema:Application.translations",
);
const generatedMediaNotPackaged = refuse(
	"application-and-settings/translations-generated-navigation-file-not-packaged",
	"schema:Application.translations",
);
const generatedMenuIconWithoutMapping = refuse(
	"application-and-settings/translations-generated-menu-icon-without-mapping",
	"schema:Application.translations",
);
const generatedMenuIconOnlyInMediaMap = refuse(
	"application-and-settings/translations-generated-menu-icon-only-in-media-map",
	"schema:Application.translations",
);
const generatedMenuAudioOnlyInMediaMap = refuse(
	"application-and-settings/translations-generated-menu-audio-only-in-media-map",
	"schema:Application.translations",
);
const generatedMenuIconOutsideInstallation = refuse(
	"application-and-settings/translations-generated-menu-icon-outside-installation-languages",
	"schema:Application.translations",
);
const generatedMediaNoEffect = account(
	"application-and-settings/translations-generated-key-with-no-effect",
	"schema:Application.translations",
);
defineClaims("menus.navMedia", {
	generatedMediaClaim,
	generatedMediaNotPackaged,
	generatedMenuIconWithoutMapping,
	generatedMenuIconOnlyInMediaMap,
	generatedMenuAudioOnlyInMediaMap,
	generatedMenuIconOutsideInstallation,
	generatedMediaNoEffect,
});
const acceptedOverrides = new WeakMap<
	HeldTranslationKey,
	{
		language: string;
		role: "icon" | "audioLabel";
		path: string;
		place: HqPlace;
		carrierClass: string;
		repeatsStrictAsset?: true;
		assetId?: IconRef;
		pending?: PendingMedia;
	}
>();

const ordinaryPathsByLanguage = new WeakMap<
	ReadContext,
	ReadonlyMap<string, ReadonlySet<string>>
>();

/** HQ gathers the raw ordinary path in each installed language. A fallback
 * or a different path to the same asset does not package this path. */
function ordinarySourcePaths(ctx: ReadContext) {
	const known = ordinaryPathsByLanguage.get(ctx);
	if (known !== undefined) return known;
	const languages = applicationReading(ctx)?.languages;
	const paths = new Map<string, Set<string>>(
		(languages?.codes ?? []).map((code) => [code, new Set<string>()]),
	);
	const codeForTag = new Map(
		[...(languages?.tagOf ?? [])].map(([code, tag]) => [tag, code]),
	);
	const addMap = (value: unknown) => {
		if (!isJsonObject(value)) return;
		for (const [code, path] of Object.entries(value))
			if (typeof path === "string" && path) paths.get(code)?.add(path);
	};
	const addCarrier = (value: unknown) => {
		if (!isJsonObject(value)) return;
		addMap(value.media_image);
		addMap(value.media_audio);
	};
	const raw = ctx.input.source.raw.modules;
	if (Array.isArray(raw))
		for (const module of raw) {
			if (!isJsonObject(module)) continue;
			addCarrier(module);
			const item = module.case_list;
			if (isJsonObject(item) && item.show === true) addCarrier(item);
			const registration = module.case_list_form;
			if (isJsonObject(registration) && registration.form_id)
				addCarrier(registration);
			if (Array.isArray(module.forms))
				for (const form of module.forms) addCarrier(form);
		}
	for (const ref of [...ctx.facts.mediaReferences, ...ctx.facts.pendingMedia]) {
		if (ref.slot === "image_map_mapping")
			for (const code of ref.shownLanguages ?? [])
				paths.get(code)?.add(ref.path);
		if (ref.slot === "field_media_bundle" || ref.slot === "option_media")
			for (const recipient of ref.itextRecipients ?? []) {
				const code = codeForTag.get(recipient.language);
				if (code !== undefined) paths.get(code)?.add(ref.path);
			}
	}
	ordinaryPathsByLanguage.set(ctx, paths);
	return paths;
}

const localImagePath =
	/^jr:\/\/file\/commcare\/image\/[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

function mappedNavigationFile(
	ctx: ReadContext,
	path: string,
	role: "icon" | "audioLabel",
): boolean {
	const mediaType = role === "icon" ? "CommCareImage" : "CommCareAudio";
	return (
		ctx.input.source.multimediaMap?.some(
			(item) =>
				item.path === path &&
				item.mediaType === mediaType &&
				item.multimediaId !== null,
		) === true
	);
}

function xmlSourcesExcludeFile(ctx: ReadContext, path: string): boolean {
	return ctx.input.source.modules.every((source, index) => {
		const menu = ctx.draft.modules.find((one) => one.index === index);
		return source.forms.every((form, formIndex) => {
			if (form.docType === "ShadowForm" && form.attachment === null)
				return true;
			const html = menu?.forms.find((one) => one.index === formIndex)?.xform
				?.parsed.html;
			return (
				html !== undefined &&
				!textContent(html).includes(path) &&
				!existsOne(
					(node) =>
						Object.values(node.attribs).some((value) => value.includes(path)),
					[html],
				)
			);
		});
	});
}

const mentionsPath = (value: unknown, path: string) =>
	JSON.stringify(value)?.includes(path) === true;
const fileInventoryKeys = new Set([
	"translations",
	"multimedia_map",
	"_attachments",
]);

/** HQ prunes a mapped resource only if no ordinary carrier or logo in the
 * full app requests the path. Require a complete source inventory and leave
 * any other mention to its own carrier's reader. */
function noOrdinaryCarrier(ctx: ReadContext, path: string): boolean {
	return (
		!Object.entries(ctx.input.source.raw).some(
			([key, value]) =>
				!fileInventoryKeys.has(key) && mentionsPath(value, path),
		) && xmlSourcesExcludeFile(ctx, path)
	);
}

function menuAudioOnlyInMediaMap(ctx: ReadContext, path: string): boolean {
	return (
		/^jr:\/\/file\/commcare\/audio\/[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.test(
			path,
		) &&
		ctx.input.source.multimediaMap?.some(
			(item) =>
				item.path === path &&
				item.mediaType === "CommCareAudio" &&
				item.multimediaId !== null,
		) === true &&
		noOrdinaryCarrier(ctx, path)
	);
}

/** The narrow named-package failure witnessed on Android. The translated
 * menu icon is active in the chosen language. The only ordinary image files
 * at that path are on basic form tiles in the languages HQ excluded. */
function menuIconOutsideInstallation(
	ctx: ReadContext,
	path: string,
	code: string,
	place: HqPlace,
): boolean {
	const source = ctx.input.source;
	if (
		!mappedNavigationFile(ctx, path, "icon") ||
		!("menu" in place) ||
		!source.buildProfiles.some(
			(profile) =>
				profile.langs.length === 1 &&
				profile.langs[0] === code &&
				profile.practiceWorkerId === undefined,
		)
	)
		return false;
	const modules = source.raw.modules;
	if (!Array.isArray(modules)) return false;
	const selected = modules[place.menu];
	if (
		!isJsonObject(selected) ||
		selected.use_default_image_for_all === true ||
		!isJsonObject(selected.media_image) ||
		typeof selected.media_image[code] !== "string" ||
		!selected.media_image[code]
	)
		return false;
	if (
		Object.entries(source.raw).some(
			([key, value]) =>
				key !== "modules" &&
				!fileInventoryKeys.has(key) &&
				mentionsPath(value, path),
		)
	)
		return false;
	let foreignCarrier = false;
	for (const module of modules) {
		if (!isJsonObject(module)) return false;
		const { forms, ...menu } = module;
		if (mentionsPath(menu, path) || !Array.isArray(forms)) return false;
		for (const form of forms) {
			if (!isJsonObject(form)) return false;
			const { media_image: images, ...other } = form;
			if (mentionsPath(other, path)) return false;
			if (!mentionsPath(images, path)) continue;
			if (
				menu.doc_type !== "Module" ||
				form.doc_type !== "Form" ||
				form.use_default_image_for_all === true ||
				!isJsonObject(images)
			)
				return false;
			for (const [language, value] of Object.entries(images)) {
				if (!mentionsPath(value, path)) continue;
				if (
					value !== path ||
					language === code ||
					!source.langs.includes(language)
				)
					return false;
				foreignCarrier = true;
			}
		}
	}
	return foreignCarrier && xmlSourcesExcludeFile(ctx, path);
}

/** HQ packs an ordinary basic form file when its language is installed.
 * A menu locale may use that file if every relevant profile includes it. */
function menuMediaPackagedByAnotherLanguage(
	ctx: ReadContext,
	path: string,
	code: string,
	role: "icon" | "audioLabel",
): boolean {
	const source = ctx.input.source;
	const modules = source.raw.modules;
	if (!mappedNavigationFile(ctx, path, role) || !Array.isArray(modules))
		return false;
	const key = role === "icon" ? "media_image" : "media_audio";
	const carrierCodes = new Set<string>();
	for (const menu of modules) {
		if (
			!isJsonObject(menu) ||
			menu.doc_type !== "Module" ||
			!Array.isArray(menu.forms)
		)
			continue;
		for (const form of menu.forms) {
			if (
				!isJsonObject(form) ||
				form.doc_type !== "Form" ||
				form[FOR_ALL[key]] === true
			)
				continue;
			const files = form[key];
			if (!isJsonObject(files)) continue;
			for (const [language, value] of Object.entries(files))
				if (
					value === path &&
					language !== code &&
					source.langs.includes(language)
				)
					carrierCodes.add(language);
		}
	}
	return (
		carrierCodes.size > 0 &&
		source.buildProfiles.every(
			(profile) =>
				!profile.langs.includes(code) ||
				profile.langs.some((language) => carrierCodes.has(language)),
		)
	);
}

export function accountNavigationMediaOverride(
	ctx: ReadContext,
	doc: BlueprintDoc,
	held: HeldTranslationKey,
): boolean {
	const override = acceptedOverrides.get(held);
	if (override === undefined) return false;
	// HQ decides what to pack from ordinary carriers, even when the asset
	// index cannot resolve the path. Check that source fact before handoff.
	const localMenuIcon =
		override.carrierClass === "Module" &&
		override.role === "icon" &&
		localImagePath.test(override.path);
	const otherLanguageCarrier =
		override.carrierClass === "Module" &&
		menuMediaPackagedByAnotherLanguage(
			ctx,
			override.path,
			held.language,
			override.role,
		);
	if (
		!ordinarySourcePaths(ctx).get(held.language)?.has(override.path) &&
		!otherLanguageCarrier
	) {
		let claim = generatedMediaNotPackaged;
		if (localMenuIcon && override.pending?.resolution === "no-entry")
			claim = generatedMenuIconWithoutMapping;
		else if (
			localMenuIcon &&
			mappedNavigationFile(ctx, override.path, "icon") &&
			noOrdinaryCarrier(ctx, override.path)
		)
			claim = generatedMenuIconOnlyInMediaMap;
		else if (
			override.carrierClass === "Module" &&
			override.role === "audioLabel" &&
			menuAudioOnlyInMediaMap(ctx, override.path)
		)
			claim = generatedMenuAudioOnlyInMediaMap;
		else if (
			localMenuIcon &&
			menuIconOutsideInstallation(
				ctx,
				override.path,
				held.language,
				override.place,
			)
		)
			claim = generatedMenuIconOutsideInstallation;
		held.json.refuse(held.key, claim, { name: held.key });
		return true;
	}
	if (override.pending !== undefined) {
		ctx.accounting.handOffAt(held, "media-reference", override.path);
		ctx.facts.pendingMedia.push(override.pending);
	}
	if (override.assetId !== undefined) {
		const { place, carrierClass, role, language, assetId } = override;
		const menu =
			"menu" in place
				? ctx.draft.modules.find((one) => one.index === place.menu)
				: undefined;
		const module = menu === undefined ? undefined : doc.modules[menu.uuid];
		const form =
			place.kind === "form"
				? menu?.forms.find((one) => one.index === place.form)
				: undefined;
		const registration = module?.caseListRegistrationForm;
		const carrier =
			form !== undefined
				? doc.forms[form.uuid]
				: carrierClass === "CaseList"
					? module?.caseListMenuItem
					: carrierClass === "CaseListForm"
						? registration?.kind === "always"
							? registration
							: undefined
						: module;
		const carrierAsset =
			carrier === undefined
				? undefined
				: override.repeatsStrictAsset
					? storedNavigationFile(carrier, role, language)
					: navigationMediaOverride(carrier, role, language);
		if (
			carrierAsset !== assetId ||
			(!ordinaryNavigationAsset(
				doc,
				effectiveAppLocalization(doc.localization),
				role,
				language,
				assetId,
			) &&
				!(
					otherLanguageCarrier &&
					otherLanguageFormPacksMenuFile(
						doc,
						effectiveAppLocalization(doc.localization),
						role,
						language,
						assetId,
					)
				))
		) {
			held.json.refuse(held.key, generatedMediaNotPackaged, { name: held.key });
			return true;
		}
		if (override.repeatsStrictAsset) {
			held.json.account(held.key, generatedMediaNoEffect);
			return true;
		}
	}
	held.json.take(held.key, generatedMediaClaim, () => override.path).value;
	return true;
}

function navigationLocale(
	node: JsonCursor,
	place: HqPlace,
): string | undefined {
	if (place.kind === "form") return `forms.m${place.menu}f${place.form}`;
	if (!("menu" in place)) return undefined;
	if (node.cls === "CaseList") return `case_lists.m${place.menu}`;
	if (node.cls === "CaseListForm") return `case_list_form.m${place.menu}`;
	return `modules.m${place.menu}`;
}

/** Resolve authored locale overrides separately from the map whose default
 * remains active when the installation omits the override's language. */
function readOverrides(
	ctx: ReadContext,
	locale: string,
	carrierClass: string,
	shown: Readonly<Record<string, string>>,
	strictFile: (code: string) => unknown,
	mediaKind: MediaKind,
	slot: string,
	place: HqPlace,
): Map<string, string> {
	const overrides = new Map<string, string>();
	if (!Object.values(shown).some(Boolean)) return overrides;
	const app = applicationReading(ctx);
	const key = `${locale}.${mediaKind === "image" ? "icon" : "audio"}`;
	for (const held of app?.generatedKeys ?? []) {
		if (
			held.key !== key ||
			typeof held.value !== "string" ||
			!held.value ||
			held.value === strictFile(held.language)
		)
			continue;
		const tag = app?.languages.tagOf.get(held.language);
		if (tag === undefined) continue;
		const path = held.value;

		const resolution = ctx.input.media.resolve(path);
		const strictPath = strictFile(held.language);
		const strict =
			typeof strictPath === "string" && strictPath
				? ctx.input.media.resolve(strictPath)
				: undefined;
		// A second path to the strict asset has no independent override,
		// provided HQ really packs that exact path on an ordinary carrier.
		const repeatsStrictAsset =
			resolution.kind === "asset" &&
			strict?.kind === "asset" &&
			strict.assetId === resolution.assetId &&
			strict.mediaKind === resolution.mediaKind;
		const occurrence = {
			path,
			mediaKind,
			place,
			pointer: `${held.json.pointer}/${pointerToken(held.key)}`,
			slot,
		};
		if (resolution.kind === "asset") {
			if (!repeatsStrictAsset) {
				overrides.set(tag, resolution.assetId);
				ctx.facts.mediaReferences.push({
					...occurrence,
					assetId: resolution.assetId,
				});
			}
		}
		acceptedOverrides.set(held, {
			language: tag,
			role: mediaKind === "image" ? "icon" : "audioLabel",
			path,
			place,
			carrierClass,
			...(repeatsStrictAsset && { repeatsStrictAsset: true }),
			...(resolution.kind === "asset"
				? { assetId: resolution.assetId as IconRef }
				: { pending: { ...occurrence, resolution: resolution.kind } }),
		});
	}
	return overrides;
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
	overrides?: Map<string, string>;
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
	const locale = navigationLocale(node, place);
	const overrides =
		locale === undefined
			? undefined
			: readOverrides(
					ctx,
					locale,
					node.cls,
					shown,
					(code) => stored[all ? (codes[0] ?? "en") : code],
					mediaKind,
					slot,
					place,
				);
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
		() => ({ asset, translations, overrides, former }),
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
		{
			icon?: string | null;
			audioLabel?: string | null;
			iconOverride?: string;
			audioLabelOverride?: string;
		}
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
		iconOverride?: string;
		audioLabelOverride?: string;
	}>([]);
	for (const [tag, file] of icon.translations ?? []) {
		byLanguage[tag] = { icon: file };
	}
	for (const [tag, file] of audioLabel.translations ?? []) {
		byLanguage[tag] = { ...byLanguage[tag], audioLabel: file };
	}
	for (const [tag, file] of icon.overrides ?? [])
		byLanguage[tag] = { ...byLanguage[tag], iconOverride: file };
	for (const [tag, file] of audioLabel.overrides ?? [])
		byLanguage[tag] = { ...byLanguage[tag], audioLabelOverride: file };
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
