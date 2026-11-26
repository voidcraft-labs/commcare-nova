import type { HqBuildProfile } from "@/lib/commcare/hq/appSource";
import { languageIdentityForHqCode } from "@/lib/commcare/reader/languages";
import { languageTag } from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

/** Keep multiplicity and language order. Keys and worker accounts belong to one destination. */
export function portableInstallationDigest(
	profiles: readonly HqBuildProfile[],
	languageNames: Readonly<Record<string, string>> = {},
) {
	return canonicalJsonDigest(
		profiles
			.map((profile) =>
				canonicalJsonDigest({
					name: profile.name,
					languages: profile.langs.map((code) => {
						const identity = languageIdentityForHqCode(
							code,
							languageNames[code],
						);
						return identity ? languageTag(identity) : { hqCode: code };
					}),
					requiresPracticeWorker: !!profile.practiceWorkerId,
				}),
			)
			.sort(),
	);
}

export function crossDestinationInstallations(
	targets: readonly {
		readonly app: string;
		readonly portable: string | null;
	}[],
) {
	const groups = new Map<string, (string | null)[]>();
	for (const target of targets) {
		const group = groups.get(target.app) ?? [];
		group.push(target.portable);
		groups.set(target.app, group);
	}
	return [...groups].map(([app, values]) => {
		const observed = values.filter((d): d is string => d !== null);
		const unobserved = values.length - observed.length;
		const state =
			new Set(observed).size > 1
				? "split"
				: unobserved
					? "unobserved"
					: values.length === 1
						? "single"
						: "agrees";
		return {
			app,
			targets: values.length,
			observed: observed.length,
			unobserved,
			state,
		};
	});
}
