import {
	type BlueprintDoc,
	effectiveAppLocalization,
	type Uuid,
} from "@/lib/domain";
import type { HqBuildProfile } from "./hq/appSource";
import {
	INSTALLATION_KEY_RECOVERY,
	nativeInstallationKey,
} from "./hq/installationKey";
import { installationProfileKey, type WireIdentity } from "./wireIdentity";

export interface WireBuildProfile {
	name: string;
	langs: string[];
	practice_mobile_worker_id?: string;
}

/** The upload can carry worker IDs only from its own observed destination. */
export function wireBuildProfiles(
	doc: BlueprintDoc,
	identity?: WireIdentity,
): Record<string, WireBuildProfile> | undefined {
	const profiles = Object.values(doc.appSettings.installationProfiles ?? {});
	if (!profiles.length) return;
	const localization = effectiveAppLocalization(doc.localization);
	return Object.fromEntries(
		profiles.map((profile) => {
			const worker = profile.requiresPracticeWorker
				? identity?.installationPracticeWorker?.(profile.uuid)
				: undefined;
			return [
				installationProfileKey(profile.uuid, identity),
				{
					name: profile.name,
					langs: profile.languages.map((tag) => localization.wireCodes[tag]),
					...(worker && { practice_mobile_worker_id: worker }),
				},
			];
		}),
	);
}

export function sameProfileDefinition(
	a: HqBuildProfile,
	b: HqBuildProfile,
): boolean {
	return (
		a.name === b.name &&
		a.practiceWorkerId === b.practiceWorkerId &&
		a.langs.length === b.langs.length &&
		a.langs.every((language, index) => language === b.langs[index])
	);
}

/** A local named download embeds the physical key from its selected destination.
 * Check old target bindings again at the public download boundary. */
export function installationDownloadIssue(
	doc: BlueprintDoc,
	uuid: Uuid | undefined,
	identity: WireIdentity,
): string | undefined {
	if (!uuid) return;
	const profile = doc.appSettings.installationProfiles?.[uuid];
	if (!profile) return;
	const { wireCodes } = effectiveAppLocalization(doc.localization);
	if (
		!nativeInstallationKey(
			installationProfileKey(uuid, identity),
			new Set(Object.values(wireCodes)),
			profile.languages.map((tag) => wireCodes[tag]),
			doc.moduleOrder.length,
		)
	)
		return (
			INSTALLATION_KEY_RECOVERY +
			" Bring in the change and publish again before downloading this profile."
		);
}
