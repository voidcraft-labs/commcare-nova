import type { InstallationProfileBinding } from "../wireIdentity";
import type { ReadContext } from "./context";

/** The source's installation keys and selected workers under the UUIDs this reading claimed. */
export function readInstallationBindings(
	ctx: ReadContext,
): InstallationProfileBinding[] {
	if (!ctx.input.source.buildProfiles.length) return [];
	const profiles = new Map(
		ctx.input.source.buildProfiles.map((profile) => [profile.id, profile]),
	);
	return ctx.identities.entries().flatMap((entry) => {
		if (entry.kind !== "installationProfile") return [];
		const key = String(entry.parts[0]);
		const worker = profiles.get(key)?.practiceWorkerId;
		return [
			{ uuid: entry.uuid, key, ...(worker && { practiceWorkerId: worker }) },
		];
	});
}
