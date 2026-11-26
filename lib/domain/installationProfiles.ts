import { z } from "zod";
import type { BlueprintDoc } from "./blueprint";
import { effectiveAppLocalization, languageTagSchema } from "./localization";
import { type Uuid, uuidSchema } from "./uuid";

export const installationProfileSchema = z.strictObject({
	uuid: uuidSchema,
	name: z.string(),
	languages: z
		.array(languageTagSchema)
		.min(1, "Choose at least one installation language.")
		.refine(
			(languages) => new Set(languages).size === languages.length,
			"Each installation language can appear once.",
		),
	requiresPracticeWorker: z.boolean(),
});
export type InstallationProfile = z.infer<typeof installationProfileSchema>;

export const installationProfilePatchSchema = installationProfileSchema
	.omit({ uuid: true })
	.partial()
	.refine(
		(patch) => Object.values(patch).some((value) => value !== undefined),
		"Choose something to change in this installation profile.",
	);

export const installationProfileChangeSchema = z.discriminatedUnion(
	"operation",
	[
		z.strictObject({
			operation: z.literal("add"),
			profile: installationProfileSchema,
		}),
		z.strictObject({
			operation: z.literal("update"),
			uuid: uuidSchema,
			patch: installationProfilePatchSchema,
		}),
		z.strictObject({ operation: z.literal("remove"), uuid: uuidSchema }),
	],
);

export function installationArchiveIssue(
	doc: BlueprintDoc,
	uuid?: Uuid,
 languageName?:(tag:string)=>string|undefined,
): string | undefined {
	if (!uuid) return;
	const profile = doc.appSettings.installationProfiles?.[uuid];
	if (!profile)
		return "This installation profile is no longer in the app. Choose another profile or all app languages.";
	if (profile.requiresPracticeWorker)
		return `${installationChoiceLabel(profile,Object.keys(doc.appSettings.installationProfiles ?? {}).indexOf(uuid),languageName ? tag=>languageName(tag) ?? "Language name unavailable" : undefined)} uses a practice worker from its project space. Publish to the project space to check this profile and see which version to download on CommCare HQ’s Releases page. You can also download all app languages here.`;
}

/** The first language is the worker's initial language. Source text and translations
 * still come from the same complete document, even if its source language is omitted. */
export function installationLanguages(doc: BlueprintDoc, profileUuid?: Uuid) {
	if (profileUuid === undefined)
		return effectiveAppLocalization(doc.localization).languageOrder;
	const profile = doc.appSettings.installationProfiles?.[profileUuid];
	if (!profile)
		throw new Error(
			"This installation profile is no longer in the app. Choose another profile or all app languages.",
		);
	return profile.languages;
}

/** Labels the native Releases picker renders indistinguishably. A choice for
 * one of these profiles needs visible names before someone can download it. */
export function ambiguousInstallationNames(profiles: readonly {name:string}[]): ReadonlySet<string> {
	const counts = new Map<string,number>();
	for (const {name} of profiles) {
		const label=visibleInstallationName(name);
		counts.set(label,(counts.get(label) ?? 0)+1);
	}
	return new Set([...counts].filter(([name,count])=>!name || count>1).map(([name])=>name));
}
export function visibleInstallationName(name:string):string {
	return name.trim().replace(/\s+/gu," ").normalize("NFC");
}
export const INSTALLATION_NAME_RECOVERY =
	"CommCare HQ’s download menu shows only profile names. On the app’s Releases page, open Application Profiles and give each blank or repeated name a different visible name. Keep each row’s languages and practice worker as they are. Save, bring the name changes into Nova, then publish and make a new version before choosing an installation.";

/** Every named choice has its own ordinal in Nova's list. Putting it before
 * the arbitrary authored text keeps even a name that looks like another opt-in
 * label distinct. The ordinary installation is a separate choice. */
export function installationChoiceLabel(profile: Pick<InstallationProfile,"name"|"languages">, index:number,languageLabel?:(tag:string)=>string):string {
	return `Profile ${index+1} · ${visibleInstallationName(profile.name) || "Unnamed profile"}${languageLabel ? ` (${profile.languages.map(languageLabel).join(" → ")})` : ""}`;
}

/** HQ always puts the ordinary selection first, whatever language its editor
 * uses. Only the remaining, sorted entries represent named installations. */
export const NATIVE_INSTALLATION_CHOICES = "The first entry in Application Profile is always the all-language installation. Choose a named profile from the entries below it, even when its name looks like the first one.";
