/**
 * Whether an app could run on one platform alone, read from its content.
 *
 * A publish offers narrowing an app to one platform where a project space
 * can't run the other (a plan without Web Apps, for one), and offers it only
 * where the content allows it: the validator refuses a declaration whose
 * platform can't run something the app holds. Media is not read here. A
 * change that only removes a platform strands no file, since every file then
 * has to play on fewer platforms.
 */

import type { BlueprintDoc, Platform } from "@/lib/domain";
import { PLATFORM_FEATURES } from "@/lib/domain/platforms";
import { contentRunsOn, unavailableUses } from "@/lib/domain/platformUses";
import type { PlatformNarrowing } from "@/lib/publish/planFeatures";

/** Whether `doc` could be narrowed to `platform` alone, and what it holds that the platform can't run. */
export function narrowingTo(
	doc: BlueprintDoc,
	platform: Platform,
): PlatformNarrowing {
	const features: string[] = [];
	for (const use of unavailableUses(doc, [platform])) {
		const label = PLATFORM_FEATURES[use.feature].label;
		if (!features.includes(label)) features.push(label);
	}
	return { open: contentRunsOn(doc).includes(platform), features };
}
