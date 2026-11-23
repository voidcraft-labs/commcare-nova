import { z } from "zod";
import type { IconRef } from "./builtinIcons";
import {
	type EffectiveAppLocalization,
	languageTagSchema,
	languageWireCodeSchema,
} from "./localization";
import { type MediaAssetId, mediaAssetIdSchema } from "./multimedia";
import { ownRecordSchema, ownRecordValue, recordWithValue } from "./records";

/** An omitted language slot takes the shared file. A sparse menu imported from
 * a project keeps the difference between a missing entry and an empty one, as
 * they can choose different files when an installation has fewer languages. */
export function navigationMediaSchema<T extends IconRef>(
	icon: z.ZodType<T>,
	key: z.ZodType<string> = languageTagSchema,
) {
	return ownRecordSchema(key, navigationLanguageEntrySchema(icon));
}

export function navigationLanguageEntrySchema<T extends IconRef>(
	icon: z.ZodType<T>,
) {
	return z.strictObject({
		icon: z
			.union([icon, z.literal("blank")])
			.nullable()
			.optional(),
		audioLabel: z
			.union([mediaAssetIdSchema, z.literal("blank")])
			.nullable()
			.optional(),
	});
}

/** An earlier language code can still choose a visible file in the full app.
 * A build limited to named languages skips these historical candidates. */
export function formerNavigationMediaSchema<T extends IconRef>(
	icon: z.ZodType<T>,
) {
	return navigationMediaSchema(icon, languageWireCodeSchema);
}

export interface NavigationMedia<T extends IconRef = IconRef> {
	icon?: T;
	audioLabel?: MediaAssetId;
	mediaByLanguage?: Record<
		string,
		{ icon?: T | "blank" | null; audioLabel?: MediaAssetId | "blank" | null }
	>;
	mediaByFormerCode?: Record<
		string,
		{ icon?: T | "blank" | null; audioLabel?: MediaAssetId | "blank" | null }
	>;
}

export function storedNavigationFile<
	T extends IconRef,
	K extends "icon" | "audioLabel",
>(carrier: NavigationMedia<T>, key: K, language: string) {
	const localized = ownRecordValue(carrier.mediaByLanguage, language)?.[key];
	return localized === undefined ? carrier[key] : localized;
}

/** Choose the files a worker sees for one installation. An explicitly empty
 * entry can be first in the ordered fallback candidates and contribute no file.
 * The first language with a usable loose reading supplies the default table. */
export function navigationFilesInLanguage<T extends IconRef>(
	carrier: NavigationMedia<T>,
	language: string,
	app: EffectiveAppLocalization,
	profileLanguages?: readonly string[],
): Pick<NavigationMedia<T>, "icon" | "audioLabel"> {
	if (!carrier.mediaByLanguage && !carrier.mediaByFormerCode)
		return { icon: carrier.icon, audioLabel: carrier.audioLabel };
	const installed = profileLanguages ?? app.languageOrder;
	function shown<K extends "icon" | "audioLabel">(
		key: K,
	): NavigationMedia<T>[K] {
		const read = (tag: string) => storedNavigationFile(carrier, key, tag);
		const file = (raw: ReturnType<typeof read>) =>
			raw == null || raw === "blank" ? undefined : raw;
		if (!installed.some((tag) => file(read(tag)))) return undefined;
		const direct = file(read(language));
		if (direct) return direct as NavigationMedia<T>[K];
		const choices = new Map<string, ReturnType<typeof read>>();
		if (!profileLanguages)
			for (const [code, slots] of Object.entries(
				carrier.mediaByFormerCode ?? {},
			)) {
				const raw = slots[key];
				if (raw != null) choices.set(code, raw);
			}
		for (const tag of installed) {
			const raw = read(tag),
				code = app.wireCodes[tag] ?? tag;
			if (raw != null) choices.set(code, raw);
			else choices.delete(code);
		}
		const firstCode = [...choices.keys()].sort()[0];
		const loose =
			firstCode === undefined ? undefined : file(choices.get(firstCode));
		for (const tag of installed) {
			const value = file(read(tag)) ?? loose;
			if (value) return value as NavigationMedia<T>[K];
		}
		return undefined;
	}
	return { icon: shown("icon"), audioLabel: shown("audioLabel") };
}

/** Apply a scoped edit to the current carrier so concurrent edits to other
 * languages survive. A clear in a translation restores the shared file. */
export function editNavigationInLanguage<T extends IconRef>(
	carrier: NavigationMedia<T>,
	files: { icon: T | null; audioLabel: MediaAssetId | null },
	language: string,
	app: EffectiveAppLocalization,
): void {
	const sourceLanguage = app.sourceLanguage;
	const previous = navigationFilesInLanguage(carrier, language, app);
	const translated = { ...ownRecordValue(carrier.mediaByLanguage, language) };
	for (const role of ["icon", "audioLabel"] as const) {
		const file = files[role];
		if (file !== null && file === previous[role]) continue;
		if (language === sourceLanguage) {
			if (file === null) delete carrier[role];
			else if (role === "icon") carrier.icon = files.icon ?? undefined;
			else carrier.audioLabel = files.audioLabel ?? undefined;
			delete translated[role];
		} else if (file === null || file === carrier[role]) delete translated[role];
		else if (role === "icon") translated.icon = files.icon;
		else translated.audioLabel = files.audioLabel;
	}
	if (Object.keys(translated).length)
		carrier.mediaByLanguage = recordWithValue(
			carrier.mediaByLanguage,
			language,
			translated,
		);
	else if (carrier.mediaByLanguage) {
		delete carrier.mediaByLanguage[language];
		if (!Object.keys(carrier.mediaByLanguage).length)
			delete carrier.mediaByLanguage;
	}
}

export function navigationMediaProblem(
	carrier: NavigationMedia | undefined,
	app: EffectiveAppLocalization,
): string | undefined {
	if (!carrier) return;
	for (const [language, slots] of Object.entries(
		carrier.mediaByLanguage ?? {},
	)) {
		if (!app.languageOrder.includes(language))
			return "This menu file names a language outside the app. Choose a language the app includes.";
		for (const key of ["icon", "audioLabel"] as const)
			if (slots[key] !== undefined && !carrier[key]) {
				return key === "icon"
					? "Choose a shared icon before adding an icon in another language, or clear the translated icon."
					: "Choose a shared spoken label before adding audio in another language, or clear its translated audio.";
			}
	}
	return undefined;
}
