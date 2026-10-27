/**
 * The builder's voice of each platform refusal (`userFacingErrors.ts`).
 *
 * Contract: for every structural feature a declaration can refuse, the
 * builder reads the platform rule's own finding as one sentence that names
 * the owner the way the builder names it and offers both ways forward in
 * Nova's words, never a tool name; an unknown feature gives the generic
 * line. One assertion per feature, because this copy is the person's
 * contract. Copy keyed to the wrong owner's name fails here.
 */

import { describe, expect, it } from "vitest";
import type { ValidationError } from "@/lib/commcare/validator/errors";
import { platformFeatureAvailability } from "@/lib/commcare/validator/rules/platforms";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	NEW_APP_SETTINGS,
	type PlatformFeatureId,
} from "@/lib/domain";
import { PLATFORM_FEATURE_FIXTURES } from "@/lib/domain/__tests__/platformFeatureFixtures";

/** The fixture's document declaring both, and the rule's one finding on it. */
function finding(feature: PlatformFeatureId): ValidationError {
	const doc: BlueprintDoc = {
		...PLATFORM_FEATURE_FIXTURES[feature].with(),
		appSettings: { ...NEW_APP_SETTINGS },
	};
	const found = platformFeatureAvailability(doc).filter(
		(error) => error.details?.feature === feature,
	);
	expect(found).toHaveLength(1);
	return found[0] as ValidationError;
}

describe("each refusable structural feature in the builder's words", () => {
	it.each([
		[
			"datetime-question",
			'"answer" asks for a date and time, which Web Apps can\'t show. You can ask for the date and the time separately, or set the app to run only on Android in App settings.',
		],
		[
			"search-first",
			"\"Patients\" opens on Search first, which on Android can't open a case the phone doesn't hold. You can turn Search first off, or set the app to run only in Web Apps in App settings.",
		],
		[
			"several-cases",
			'"Patients" lets workers choose several cases, which Android can\'t do. You can let them choose one case, or set the app to run only in Web Apps in App settings.',
		],
		[
			"search-field-single-date",
			'Search field "dob" asks for one date, which Android doesn\'t show. You can ask for a date range instead, or set the app to run only in Web Apps in App settings.',
		],
		[
			"search-field-multiple-choice",
			'Search field "regions" takes several choices, which Android doesn\'t show. You can let workers pick one choice, or set the app to run only in Web Apps in App settings.',
		],
		[
			"connect-app",
			"Connect workers open this app only in the Connect app on Android. You can set the app to run only on Android in App settings, or turn off Connect.",
		],
	] as const)("%s", (feature, sentence) => {
		expect(userFacingError(finding(feature))).toBe(sentence);
	});

	it("gives the generic line for a feature this build doesn't know", () => {
		const known = finding("datetime-question");
		expect(
			userFacingError({
				...known,
				details: { ...known.details, feature: "hologram-question" },
			}),
		).toBe(
			"This isn't available where this app runs. You can change where it runs in App settings.",
		);
	});
});
