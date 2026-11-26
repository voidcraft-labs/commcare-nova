/** Read the installation profiles in an HQ app source without transport dependencies. */

import { nativeInstallationKey } from "./installationKey";

/** One entry of `build_profiles`. */
export interface HqBuildProfile {
	/** The profile's key in `build_profiles`. */
	readonly id: string;
	/** `name`; `""` where HQ holds no string. */
	readonly name: string;
	/** `langs`: the profile's language codes, its default first. */
	readonly langs: readonly string[];
	/** Only present when this destination binds a practice worker. */
	readonly practiceWorkerId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unusableBuildProfileKey(
	value: unknown,
	ordinaryLanguages: ReadonlySet<string>,
	moduleCount: number,
): boolean {
	return (
		isRecord(value) &&
		Object.entries(value).some(([key, p]) => {
			const languages =
				isRecord(p) && Array.isArray(p.langs)
					? p.langs.filter((lang): lang is string => typeof lang === "string")
					: [];
			return !nativeInstallationKey(
				key,
				ordinaryLanguages,
				languages,
				moduleCount,
			);
		})
	);
}

/**
 * `build_profiles`, `models/applications.py::ApplicationBase.build_profiles`,
 * a `SchemaDictProperty(BuildProfile)` HQ serializes on every app: an object
 * whose every value holds a `langs` list of strings. Null where it is not.
 */
export function readBuildProfiles(
	value: unknown,
	ordinaryLanguages?: ReadonlySet<string>,
	moduleCount?: number,
): readonly HqBuildProfile[] | null {
	if (!isRecord(value)) return null;
	const profiles: HqBuildProfile[] = [];
	for (const [id, profile] of Object.entries(value)) {
		if (
			!isRecord(profile) ||
			(profile.practice_mobile_worker_id != null &&
				typeof profile.practice_mobile_worker_id !== "string") ||
			!Array.isArray(profile.langs) ||
			!profile.langs.every((lang) => typeof lang === "string") ||
			!nativeInstallationKey(id, ordinaryLanguages, profile.langs, moduleCount)
		)
			return null;
		profiles.push({
			id,
			name: typeof profile.name === "string" ? profile.name : "",
			langs: profile.langs as string[],
			...(typeof profile.practice_mobile_worker_id === "string" &&
				profile.practice_mobile_worker_id !== "" && {
					practiceWorkerId: profile.practice_mobile_worker_id,
				}),
		});
	}
	return profiles;
}
