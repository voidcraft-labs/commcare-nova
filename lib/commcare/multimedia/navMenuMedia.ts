// lib/commcare/multimedia/navMenuMedia.ts
//
// Menu-item media — the icon + audio on a module home tile, a form
// command, and a case-list link. Two wire surfaces, both fed from the
// carrier's `icon` / `audioLabel` `AssetId` slots:
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
import { type AssetManifest, requireAssetRef } from "./assetWirePath";

/**
 * Nova's single authoring language. CommCare's media dicts are keyed by
 * language code; Nova is single-language throughout (the XForm builder
 * hardcodes `lang="en"`, field text is a plain string not a lang-map),
 * so every stamped dict uses this one key. Per-language media rides
 * whatever plan migrates Nova's labels to a lang-map model.
 */
const NOVA_LANG = "en";

/** The HQ-shell media dicts a carrier needs stamped. Empty objects when
 *  the carrier has no media — matching the shell's default and the
 *  `media_image: {}` shape CCHQ accepts. */
export interface NavMediaDicts {
	readonly media_image: Record<string, string>;
	readonly media_audio: Record<string, string>;
}

/**
 * Build the `media_image` / `media_audio` dicts for a nav carrier's HQ
 * shell. Each present slot becomes a `{ en: "jr://file/..." }` entry;
 * absent slots (or media-off) stay `{}`. Used by the expander to stamp
 * Module / Form / CaseList shells for the upload path.
 */
export function buildNavMediaDicts(
	icon: string | undefined,
	audioLabel: string | undefined,
	manifest: AssetManifest | undefined,
	where: string,
): NavMediaDicts {
	const media_image: Record<string, string> = {};
	const media_audio: Record<string, string> = {};
	if (manifest) {
		if (icon) media_image[NOVA_LANG] = requireAssetRef(icon, manifest, where);
		if (audioLabel)
			media_audio[NOVA_LANG] = requireAssetRef(audioLabel, manifest, where);
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
 * `<text><locale id="<base>"/></text>` when the carrier has no media,
 * or a `<display>` wrapping that text plus `<text form="image|audio">`
 * media locales when it does. Returns the node alongside the
 * app_strings entries (`<base>.icon` / `<base>.audio` → jr:// path) the
 * compiler must merge into its string table.
 *
 * `baseLocaleId` is the carrier's existing text locale id
 * (`modules.m{N}` / `forms.m{N}f{F}` / the case-list locale); the media
 * locales suffix it with `.icon` / `.audio`, matching CCHQ's
 * `id_strings` scheme.
 */
export function buildNavMenuNode(
	baseLocaleId: string,
	icon: string | undefined,
	audioLabel: string | undefined,
	manifest: AssetManifest | undefined,
	where: string,
): NavMenuNode {
	const mainText = el("text", {}, [el("locale", { id: baseLocaleId })]);

	const iconRef =
		manifest && icon ? requireAssetRef(icon, manifest, where) : undefined;
	const audioRef =
		manifest && audioLabel
			? requireAssetRef(audioLabel, manifest, where)
			: undefined;

	if (!iconRef && !audioRef) {
		// No media — the carrier keeps the bare `<text>` child Nova has
		// always emitted; no `<display>` wrapper, no extra app_strings.
		return { node: mainText, strings: {} };
	}

	const strings: Record<string, string> = {};
	const mediaTexts: Element[] = [];
	if (iconRef) {
		const iconLocale = `${baseLocaleId}.icon`;
		strings[iconLocale] = iconRef;
		mediaTexts.push(
			el("text", { form: "image" }, [el("locale", { id: iconLocale })]),
		);
	}
	if (audioRef) {
		const audioLocale = `${baseLocaleId}.audio`;
		strings[audioLocale] = audioRef;
		mediaTexts.push(
			el("text", { form: "audio" }, [el("locale", { id: audioLocale })]),
		);
	}

	return {
		node: el("display", {}, [mainText, ...mediaTexts]),
		strings,
	};
}
