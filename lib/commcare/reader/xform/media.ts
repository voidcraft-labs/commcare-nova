/**
 * Media on a text (12.4): the `image`, `audio` and `video` values of a text on
 * the slots Nova holds media for (a question's label, its help, an inline
 * choice), and the same rule for a map of paths by language, which the menu
 * and list readers call. A path must be one in every app language that holds
 * the text. Its file is the media index's to answer: an asset fills the slot
 * and is listed; a path with no file is handed off to project data with its
 * node, since which entry it stands under is project data's rule.
 */

import type { Element } from "domhandler";
import type { LanguageTag, MediaKind } from "@/lib/domain";
import type { HqPlace } from "@/lib/publish/hqFindings";
import type { ClaimSite } from "../accounting";
import { applicationReading } from "../appShell";
import type { Claim } from "../claims";
import type { ReadContext } from "../context";
import { ownText, type XmlCursor } from "../xmlCursor";
import { X } from "./claims";
import type { ReadXForm } from "./index";
import { formText, type SlotText } from "./prose";

const MEDIA_KINDS: readonly MediaKind[] = ["image", "audio", "video"];

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

/** Reads the media forms of one text a slot claims. */
function readSlotMedia(
	ctx: ReadContext,
	cursor: XmlCursor,
	slot: SlotText,
): void {
	const place = slot.place;
	for (const kind of MEDIA_KINDS) {
		const values = new Map<LanguageTag, Element>();
		for (const [language, forms] of slot.forms) {
			const value = forms.get(kind);
			if (value !== undefined) values.set(language, value);
		}
		if (values.size === 0) continue;
		const key = `itext-form:core/${kind}`;
		if (slot.media === "refused") {
			for (const value of values.values())
				cursor.refuseSubtree(value, X.helpMediaOnCapture[kind], place);
			continue;
		}
		if (slot.media === "unheld") {
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
		const paths = new Set(
			[...values.values()].map((value) => ownText(value).trim()),
		);
		if (values.size !== slot.forms.size || paths.size !== 1) {
			for (const value of values.values())
				cursor.refuseSubtree(value, X.mediaDiffering[kind], place);
			continue;
		}
		const path = [...paths][0] as string;
		const resolution = ctx.input.media.resolve(path);
		if (resolution.kind === "asset") {
			for (const value of values.values())
				cursor.takeSubtree(value, heldClaim(slot.media, kind)).value;
			setMedia(slot, kind, resolution.assetId);
			ctx.facts.mediaReferences.push({
				path,
				assetId: resolution.assetId,
				mediaKind: resolution.mediaKind,
				place,
				slot: slotString(slot.media),
			});
			continue;
		}
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

/**
 * Reads the media forms of every text of a form, once per text: a question's label and help
 * media and a choice's into their slots, and the media of a hint, a validation message or a
 * container's label, which no slot holds, accounted where its file is there and handed off
 * where it is not.
 */
export function readMediaForms(ctx: ReadContext, form: ReadXForm): void {
	const text = formText(form);
	if (text === undefined) return;
	for (const slot of text.slots)
		if (slot.first) readSlotMedia(ctx, text.cursor, slot);
}

/** One shared path of a `{ lang: path }` map, resolved; or why there is none. */
export function readMediaMap(
	ctx: ReadContext,
	byLanguage: Readonly<Record<string, string>>,
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
	const codes = applicationReading(ctx)?.languages.codes;
	const held = Object.entries(byLanguage).filter(
		([language, path]) =>
			typeof path === "string" &&
			path !== "" &&
			(codes === undefined || codes.includes(language)),
	);
	if (held.length === 0) return { kind: "none" };
	const paths = new Set(held.map(([, path]) => path));
	if (paths.size !== 1) return { kind: "differs" };
	const path = held[0]?.[1] as string;
	const resolution = ctx.input.media.resolve(path);
	if (resolution.kind === "asset") {
		ctx.facts.mediaReferences.push({
			path,
			assetId: resolution.assetId,
			mediaKind: resolution.mediaKind,
			place: at.place,
			slot: at.slot,
		});
		return { kind: "asset", assetId: resolution.assetId };
	}
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
