import type { BlueprintDoc } from "./blueprint";
import type { IconRef } from "./builtinIcons";
import type { Field } from "./fields";
import type { EffectiveAppLocalization, LanguageTag } from "./localization";
import { MEDIA_KINDS, type Media, mediaInLanguage } from "./multimedia";
import {
	type NavigationMedia,
	navigationFilesInLanguage,
	storedNavigationFile,
} from "./navigationMedia";
import { ownRecordValue, recordFromEntries } from "./records";

/** Move canonical source ownership without changing the files a worker sees.
 * A previously stored omission still follows the form default after the move. */
function rebaseBundle(
	media: Media,
	source: LanguageTag,
	retained: readonly LanguageTag[],
	oldDefault: LanguageTag,
	newDefault: LanguageTag,
) {
	if (!media.mediaByLanguage) return;
	const actualOldDefault = media.formDefaultLanguage ?? oldDefault;
	const actualNewDefault =
		newDefault === oldDefault && retained.includes(actualOldDefault)
			? actualOldDefault
			: newDefault;
	const effective = new Map(
		retained.map((tag) => [tag, mediaInLanguage(media, tag, actualOldDefault)]),
	);
	const canonical = effective.get(source);
	if (!canonical) return;
	const previous = media.mediaByLanguage;
	const next: NonNullable<Media["mediaByLanguage"]> = recordFromEntries([]);
	for (const role of MEDIA_KINDS) {
		if (canonical[role]) media[role] = canonical[role];
		for (const [tag, shown] of effective) {
			const prior = ownRecordValue(previous, tag)?.[role];
			const inherited =
				prior === null &&
				tag !== actualNewDefault &&
				shown?.[role] === effective.get(actualNewDefault)?.[role];
			if (
				inherited ||
				(tag !== source && shown?.[role] && shown[role] !== canonical[role])
			) {
				next[tag] ??= {};
				next[tag][role] = inherited ? null : shown?.[role];
			}
		}
	}
	if (Object.keys(next).length) media.mediaByLanguage = next;
	else delete media.mediaByLanguage;
	if (media.mediaByLanguage && actualNewDefault !== newDefault)
		media.formDefaultLanguage = actualNewDefault;
	else delete media.formDefaultLanguage;
}

/** The caller owns the writable draft. Fields and choices are identified by UUID,
 * so changing a language cannot redirect media to a similarly named question. */
export function rebaseFormMediaLanguages(
	fields: Record<string, Field>,
	source: LanguageTag,
	retained: readonly LanguageTag[],
	oldDefault: LanguageTag,
	newDefault: LanguageTag,
): void {
	for (const field of Object.values(fields)) {
		if ("label_media" in field && field.label_media)
			rebaseBundle(field.label_media, source, retained, oldDefault, newDefault);
		if ("help_media" in field && field.help_media)
			rebaseBundle(field.help_media, source, retained, oldDefault, newDefault);
		if ("optionsSource" in field && field.optionsSource.kind === "inline") {
			for (const option of field.optionsSource.options)
				if (option.media)
					rebaseBundle(option.media, source, retained, oldDefault, newDefault);
		}
	}
}

/** Rebase only present navigation maps. Capture every retained strict reading
 * before changing the shared slot, including values supplied by an old code. */
export function rebaseNavigationMedia(
	doc: Pick<BlueprintDoc, "modules" | "forms">,
	before: EffectiveAppLocalization,
	source: LanguageTag,
	remaining: readonly LanguageTag[],
	relabelFrom?: LanguageTag,
): void {
	function rebase<T extends IconRef>(
		carrier: NavigationMedia<T> | undefined,
	): void {
		if (!carrier?.mediaByLanguage) return;
		const from = (tag: LanguageTag) =>
			relabelFrom && tag === source ? relabelFrom : tag;
		const shared = navigationFilesInLanguage(carrier, from(source), before);
		const shown = new Map(
			remaining.map((tag) => [
				tag,
				navigationFilesInLanguage(carrier, from(tag), before),
			]),
		);
		const next: NonNullable<NavigationMedia<T>["mediaByLanguage"]> =
			recordFromEntries([]);
		for (const tag of remaining) {
			const icon = storedNavigationFile(carrier, "icon", from(tag));
			const audioLabel = storedNavigationFile(carrier, "audioLabel", from(tag));
			if (icon === shared.icon && audioLabel === shared.audioLabel) continue;
			next[tag] = {
				...(icon !== shared.icon && { icon: icon ?? null }),
				...(audioLabel !== shared.audioLabel && {
					audioLabel: audioLabel ?? null,
				}),
			};
		}
		if (shared.icon) carrier.icon = shared.icon;
		else delete carrier.icon;
		if (shared.audioLabel) carrier.audioLabel = shared.audioLabel;
		else delete carrier.audioLabel;
		carrier.mediaByLanguage = next;
		const after = { ...before, languageOrder: [...remaining] };
		const projected = new Map(
			remaining.map((tag) => [
				tag,
				navigationFilesInLanguage(carrier, tag, after),
			]),
		);
		for (const [tag, previous] of shown) {
			const current = projected.get(tag);
			if (previous.icon && current?.icon !== previous.icon) {
				next[tag] ??= {};
				next[tag].icon = previous.icon;
			}
			if (previous.audioLabel && current?.audioLabel !== previous.audioLabel) {
				next[tag] ??= {};
				next[tag].audioLabel = previous.audioLabel;
			}
		}
		if (!Object.keys(next).length) delete carrier.mediaByLanguage;
	}
	for (const mod of Object.values(doc.modules)) {
		rebase(mod);
		rebase(mod.caseListMenuItem);
		if (mod.caseListRegistrationForm?.kind === "always")
			rebase(mod.caseListRegistrationForm);
	}
	for (const form of Object.values(doc.forms)) rebase(form);
}
