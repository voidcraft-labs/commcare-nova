/**
 * The profile settings a `.ccz` made for one project space writes.
 *
 * A publish keeps each of the fifteen seeded settings the project space
 * holds a value for and writes Nova's seed only where it holds none
 * (`targetOverlay.ts::projectProfileForTarget`), and always writes Nova's
 * two owned settings. After any Nova publish the project space therefore
 * holds exactly the values this function writes, so the archive and HQ's
 * build of the same project space state one profile. A deployment Nova
 * brought in is seeded by no one (`TargetFacts.seeds` is `"target"`): a
 * setting it holds no value for stays absent there, and here.
 *
 * Pure, and outside the barrel.
 */

import type { BlueprintDoc } from "@/lib/domain";
import {
	type AppProfileProperty,
	appProfileProperties,
	SEEDED_PROFILE_PROPERTIES,
} from "./appProfileSettings";
import type { KeptProfilePropertyKey, TargetFacts } from "./targetFacts";

const SEEDED_KEYS: ReadonlySet<string> = new Set(
	SEEDED_PROFILE_PROPERTIES.map(({ key }) => key),
);

/** The setting Nova writes no value for, which HQ's build writes forced where it is held. */
const DETAIL_VIEW_LOG_KEY = "cc-log-entity-detail-enabled";

/**
 * The profile's settings for `doc` on the project space `facts` describes,
 * in `appProfileProperties`' order, each with HQ's own `force`; then the
 * detail-view log setting, forced, where the project space holds it. With
 * no facts, no project space was read, and Nova's own seventeen stand.
 */
export function targetProfileProperties(
	doc: Pick<BlueprintDoc, "appSettings">,
	facts: Pick<TargetFacts, "profileProperties" | "seeds"> | null,
): readonly AppProfileProperty[] {
	const own = appProfileProperties(doc);
	if (facts === null) return own;
	const held = (key: string): string | undefined =>
		Object.hasOwn(facts.profileProperties, key)
			? facts.profileProperties[key as KeptProfilePropertyKey]
			: undefined;
	const properties = own.flatMap((property): AppProfileProperty[] => {
		if (!SEEDED_KEYS.has(property.key)) return [property];
		const value = held(property.key);
		if (value !== undefined) return [{ ...property, value }];
		return facts.seeds === "nova" ? [property] : [];
	});
	const detailViewLog = held(DETAIL_VIEW_LOG_KEY);
	return detailViewLog === undefined
		? properties
		: [
				...properties,
				{ key: DETAIL_VIEW_LOG_KEY, value: detailViewLog, force: true },
			];
}
