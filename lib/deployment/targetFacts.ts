/**
 * A deployment's `TargetFacts`: what its project space holds of the values
 * Nova leaves to CommCare HQ, projected from the stored app baseline.
 *
 * No column holds the facts and nothing backfills them: they are a pure
 * projection of the baseline's source, so a baseline that is absent, unread
 * or a shell's gives none and Nova's own values stand. Pure, with no store
 * and no `server-only`, so tests and the proof capture call it too.
 */

import { SEEDED_PROFILE_PROPERTIES } from "@/lib/commcare/appProfileSettings";
import { KEPT_AT_HQ } from "@/lib/commcare/surface/keptAtHq";
import {
	type KeptProfilePropertyKey,
	type TargetFacts,
	targetFactsFromSource,
} from "@/lib/commcare/targetFacts";
import type { KeptAdvisoryFacts } from "@/lib/publish/exportAdvisories";
import type { KeptLabelId } from "@/lib/publish/keptValues";
import type { AppBaseline } from "./types";

/**
 * The facts a stored baseline holds, or null for a shell's.
 *
 * A `create` baseline describes the empty app a first publish makes, which
 * no `.ccz`, Preview or card reads facts for: the fill that follows writes
 * the first baseline that gives them.
 */
export function targetFactsFromBaseline(
	baseline: Extract<AppBaseline, { source: unknown }>,
	/** The live app mapping's ownership. */
	adopted: boolean,
): TargetFacts | null {
	if (baseline.origin === "create") return null;
	return targetFactsFromSource(baseline.source, {
		observedAt: baseline.observedAt,
		novaOwnsAutoGpsCapture: baseline.ownership.autoGpsCapture,
		adopted,
	});
}

const SEED_VALUES: ReadonlyMap<string, string> = new Map(
	SEEDED_PROFILE_PROPERTIES.map((property) => [property.key, property.value]),
);

/** A seeded setting is kept where the project space holds it at another value than Nova's seed. */
function heldAwayFromSeed(key: KeptProfilePropertyKey) {
	return (facts: TargetFacts): boolean => {
		const held = facts.profileProperties[key];
		return held !== undefined && held !== SEED_VALUES.get(key);
	};
}

/**
 * When each label is listed: the project space holds the setting at another
 * value than a first publish to a new project space would give.
 */
const LISTED_WHEN: Readonly<
	Record<KeptLabelId, (facts: TargetFacts) => boolean>
> = {
	"automatic-app-updates": heldAwayFromSeed("cc-autoup-freq"),
	"sent-form-retention": heldAwayFromSeed("cc-days-form-retain"),
	"device-logging": heldAwayFromSeed("logenabled"),
	"automatic-sync": heldAwayFromSeed("cc-autosync-freq"),
	"media-check-at-install": heldAwayFromSeed("cc-content-valid"),
	"unsent-form-warning-count": heldAwayFromSeed("unsent-number-limit"),
	"unsent-form-warning-days": heldAwayFromSeed("unsent-time-limit"),
	"image-resizing": heldAwayFromSeed("cc-resize-images"),
	"fuzzy-search": heldAwayFromSeed("cc-fuzzy-search-enabled"),
	"sign-in-duration": heldAwayFromSeed("cc-login-duration-seconds"),
	"image-scaling": heldAwayFromSeed("cc-inflation-target-density"),
	"location-capture-accuracy": heldAwayFromSeed("cc-gps-auto-capture-accuracy"),
	"default-map-layer": heldAwayFromSeed("cc-maps-default-layer"),
	"text-to-speech": heldAwayFromSeed("cc-enable-tts"),
	"required-question-asterisk": heldAwayFromSeed(
		"cc-label-required-questions-with-asterisk",
	),
	/* Nova writes no value for it, so any value held is one a person set. */
	"case-detail-view-logging": (facts) =>
		facts.profileProperties["cc-log-entity-detail-enabled"] !== undefined,
	"reworded-commcare-screens": (facts) => facts.uiTextKeys.length > 0,
	"android-logos": (facts) => facts.androidLogos.length > 0,
	"mobile-report-version": (facts) => facts.mobileReportVersion !== "2.0",
	"location-with-every-form": (facts) => facts.autoGpsCapture,
	"persistent-menu": (facts) => facts.persistentMenu,
	"web-apps-breadcrumbs": (facts) => !facts.breadcrumbs,
	"secure-submissions": (facts) => facts.secureSubmissions,
	"custom-base-url": (facts) => facts.customBaseUrl !== null,
	"practice-mobile-worker": (facts) => facts.practiceWorker,
	"worker-activity-credential": (facts) => facts.credentialLevel !== null,
};

/** The label ids of the kept settings this project space holds at another value than a new one would. */
export function keptListFor(facts: TargetFacts): readonly KeptLabelId[] {
	const labels: KeptLabelId[] = [];
	for (const row of Object.values(KEPT_AT_HQ)) {
		if (row.kind !== "setting" || row.label === undefined) continue;
		if (LISTED_WHEN[row.label](facts)) labels.push(row.label);
	}
	return labels;
}

/** What a `.ccz` made from these facts cannot follow. */
export function keptAdvisoryFacts(
	facts: TargetFacts,
	languageCodes: readonly string[],
): KeptAdvisoryFacts {
	const { languageNames } = facts;
	return {
		uiTextFallsBack: facts.uiTextKeys.some((key) =>
			languageCodes.some((code) => facts.uiText[code]?.[key] === undefined),
		),
		androidLogos: facts.androidLogos.length > 0,
		practiceWorker: facts.practiceWorker,
		languageNames:
			languageNames !== null &&
			languageCodes.some((table) =>
				languageCodes.some(
					(code) => languageNames[table]?.[code] === undefined,
				),
			),
	};
}
