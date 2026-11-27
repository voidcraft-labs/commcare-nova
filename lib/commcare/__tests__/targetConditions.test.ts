/**
 * A platform reading that holds only on a project space with what it needs
 * (`lib/domain/platforms.ts::PlatformTargetCondition`) names that need by
 * publishing's own identifiers. The domain holds them as literals, since it
 * imports nothing from publishing, so the plausible failure is a condition
 * whose capability or plan feature no publish checks: the platform table
 * would promise a stop that never comes. Each id is held to the registry a
 * publish reads, and the plan feature to the HQ privilege a publish derives.
 */

import { describe, expect, it } from "vitest";
import { PLATFORM_FEATURES, TARGET_CONDITIONED_FEATURES } from "@/lib/domain";
import { isPlanFeatureId } from "@/lib/publish/planFeatures";
import { PROJECT_SPACE_CAPABILITIES } from "@/lib/publish/projectSpaceCompatibility";
import { PLAN_FEATURE_FOR_PRIVILEGE } from "../planPrivileges";

describe("target conditions", () => {
	it("name a capability publish checks and a plan feature it asks to confirm", () => {
		expect(TARGET_CONDITIONED_FEATURES).toEqual([
			"address-lookup",
			"search-address-picker",
		]);
		for (const feature of TARGET_CONDITIONED_FEATURES) {
			const condition = PLATFORM_FEATURES[feature].targetCondition;
			if (condition === undefined)
				throw new Error(`${feature} lost its condition.`);
			expect(
				Object.hasOwn(PROJECT_SPACE_CAPABILITIES, condition.capability),
			).toBe(true);
			expect(isPlanFeatureId(condition.planFeature)).toBe(true);
			expect(Object.values(PLAN_FEATURE_FOR_PRIVILEGE)).toContain(
				condition.planFeature,
			);
			expect(condition.unavailable.reading).toBe("unavailable");
		}
	});
});
