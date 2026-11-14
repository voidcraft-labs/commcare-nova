// lib/commcare/multimedia/navMenuMedia.ts
//
// Menu-item media — the icon + audio on a module home tile, a form
// command, and a case-list link. Two wire surfaces, both fed from the
// carrier's `icon` / `audioLabel` `MediaAssetId` slots:
//
//   1. HQ-JSON shell dicts (the upload path — CCHQ regenerates the
//      suite from these on import). CommCare's `NavMenuItemMediaMixin`
//      stores `media_image` / `media_audio` as language→path dicts:
//        "media_image": { "en": "jr://file/commcare/<hash>.png" }
//
//   2. The local suite `<menu>` / `<command>` display block (the
//      local-CCZ diagnostics path — Nova emits the suite directly). A
//      carrier WITH media wraps its text in `<display>`:
//        <display>
//          <text><locale id="modules.m0"/></text>
//          <text form="image"><locale id="modules.m0.icon"/></text>
//          <text form="audio"><locale id="modules.m0.audio"/></text>
//        </display>
//      and the jr:// paths live in app_strings under `<base>.icon` /
//      `<base>.audio`. A carrier WITHOUT media keeps the bare
//      `<text><locale id="<base>"/></text>` Nova already emits.
//
// Verified against `commcare-hq/.../app_manager/models.py::NavMenuItemMediaMixin`
// (the `media_image`/`media_audio` `DictProperty(StringProperty)` shape),
// `suite_xml/xml_models.py::MediaText`+`TextOrDisplay` (the `<display>`
// with `<text form="image"><locale/></text>` children — the modern
// localized-media shape), `suite_xml/sections/entries.py` (form +
// case-list commands carry the same media), and the fixture
// `tests/data/suite/reports_module_menu_multimedia.xml`.

import type { Element } from "domhandler";
import { el } from "@/lib/commcare/elementBuilders";
import type { IconRef } from "@/lib/domain/builtinIcons";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { type AssetManifest, requireAssetRef } from "./assetWirePath";

/** The HQ-shell media dicts a carrier needs stamped. Empty objects when
 *  the carrier has no media — matching the shell's default and the
 *  `media_image: {}` shape CCHQ accepts. */
export interface NavMediaDicts {
	readonly media_image: Record<string, string>;
	readonly media_audio: Record<string, string>;
}

/**
 * Build the `media_image` / `media_audio` dicts for a nav carrier's HQ
 * shell. Each present slot repeats the language-neutral media reference for
 * every configured locale; absent slots (or media-off) stay `{}`. Used by the expander to stamp
 * Module / Form / CaseList shells for the upload path.
 */
export function buildNavMediaDicts(
	icon: IconRef | undefined,
	audioLabel: MediaAssetId | undefined,
	manifest: AssetManifest | undefined,
	where: string,
	languages: readonly string[] = ["en"],
): NavMediaDicts {
	const media_image: Record<string, string> = {};
	const media_audio: Record<string, string> = {};
	if (manifest) {
		if (icon) {
			const ref = requireAssetRef(icon, manifest, where);
			for (const language of languages) media_image[language] = ref;
		}
		if (audioLabel) {
			const ref = requireAssetRef(audioLabel, manifest, where);
			for (const language of languages) media_audio[language] = ref;
		}
	}
	return { media_image, media_audio };
}

/** The local-suite nav node + the app_strings entries its media locales
 *  resolve against. `strings` is empty when the carrier has no media. */
export interface NavMenuNode {
	readonly node: Element;
	readonly strings: Record<string, string>;
}

/**
 * Build the first child of a `<menu>` / `<command>` — a bare
 * `<text><locale id="<textLocaleId>"/></text>` when the carrier has no
 * media, or a `<display>` wrapping that text plus `<text form="image|audio">`
 * media locales when it does. Returns the node alongside the app_strings
 * entries (`<mediaLocaleBase>.icon` / `<mediaLocaleBase>.audio` → jr://
 * path) the compiler must merge into its string table.
 *
 * `textLocaleId` is the locale of the text shown (`modules.m{N}` /
 * `forms.m{N}f{F}` / the case-list locale); `mediaLocaleBase` is the
 * carrier's own locale, which its media locales suffix with `.icon` /
 * `.audio`, matching CCHQ's `id_strings` scheme. The two differ only for a
 * submenu that shows its forms in a parent keeping its screen: its `<menu>`
 * shows the parent's name and keeps its own media locales
 * (`suite_xml/utils.py::get_module_locale_id`,
 * `id_strings.py::module_icon_locale`).
 */
export function buildNavMenuNode(
	textLocaleId: string,
	mediaLocaleBase: string,
	icon: IconRef | undefined,
	audioLabel: MediaAssetId | undefined,
	manifest: AssetManifest | undefined,
	where: string,
): NavMenuNode {
	const mainText = el("text", {}, [el("locale", { id: textLocaleId })]);
	const media = mediaTextsOf(
		mediaLocaleBase,
		icon,
		audioLabel,
		manifest,
		where,
	);
	if (media.texts.length === 0) {
		// No media — the carrier keeps the bare `<text>` child Nova has
		// always emitted; no `<display>` wrapper, no extra app_strings.
		return { node: mainText, strings: {} };
	}
	return {
		node: el("display", {}, [mainText, ...media.texts]),
		strings: media.strings,
	};
}

/**
 * The `<display>` of a case list action, the Register button: HQ's
 * `LocalizedAction` with `for_action_menu=True`
 * (`suite_xml/xml_models.py::TextOrDisplay`), which always wraps its text in
 * `<display>`, since an action has no bare `<text>` form. `labelLocaleId`
 * (`case_list_form.m{N}`) is also the base its media locales suffix
 * (`id_strings.py::case_list_form_icon_locale`, `case_list_form_audio_locale`).
 */
export function buildActionDisplay(
	labelLocaleId: string,
	icon: IconRef | undefined,
	audioLabel: MediaAssetId | undefined,
	manifest: AssetManifest | undefined,
	where: string,
): NavMenuNode {
	const media = mediaTextsOf(labelLocaleId, icon, audioLabel, manifest, where);
	return {
		node: el("display", {}, [
			el("text", {}, [el("locale", { id: labelLocaleId })]),
			...media.texts,
		]),
		strings: media.strings,
	};
}

/** The `<text form="image|audio">` children a carrier's media writes, with
 *  the app strings their locales resolve against. None without a manifest. */
function mediaTextsOf(
	mediaLocaleBase: string,
	icon: IconRef | undefined,
	audioLabel: MediaAssetId | undefined,
	manifest: AssetManifest | undefined,
	where: string,
): { readonly texts: Element[]; readonly strings: Record<string, string> } {
	const strings: Record<string, string> = {};
	const texts: Element[] = [];
	if (manifest === undefined) return { texts, strings };
	if (icon) {
		const iconLocale = `${mediaLocaleBase}.icon`;
		strings[iconLocale] = requireAssetRef(icon, manifest, where);
		texts.push(
			el("text", { form: "image" }, [el("locale", { id: iconLocale })]),
		);
	}
	if (audioLabel) {
		const audioLocale = `${mediaLocaleBase}.audio`;
		strings[audioLocale] = requireAssetRef(audioLabel, manifest, where);
		texts.push(
			el("text", { form: "audio" }, [el("locale", { id: audioLocale })]),
		);
	}
	return { texts, strings };
}
