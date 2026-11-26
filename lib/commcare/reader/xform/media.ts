import { isCaptureFieldKind } from "@/lib/domain/fields";
/**
 * Media on a text: the `image`, `audio` and `video` values of a text on
 * the slots Nova holds media for (a question's label, its help, an inline
 * choice). A language can have its own Project file or inherit the form's
 * default file. Two paths can also name the same asset: the document holds
 * that identity and the deployment accounts for both paths. Lists use their
 * independent shared-file reader below; navigation uses menus/navMedia.ts. Its file is the media index's to answer: an asset
 * fills the slot and is listed at every path that names it; a path with no
 * file is handed off to project data with its node, since which entry it
 * stands under is project data's rule.
 */

import { type Element, isTag } from "domhandler";
import type { LanguageTag, MediaKind, MediaRole } from "@/lib/domain";
import {
	NO_ENTRIES,
	recordFromEntries,
	recordWithValue,
} from "@/lib/domain/records";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { el, text as textNode } from "../../elementBuilders";
import type { NamespaceScope } from "../../xmlNamespaces";
import type { ClaimSite } from "../accounting";
import { applicationReading } from "../appShell";
import type { Claim } from "../claims";
import type { ReadContext } from "../context";
import { shownText } from "../hqText";
import { pointerToken } from "../jsonCursor";
import { builtScopes, sameElementWhole } from "../sameElement";
import type { ItextRecipient, ReadFacts } from "../types";
import { ownText, type XmlCursor } from "../xmlCursor";
import { X } from "./claims";
import type { ReadXForm } from "./index";
import { type ItextReading, itextRecipient } from "./itext";
import { claimFormValue, formText, type SlotText, valueIsBlank } from "./prose";

const MEDIA_KINDS: readonly MediaKind[] = ["image", "audio", "video"];

/** The media forms a slot's text is read for: each role of a `Media` bundle, the kind of file
 *  it plays, and the `form` its values name. Inline video plays on a question label.
 *  Another text's inline video goes through first-publish review as unshown media. */
const MEDIA_FORM_ROLES: readonly {
	readonly role: MediaRole;
	readonly kind: MediaKind;
	readonly form: MediaKind | "video-inline";
}[] = [
	{ role: "image", kind: "image", form: "image" },
	{ role: "audio", kind: "audio", form: "audio" },
	{ role: "video", kind: "video", form: "video" },
	{ role: "videoInline", kind: "video", form: "video-inline" },
];

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

/** The claim a held slot takes on each language's value of a media role. */
function heldClaim(slot: SlotText, role: MediaRole): Claim<"take"> {
	if (role === "videoInline") return X.videoInline.held;
	const kind = role;
	const holding = slot.media;
	if (
		holding === "help_media" &&
		(slot.owner.field.kind === "label" ||
			isCaptureFieldKind(slot.owner.field.kind))
	)
		return X.helpMediaOnCapture[kind];
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

/**
 * Whether a stored media value is the one Nova's emitter writes for the path read from it
 * (`multimedia/itextMedia.ts::itextMediaValues`): `form` naming its kind and no other attribute,
 * and the path its only content. Core reads a value's content whole (an `<output>` in it makes
 * the path), while the path is read from its text, so a value holding more is no media Nova
 * holds, and is left for the close to report.
 */
function emitterMediaValue(
	value: Element,
	form: string,
	scope: (element: Element) => NamespaceScope,
): boolean {
	const built = el("value", { form }, [textNode(ownText(value).trim())]);
	const parent = value.parent;
	const outer =
		parent !== null && isTag(parent)
			? scope(parent)
			: new Map<string, string>();
	return sameElementWhole(value, scope, built, builtScopes(built, outer));
}

/** Drafts may still contain temporary asset identities while bring-in prepares its files. */
function setMedia(
	slot: SlotText,
	role: MediaRole,
	shared: string,
	byLanguage: ReadonlyMap<LanguageTag, string | null>,
	defaultLanguage?: LanguageTag,
): void {
	const field = slot.owner.field.field;
	const option =
		slot.media === "option_media"
			? (
					field.optionsSource as
						| { options?: Record<string, unknown>[] }
						| undefined
				)?.options?.[slot.owner.option ?? -1]
			: undefined;
	const carrier = slot.media === "option_media" ? option : field;
	if (!carrier) return;
	const key =
		slot.media === "option_media"
			? "media"
			: slot.media === "help_media"
				? "help_media"
				: "label_media";
	const previous = (carrier[key] ?? NO_ENTRIES) as Record<string, unknown>;
	const localized = recordFromEntries(
		Object.entries(
			(previous.mediaByLanguage ?? NO_ENTRIES) as Record<
				string,
				Record<string, unknown>
			>,
		),
	);
	for (const [language, asset] of byLanguage)
		localized[language] = recordWithValue<unknown>(
			localized[language],
			role,
			asset,
		);
	carrier[key] = {
		...recordWithValue<unknown>(previous, role, shared),
		...(Object.keys(localized).length && { mediaByLanguage: localized }),
		...(defaultLanguage && { formDefaultLanguage: defaultLanguage }),
	};
}

/** The exact source comparison path of an unshown media recipient. */
function unshownRole(
	recipient: ItextRecipient,
): ReadFacts["unheldMedia"][number]["role"] {
	switch (recipient.slot) {
		case "option_label":
			if (recipient.choiceValue === null)
				throw new Error(
					"A choice's unshown media reached the reader without its value.",
				);
			return ["item", recipient.choiceValue];
		case "validate_msg":
			return ["constraintMsg"];
		case "addFirstLabel":
			return ["add-empty-caption"];
		case "addLabel":
			return ["add-caption"];
		default:
			return [recipient.slot];
	}
}

/**
 * Reads the media forms of one text for one slot. Each slot that references the text reads its
 * media as its own. Each slot records its use and raises its own finding where refused. The
 * first owner claims or hands off the shared XML values once.
 */
function readSlotMedia(
	ctx: ReadContext,
	cursor: XmlCursor,
	slot: SlotText,
	itext: Pick<ItextReading, "languages" | "defaultLanguage" | "source">,
	scope: (element: Element) => NamespaceScope,
): void {
	const { defaultLanguage, languages, source } = itext;
	const place = slot.place;
	const first = slot.first;
	for (const { role, kind, form } of MEDIA_FORM_ROLES) {
		const inline = role === "videoInline";
		const unshownInline = inline && slot.media !== "label_media";
		const values = new Map<LanguageTag, Element>();
		for (const [language, forms] of slot.forms) {
			const value = forms.get(form);
			if (value !== undefined) values.set(language, value);
		}
		if (values.size === 0) continue;
		// Core overlays each translation on the default's keys. A file under
		// a nondefault key supplies its own language only.
		const defaultValue =
			defaultLanguage === undefined ? undefined : values.get(defaultLanguage);
		const inherited =
			defaultValue === undefined
				? []
				: languages
						.filter((language) => !values.has(language))
						.map((language) => itextRecipient(slot.owner, language));
		const inheritedAt = (isDefault: boolean) =>
			isDefault && inherited.length
				? { inheritedItextRecipients: inherited }
				: {};
		const key = inline
			? "itext-form:android/video-inline"
			: `itext-form:core/${kind}`;
		if (first)
			for (const value of values.values())
				claimFormValue(ctx.accounting, value, place);
		if (unshownInline && slot.helpOnlyInlineVideo) {
			let hasInlineValue = false;
			for (const value of values.values()) {
				if (!emitterMediaValue(value, form, scope)) continue;
				hasInlineValue = true;
				if (first) cursor.refuseSubtree(value, X.videoInlineOnlyHelp, place);
			}
			if (!first && hasInlineValue)
				ctx.accounting.finding(X.videoInlineOnlyHelp, place);
			continue;
		}
		if (slot.media === "unheld" || unshownInline) {
			for (const [language, value] of values) {
				if (unshownInline && !emitterMediaValue(value, form, scope)) continue;
				const recipient = itextRecipient(slot.owner, language);
				const path = ownText(value).trim();
				const resolution = ctx.input.media.resolve(path);
				if (resolution.kind === "asset") {
					if (first)
						cursor.accountSubtree(
							value,
							unshownInline ? X.videoInlineElsewhere : unheldClaim(slot, kind),
							place,
						);
					const translation = value.parent?.parent;
					if (
						!translation ||
						!isTag(translation) ||
						translation.attribs.lang === undefined
					)
						throw new Error(
							"The itext reader returned a media value outside its translation.",
						);
					ctx.facts.unheldMedia.push({
						path,
						mediaKind: kind,
						place,
						slot: "unheld_itext",
						itextRecipients: [recipient],
						...inheritedAt(value === defaultValue),
						languageCode: translation.attribs.lang,
						form,
						role: unshownRole(recipient),
					});
					continue;
				}
				if (first) cursor.handOffSubtree(value, "media-reference", path, key);
				ctx.facts.pendingMedia.push({
					path,
					mediaKind: kind,
					resolution: resolution.kind,
					place,
					slot: "unheld_itext",
					itextRecipients: [itextRecipient(slot.owner, language)],
					...inheritedAt(value === defaultValue),
				});
			}
			continue;
		}
		if (
			[...values.values()].some(
				(value) => !emitterMediaValue(value, form, scope),
			)
		)
			continue;
		const recipients = new Map<string, ReturnType<typeof itextRecipient>[]>();
		for (const [language, value] of values) {
			const path = ownText(value).trim();
			const at = recipients.get(path) ?? [];
			at.push(itextRecipient(slot.owner, language));
			recipients.set(path, at);
		}
		const defaultPath = defaultValue && ownText(defaultValue).trim();
		// Core loads the default locale's keys under every locale
		// (`Localizer.getLocaleData`), so a language with no form of this kind
		// shows the form default's file. A form the default language lacks is a
		// key Core refuses when it loads the language that holds it.
		if (
			defaultLanguage === undefined ||
			!values.has(defaultLanguage) ||
			source === undefined
		) {
			const claim = inline
				? X.videoInline.missingDefault
				: X.mediaMissingDefault[kind];
			if (first)
				for (const value of values.values())
					cursor.refuseSubtree(value, claim, place);
			else ctx.accounting.finding(claim, place);
			continue;
		}
		// Core stores an explicitly empty value as a key containing an empty
		// string. Vellum fills that value when saving a role that has a file in
		// another language. Such a save would change what a worker sees.
		const populated = [...values.values()].filter(
			(value) => ownText(value).trim() !== "",
		);
		if (populated.length && populated.length < values.size) {
			const claim = inline
				? X.videoInline.blankBesideFile
				: X.mediaBlankBesideFile[kind];
			if (first)
				for (const value of values.values())
					cursor.refuseSubtree(value, claim, place);
			else ctx.accounting.finding(claim, place);
			continue;
		}
		const assets = new Map<LanguageTag, string>();
		const paths = new Map<string, string>();
		const missing = new Set<string>();
		for (const [language, value] of values) {
			const path = ownText(value).trim();
			const resolution = ctx.input.media.resolve(path);
			if (resolution.kind === "asset") {
				assets.set(language, resolution.assetId);
				paths.set(path, resolution.assetId);
			} else {
				if (first) cursor.handOffSubtree(value, "media-reference", path, key);
				if (!missing.has(path))
					ctx.facts.pendingMedia.push({
						path,
						mediaKind: kind,
						resolution: resolution.kind,
						itextRecipients: recipients.get(path),
						...inheritedAt(path === defaultPath),
						place,
						slot: slotString(slot.media),
					});
				missing.add(path);
			}
		}
		const distinct = new Set(assets.values()).size > 1;
		if (first) {
			const claim = distinct
				? inline
					? X.videoInline.differing
					: X.mediaDiffering[kind]
				: heldClaim(slot, role);
			for (const [language, value] of values)
				if (assets.has(language)) cursor.takeSubtree(value, claim).value;
		}
		for (const [path, assetId] of paths)
			ctx.facts.mediaReferences.push({
				path,
				itextRecipients: recipients.get(path),
				...inheritedAt(path === defaultPath),
				assetId,
				mediaKind: kind,
				place,
				slot: slotString(slot.media),
			});
		const defaultFile = assets.get(defaultLanguage);
		if (missing.size || defaultFile === undefined) continue;
		const shared = assets.get(source) ?? defaultFile;
		// A language whose text holds no value of this kind keeps inheriting
		// the form default's file (null), so a publish writes what HQ's source
		// holds and a build that changes the default shows what HQ's would. A
		// language the text is missing from shows the default too; it needs
		// the mark only where the shared file is another.
		const translated = new Map<LanguageTag, string | null>();
		for (const language of languages) {
			const own = assets.get(language);
			if (own !== undefined && own !== shared) translated.set(language, own);
			else if (
				own === undefined &&
				(slot.forms.has(language) || shared !== defaultFile)
			)
				translated.set(language, null);
		}
		setMedia(
			slot,
			role,
			shared,
			translated,
			translated.size && defaultLanguage !== languages[0]
				? defaultLanguage
				: undefined,
		);
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
		readSlotMedia(ctx, text.cursor, slot, text.itext, form.parsed.scope);
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
	const languagesByPath = new Map<string, string[]>();
	for (const code of codes) {
		const one = shownText(byLanguage, code, codes);
		if (!one.ok) return { kind: "differs" };
		const languages = languagesByPath.get(one.text) ?? [];
		languages.push(code);
		languagesByPath.set(one.text, languages);
	}
	const paths = [...languagesByPath.keys()];
	if (paths.every((path) => path === "")) return { kind: "none" };
	// A language that shows no file beside one that shows a file differs, as two files do.
	if (languagesByPath.has("")) return { kind: "differs" };
	for (const languages of languagesByPath.values()) languages.sort();
	const pointer =
		"json" in at.site
			? `${at.site.json.pointer}/${pointerToken(at.site.key)}`
			: undefined;
	const hold = (asset: {
		readonly assetId: string;
		readonly mediaKind: MediaKind;
	}) => {
		for (const path of paths)
			ctx.facts.mediaReferences.push({
				path,
				shownLanguages: languagesByPath.get(path),
				assetId: asset.assetId,
				mediaKind: at.mediaKind,
				place: at.place,
				...(pointer !== undefined && { pointer }),
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
		...(pointer !== undefined && { pointer }),
		slot: at.slot,
		shownLanguages: languagesByPath.get(path),
	});
	return { kind: "handed-off" };
}
