/**
 * The build profiles of an app a CommCare HQ target holds, held to the
 * languages a publish writes.
 *
 * A build profile is a set of the app's languages one group of phones
 * installs (`models/applications.py::BuildProfile`), and HQ makes every file
 * of a profile's build from the profile's own `langs`
 * (`ApplicationBase.get_build_langs`). An update never writes
 * `build_profiles` (`ApplicationBase._update_excluded_fields`), and no
 * request an API key can send changes one, so a publish that left a profile
 * naming a language the app no longer has would leave HQ building that
 * profile with a language that has no text of its own, or failing to build
 * it at all (`xform.py::XForm.exclude_languages`). A publish reads the
 * profiles and stops instead.
 *
 * Pure: no I/O.
 */

import { type BlueprintDoc, effectiveAppLocalization } from "@/lib/domain";
import { classicLanguageRow } from "./classicLanguages";
import type { HqBuildProfile } from "./hq/appSource";
import { planLanguageWire } from "./languageWire";

/**
 * The codes one publish of `doc` writes as `langs`, in order: the list
 * `localization.ts::commCareLocalization` hands `expander.ts::appLevelValues`.
 */
export function publishedLanguageCodes(doc: BlueprintDoc): readonly string[] {
	return planLanguageWire(effectiveAppLocalization(doc.localization)).languages;
}

export interface BuildProfileLanguageGap {
	readonly id: string;
	/** The profile's name as HQ holds it; `""` where it has none. */
	readonly name: string;
	/** The codes the profile names that the app does not have, in the profile's order. */
	readonly missing: readonly string[];
	/** True where the profile names no language the app has. */
	readonly emptied: boolean;
}

/**
 * One gap per profile that names a code outside `langs`, in HQ's profile
 * order. A profile with no languages names none, so it gives no gap.
 */
export function buildProfileLanguageGaps(
	langs: readonly string[],
	profiles: readonly HqBuildProfile[],
): readonly BuildProfileLanguageGap[] {
	const held = new Set(langs);
	const gaps: BuildProfileLanguageGap[] = [];
	for (const profile of profiles) {
		const missing = [
			...new Set(profile.langs.filter((code) => !held.has(code))),
		];
		if (missing.length === 0) continue;
		gaps.push({
			id: profile.id,
			name: profile.name,
			missing,
			emptied: profile.langs.every((code) => !held.has(code)),
		});
	}
	return gaps;
}

/**
 * A language a profile names, as a person looks for it on HQ's Application
 * Profiles tab, which lists codes: its English name and its code
 * (`French (fra)`), or the code alone where Classic's catalog has no row for
 * it (`cmn-hant`).
 */
export function buildProfileLanguageLabel(code: string): string {
	const row = classicLanguageRow(code);
	return row === undefined ? code : `${row.englishName} (${code})`;
}
