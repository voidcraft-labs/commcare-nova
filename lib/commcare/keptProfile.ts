/**
 * The profile settings a `.ccz` made for one project space writes.
 *
 * A publish keeps each of the fifteen seeded settings the project space
 * holds a value for and writes Nova's seed only where it holds none
 * (`targetOverlay.ts::projectProfileForTarget`), and always writes Nova's
 * two owned settings. After any Nova publish the project space therefore
 * holds exactly the values this function writes, so the archive and HQ's
 * build of the same project space state one profile. A deployment Nova
 * brought in is seeded by no one (`seeds` is `"target"`): a setting it holds
 * no value for stays absent there, and here, whether or not its baseline
 * was read, since who seeds is a fact of the app mapping and not of a read.
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
import type { TargetFill } from "./targetOverlay";

const SEEDED_KEYS: ReadonlySet<string> = new Set(
	SEEDED_PROFILE_PROPERTIES.map(({ key }) => key),
);

/** The setting Nova writes no value for, which HQ's build writes forced where it is held. */
const DETAIL_VIEW_LOG_KEY = "cc-log-entity-detail-enabled";

/**
 * The profile's settings for `doc` on the project space `facts` describes,
 * in `appProfileProperties`' order, each with HQ's own `force`; then the
 * detail-view log setting, forced, where the project space holds it.
 * `seeds` says who fills a seeded setting the project space holds no value
 * for: Nova, where Nova created the HQ app, or no one, where Nova brought it
 * in. With no facts, no value the project space holds was read: Nova's own
 * seventeen stand where Nova seeds, and its two owned settings alone where
 * it does not.
 */
export function targetProfileProperties(
	doc: Pick<BlueprintDoc, "appSettings">,
	facts: Pick<TargetFacts, "profileProperties"> | null,
	seeds: TargetFill,
): readonly AppProfileProperty[] {
	const own = appProfileProperties(doc);
	const held = (key: string): string | undefined =>
		facts !== null && Object.hasOwn(facts.profileProperties, key)
			? facts.profileProperties[key as KeptProfilePropertyKey]
			: undefined;
	const properties = own.flatMap((property): AppProfileProperty[] => {
		if (!SEEDED_KEYS.has(property.key)) return [property];
		const value = held(property.key);
		if (value !== undefined) return [{ ...property, value }];
		return seeds === "nova" ? [property] : [];
	});
	const detailViewLog = held(DETAIL_VIEW_LOG_KEY);
	return detailViewLog === undefined
		? properties
		: [
				...properties,
				{ key: DETAIL_VIEW_LOG_KEY, value: detailViewLog, force: true },
			];
}
