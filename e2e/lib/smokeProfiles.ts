import type {
	SmokeCommon,
	SmokeProfile,
	SmokeProfileData,
} from "./smokeSeedFactory";

/** Executable fixture vocabulary, not a list of test identities. */
export const SMOKE_PROFILES = [
	"auth",
	"settings",
	"open",
	"app-tests",
	"app-list",
	"organization",
	"workspace",
	"case-changes",
	"case-choices",
	"form-links",
	"previous-task",
	"deep-links",
	"list-icon-action",
	"forms-read-search",
	"form-refused",
	"menu-held-case",
	"independent-form-choices",
	"shared-form-entries",
	"here-column",
	"sort-by",
	"preview-android-media",
	"search-claim",
	"search-results",
	"search-standing",
	"search-start-refused",
	"android-deep-link-visit",
	"search-choices-refused",
	"search-choice",
	"search-value-list",
	"register-from-list",
	"localization",
	"sections",
	"visit-report",
	"threads",
	"scroll",
	"design",
	"delete",
	"move",
	"react-profile",
	"member-role",
	"app-notices",
	"kept-baseline",
	"connect-learn",
	"identity-moves",
	"managed-data",
	"source-inventory",
	"bring-in",
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
