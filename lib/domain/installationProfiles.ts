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
): string | undefined {
	if (!uuid) return;
	const profile = doc.appSettings.installationProfiles?.[uuid];
	if (!profile)
		return "This installation profile is no longer in the app. Choose another profile or all app languages.";
	if (profile.requiresPracticeWorker)
		return `“${profile.name}” uses a practice worker from its project space. Open the app’s Releases page in CommCare HQ and download the build for this profile. You can also download all app languages here.`;
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
