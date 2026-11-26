import { z } from "zod";
import type { BlueprintDoc } from "./blueprint";
import type { IconRef } from "./builtinIcons";
import {
	type EffectiveAppLocalization,
	languageTagSchema,
	languageWireCodeSchema,
} from "./localization";
import {
	type MediaAssetId,
	mediaAssetIdSchema,
	storedFormMedia,
} from "./multimedia";
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
		iconOverride: icon.optional(),
		audioLabelOverride: mediaAssetIdSchema.optional(),
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
		{
			icon?: T | "blank" | null;
			audioLabel?: MediaAssetId | "blank" | null;
			iconOverride?: T;
			audioLabelOverride?: MediaAssetId;
		}
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

/** A generated locale string can select a translated file independently
 * of the carrier's ordinary media map. */
export function navigationMediaOverride<
	T extends IconRef,
	K extends "icon" | "audioLabel",
>(
	carrier: NavigationMedia<T>,
	key: K,
	language: string,
): NavigationMedia<T>[K] {
	return ownRecordValue(carrier.mediaByLanguage, language)?.[
		`${key}Override`
	] as NavigationMedia<T>[K];
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
		const direct =
			navigationMediaOverride(carrier, key, language) ?? file(read(language));
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
			const value =
				navigationMediaOverride(carrier, key, tag) ?? file(read(tag)) ?? loose;
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
		delete translated[`${role}Override`];
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

export type NavigationMediaProblem =
	| { readonly kind: "language-outside-app" }
	| { readonly kind: "needs-shared"; readonly role: "icon" | "audioLabel" }
	| {
			readonly kind: "override-needs-package";
			readonly role: "icon" | "audioLabel";
	  };

export function navigationMediaProblem(
	carrier: NavigationMedia | undefined,
	app: EffectiveAppLocalization,
	doc?: BlueprintDoc,
): NavigationMediaProblem | undefined {
	if (!carrier) return;
	for (const [language, slots] of Object.entries(
		carrier.mediaByLanguage ?? {},
	)) {
		if (!app.languageOrder.includes(language))
			return { kind: "language-outside-app" };
		for (const role of ["icon", "audioLabel"] as const) {
			const override = slots[`${role}Override`];
			if (
				(slots[role] !== undefined || override !== undefined) &&
				!carrier[role]
			)
				return { kind: "needs-shared", role };
			if (
				override !== undefined &&
				doc !== undefined &&
				!ordinaryNavigationAsset(doc, app, role, language, override)
			)
				return { kind: "override-needs-package", role };
		}
	}
	return undefined;
}

/** HQ installs only files referenced by its ordinary media surfaces. A locale
 * string alone does not cause the file to be added to the media resources. */
export function ordinaryNavigationAsset(
	doc: BlueprintDoc,
	app: EffectiveAppLocalization,
	role: "icon" | "audioLabel",
	language: string,
	asset: IconRef,
): boolean {
	const used = (carrier: NavigationMedia | undefined) =>
		carrier !== undefined &&
		storedNavigationFile(carrier, role, language) === asset;
	if (
		doc.moduleOrder.some((uuid) => {
			const module = doc.modules[uuid];
			return (
				used(module) ||
				used(module?.caseListMenuItem) ||
				(module?.caseListRegistrationForm?.kind === "always" &&
					used(module.caseListRegistrationForm)) ||
				(role === "icon" &&
					module?.caseListConfig?.columns.some(
						(column) =>
							column.kind === "image-map" &&
							column.mapping.some((entry) => entry.assetId === asset),
					)) ||
				doc.formOrder[uuid]?.some((form) => used(doc.forms[form]))
			);
		})
	)
		return true;
	const kind = role === "icon" ? "image" : "audio";
	for (const field of Object.values(doc.fields)) {
		if (
			"label_media" in field &&
			storedFormMedia(field.label_media, language, app.defaultLanguage)?.[
				kind
			] === asset
		)
			return true;
		if (
			"help_media" in field &&
			storedFormMedia(field.help_media, language, app.defaultLanguage)?.[
				kind
			] === asset
		)
			return true;
		if (
			(field.kind === "single_select" || field.kind === "multi_select") &&
			field.optionsSource.kind === "inline" &&
			field.optionsSource.options.some(
				(option) =>
					storedFormMedia(option.media, language, app.defaultLanguage)?.[
						kind
					] === asset,
			)
		)
			return true;
	}
	return false;
}

/** The author-facing sentence for a menu file problem. */
export function navigationMediaProblemText(
	problem: NavigationMediaProblem,
): string {
	if (problem.kind === "language-outside-app")
		return "This menu file names a language outside the app. Choose a language the app includes.";
	if (problem.kind === "override-needs-package")
		return "CommCare needs this translated file on an ordinary menu or form in the same language to include it in installations.";
	return problem.role === "icon"
		? "Choose a shared icon before adding an icon in another language, or clear the translated icon."
		: "Choose a shared spoken label before adding audio in another language, or clear its translated audio.";
}

/** The details a validator finding carries for a menu file problem. */
export function menuMediaProblemDetails(
	problem: NavigationMediaProblem,
): Record<string, string> {
	return problem.kind === "needs-shared"
		? { mediaProblem: problem.kind, mediaRole: problem.role }
		: { mediaProblem: problem.kind };
}
