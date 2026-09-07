import type {
	SmokeCommon,
	SmokeProfile,
	SmokeProfileData,
} from "./smokeSeedFactory";

/** Executable fixture vocabulary, not a list of test identities. */
export const SMOKE_PROFILES = [
	"auth",
	"open",
	"app-list",
	"organization",
	"workspace",
	"case-changes",
	"form-links",
	"deep-links",
	"search-first",
	"localization",
	"sections",
	"threads",
	"scroll",
	"design",
	"delete",
	"move",
	"react-profile",
	"member-role",
] as const satisfies readonly SmokeProfile[];

export type SmokeScenario = {
	[K in SmokeProfile]: {
		profile: K;
		common: SmokeCommon;
		data: SmokeProfileData[K];
	};
}[SmokeProfile];

export function profileFromTags(tags: readonly string[]): SmokeProfile {
	const profiles = tags
		.map((tag) => tag.replace(/^@/, ""))
		.filter((tag) => tag.startsWith("seed:"));
	const profile = profiles[0]?.slice("seed:".length);
	if (
		profiles.length !== 1 ||
		!SMOKE_PROFILES.some((name) => name === profile)
	) {
		throw new Error(
			`Each authenticated scenario needs exactly one known @seed: profile; received ${JSON.stringify(profiles)}`,
		);
	}
	return profile as SmokeProfile;
}

export function seedFor<K extends SmokeProfile>(
	scenario: SmokeScenario,
	profile: K,
): SmokeCommon & SmokeProfileData[K] {
	if (scenario.profile !== profile)
		throw new Error(
			`Scenario requires ${profile}, but discovery allocated ${scenario.profile}`,
		);
	// The discriminant is checked above; TS cannot narrow a mapped union by a generic key.
	return { ...scenario.common, ...scenario.data } as SmokeCommon &
		SmokeProfileData[K];
}
