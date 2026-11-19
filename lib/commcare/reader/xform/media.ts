/**
 * Media on a text: the `image`, `audio` and `video` values of a text on
 * the slots Nova holds media for (a question's label, its help, an inline
 * choice), and the same rule for a map of paths by language, which the menu
 * and list readers call. A file must be one in every app language, read as
 * each language shows it (a language with no media form of its own shows the
 * form's default language's, a map is read as HQ's build shows it): one
 * path, or several paths the media index resolves to one asset,
 * which is one file CommCare HQ holds under several names (a Nova document
 * holds the asset, and its publish keeps one of the paths,
 * `media-paths-joined`). Its file is the media index's to answer: an asset
 * fills the slot and is listed at every path that names it; a path with no
 * file is handed off to project data with its node, since which entry it
 * stands under is project data's rule.
 */

import type { Element } from "domhandler";
import type { LanguageTag, MediaKind } from "@/lib/domain";
import type { HqPlace } from "@/lib/publish/hqFindings";
import type { ClaimSite } from "../accounting";
import { applicationReading } from "../appShell";
import type { Claim } from "../claims";
import type { ReadContext } from "../context";
import { shownText } from "../hqText";
import { ownText, type XmlCursor } from "../xmlCursor";
import { X } from "./claims";
import type { ReadXForm } from "./index";
import { claimFormValue, formText, type SlotText, valueIsBlank } from "./prose";

const MEDIA_KINDS: readonly MediaKind[] = ["image", "audio", "video"];

/** The one asset every one of several paths resolves to, or undefined where one does not
 *  resolve to an asset or two resolve to two. */
function oneAsset(
	ctx: ReadContext,
	paths: readonly string[],
): { readonly assetId: string; readonly mediaKind: MediaKind } | undefined {
	let found: { assetId: string; mediaKind: MediaKind } | undefined;
	for (const path of paths) {
		const resolution = ctx.input.media.resolve(path);
		if (resolution.kind !== "asset") return undefined;
		if (found !== undefined && found.assetId !== resolution.assetId)
			return undefined;
		found = { assetId: resolution.assetId, mediaKind: resolution.mediaKind };
	}
	return found;
}

/** The slot string of `ReadMediaReference.slot` for a held slot of a field's text. */
function slotString(holding: SlotText["media"]): string {
	return holding === "option_media" ? "option_media" : "field_media_bundle";
}

/** The claim a held slot takes on each language's value of a media kind. */
function heldClaim(holding: SlotText["media"], kind: MediaKind): Claim<"take"> {
	if (holding === "help_media") return X.helpMedia[kind];
	if (holding === "option_media")
		return kind === "image" ? X.choiceImage.image : X.choiceAudioVideo[kind];
	return X.labelMedia[kind];
}

/** The claim an unheld slot's media takes where its file is there. */
function unheldClaim(slot: SlotText, kind: MediaKind): Claim<"account"> {
	if (slot.owner.slot === "hint") return X.hintMedia[kind];
	if (slot.owner.slot === "validate_msg") return X.validationMedia[kind];
	return X.groupMedia[kind];
}

/** Puts an asset in a slot's media on its draft. */
function setMedia(slot: SlotText, kind: MediaKind, assetId: string): void {
	const field = slot.owner.field.field;
	if (slot.media === "option_media") {
		const option = (
			field.optionsSource as { options?: Record<string, unknown>[] } | undefined
		)?.options?.[slot.owner.option ?? -1];
		if (option !== undefined)
			option.media = {
				...(option.media as object | undefined),
				[kind]: assetId,
			};
		return;
	}
	const key = slot.media === "help_media" ? "help_media" : "label_media";
	field[key] = { ...(field[key] as object | undefined), [kind]: assetId };
}

/**
 * Reads the media forms of one text for one slot. Each slot that references the text reads its
 * media as its own; the first claims the values, makes the hand-offs and lists the references,
 * and a later slot raises its own finding where the media is refused.
 */
function readSlotMedia(
	ctx: ReadContext,
	cursor: XmlCursor,
	slot: SlotText,
	defaultLanguage: LanguageTag | undefined,
): void {
	const place = slot.place;
	const first = slot.first;
	for (const kind of MEDIA_KINDS) {
		const values = new Map<LanguageTag, Element>();
		for (const [language, forms] of slot.forms) {
			const value = forms.get(kind);
			if (value !== undefined) values.set(language, value);
		}
		if (values.size === 0) continue;
		const key = `itext-form:core/${kind}`;
		if (first)
			for (const value of values.values())
				claimFormValue(ctx.accounting, value, place);
		if (slot.media === "refused") {
			if (first)
				for (const value of values.values())
					cursor.refuseSubtree(value, X.helpMediaOnCapture[kind], place);
			else ctx.accounting.finding(X.helpMediaOnCapture[kind], place);
			continue;
		}
		if (slot.media === "unheld") {
			if (!first) continue;
			for (const value of values.values()) {
				const path = ownText(value).trim();
				const resolution = ctx.input.media.resolve(path);
				if (resolution.kind === "asset") {
					cursor.accountSubtree(value, unheldClaim(slot, kind), place);
					continue;
				}
				cursor.handOffSubtree(value, "media-reference", path, key);
				ctx.facts.pendingMedia.push({
					path,
					mediaKind: kind,
					resolution: resolution.kind,
					place,
					slot: "unheld_itext",
				});
			}
			continue;
		}
		const paths = [
			...new Set([...values.values()].map((value) => ownText(value).trim())),
		];
		const joined = paths.length === 1 ? undefined : oneAsset(ctx, paths);
		// A language whose text holds no form of the kind, or no text, shows the form's default
		// language's, since Core loads the default locale's keys under every locale
		// (`Localizer.getLocaleData`) and shows the default locale in a language the form holds
		// no translation of (`FormDef.initLocale`); so the paths shown are the paths held. A form
		// the default language lacks is a key Core refuses when it loads the language that holds
		// it, so it differs.
		if (
			defaultLanguage === undefined ||
			!values.has(defaultLanguage) ||
			(paths.length !== 1 && joined === undefined)
		) {
			if (first)
				for (const value of values.values())
					cursor.refuseSubtree(value, X.mediaDiffering[kind], place);
			else ctx.accounting.finding(X.mediaDiffering[kind], place);
			continue;
		}
		const hold = (asset: {
			readonly assetId: string;
			readonly mediaKind: MediaKind;
		}) => {
			if (first)
				for (const value of values.values())
					cursor.takeSubtree(value, heldClaim(slot.media, kind)).value;
			setMedia(slot, kind, asset.assetId);
			for (const one of paths)
				ctx.facts.mediaReferences.push({
					path: one,
					assetId: asset.assetId,
					mediaKind: kind,
					place,
					slot: slotString(slot.media),
				});
		};
		if (joined !== undefined) {
			hold(joined);
			continue;
		}
		const path = paths[0] as string;
		const resolution = ctx.input.media.resolve(path);
		if (resolution.kind === "asset") {
			hold(resolution);
			continue;
		}
		if (first)
			for (const value of values.values())
				cursor.handOffSubtree(value, "media-reference", path, key);
		ctx.facts.pendingMedia.push({
			path,
			mediaKind: kind,
			resolution: resolution.kind,
			place,
			slot: slotString(slot.media),
		});
	}
}

/** Whether a choice's slot shows nothing: its label blank in every language, and no media form
 *  in any. A media form whose file is missing is project data's to settle, by its hand-off. */
function emptyChoice(slot: SlotText): boolean {
	if (slot.media !== "option_media" || slot.refused) return false;
	if (![...slot.values.values()].every(valueIsBlank)) return false;
	return [...slot.forms.values()].every((forms) =>
		MEDIA_KINDS.every((kind) => forms.get(kind) === undefined),
	);
}

/**
 * Reads the media forms of every text of a form, for every slot that references it: a
 * question's label and help media and a choice's into their slots, and the media of a hint, a
 * validation message or a container's label, which no slot holds, accounted where its file is
 * there and handed off where it is not. A choice that then shows nothing, no label in any
 * language and no media, is the item CommCare HQ's form builder cannot keep: refused at the
 * question.
 */
export function readMediaForms(ctx: ReadContext, form: ReadXForm): void {
	const text = formText(form);
	if (text === undefined) return;
	for (const slot of text.slots) {
		readSlotMedia(ctx, text.cursor, slot, text.itext.defaultLanguage);
		if (emptyChoice(slot))
			ctx.accounting.finding(
				slot.owner.field.control?.tag === "select"
					? X.choiceMissingValue.selectItem
					: X.choiceMissingValue.select1Item,
				slot.place,
			);
	}
}

/** The one file of a `{ lang: path }` map, resolved: one shared path, or several paths the
 *  media index resolves to one asset; or why there is none. */
export function readMediaMap(
	ctx: ReadContext,
	byLanguage: unknown,
	at: {
		readonly site: ClaimSite;
		readonly place: HqPlace;
		readonly slot: string;
		readonly mediaKind: MediaKind;
	},
):
	| { readonly kind: "asset"; readonly assetId: string }
	| { readonly kind: "none" }
	| { readonly kind: "handed-off" }
	| { readonly kind: "differs" } {
	// Each app language's path is the one HQ's build shows there (`hqText.ts::shownText`): a
	// language the map lacks, or holds blank, shows another language's path, so a map is read
	// as built and never taken literally. A caller that reads a map by another rule
	// (`menus/navMedia.ts::shownNavMedia`) passes the path every language shows, which this
	// rule reads as it is.
	const codes = applicationReading(ctx)?.languages.codes ?? [];
	const shown: string[] = [];
	for (const code of codes) {
		const one = shownText(byLanguage, code, codes);
		if (!one.ok) return { kind: "differs" };
		shown.push(one.text);
	}
	if (shown.every((path) => path === "")) return { kind: "none" };
	// A language that shows no file beside one that shows a file differs, as two files do.
	if (shown.includes("")) return { kind: "differs" };
	const paths = [...new Set(shown)];
	const hold = (asset: {
		readonly assetId: string;
		readonly mediaKind: MediaKind;
	}) => {
		for (const path of paths)
			ctx.facts.mediaReferences.push({
				path,
				assetId: asset.assetId,
				mediaKind: at.mediaKind,
				place: at.place,
				slot: at.slot,
			});
		return { kind: "asset", assetId: asset.assetId } as const;
	};
	// Several paths are one file where the media index gives every one the same asset.
	if (paths.length !== 1) {
		const joined = oneAsset(ctx, paths);
		return joined === undefined ? { kind: "differs" } : hold(joined);
	}
	const path = paths[0] as string;
	const resolution = ctx.input.media.resolve(path);
	if (resolution.kind === "asset") return hold(resolution);
	ctx.accounting.handOffAt(at.site, "media-reference", path);
	ctx.facts.pendingMedia.push({
		path,
		mediaKind: at.mediaKind,
		resolution: resolution.kind,
		place: at.place,
		slot: at.slot,
	});
	return { kind: "handed-off" };
}
