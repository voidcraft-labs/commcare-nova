/**
 * The entities of the world an app runs in that a reading brings with it:
 * the project space's organization levels, and the worker and place
 * information its logic reads. Pure: each takes what was read and the
 * reading's identity resolver, and returns entities and findings.
 */

import {
	BUILT_IN_USER_PROPERTY_SLUGS,
	type LocationProperty,
	locationPropertySchema,
	type OrganizationLevel,
	organizationLevelSchema,
	type UserProperty,
	type Uuid,
	userPropertySchema,
} from "@/lib/domain";
import { circumstanceFinding, type Finding } from "@/lib/publish/hqFindings";
import type { HqLocationType } from "../hq/locations";
import { userPropertySlugVerdict } from "../validator/userPropertySlug";
import type { ExpressionReading } from "./expressions";
import { externalKey, type IdentityResolver } from "./identity";
import { whereText } from "./place";

const ORGANIZATION = { kind: "organization" } as const;
const APP = { kind: "app" } as const;

/** Whether a level's code and name are ones the document's level schema admits. */
function holdable(level: HqLocationType): boolean {
	return (
		organizationLevelSchema.shape.code.safeParse(level.code).success &&
		organizationLevelSchema.shape.name.safeParse(level.name).success
	);
}

/**
 * Every level CommCare HQ lists, as document levels, each parent before its
 * children and siblings in HQ's order. A level's case flow is read from the
 * two settings the API returns: it holds workers, owns cases where HQ shares
 * them, and reaches every place below where HQ views descendants. Its
 * address book is HQ's default. `administrative` is not read: HQ sets it from
 * CommTrack and reads `has_users`, which no API returns.
 *
 * A level whose code or name the document's schema refuses is the
 * circumstance `place-not-holdable` at the organization, named by the level,
 * and it and every level beneath it are left out, so the levels never hold
 * one the gate would refuse. So is a level whose parent is not in the list,
 * or whose chain of parents never reaches the top.
 */
export function levelsFromHq(
	levels: readonly HqLocationType[],
	resolver: IdentityResolver,
): {
	readonly levels: readonly OrganizationLevel[];
	readonly findings: readonly Finding[];
} {
	const byCode = new Map(levels.map((level) => [level.code, level]));
	const uuidOf = new Map<string, Uuid>();
	const refused = new Set<string>();
	const out: OrganizationLevel[] = [];
	const findings: Finding[] = [];
	const notHoldable = (level: HqLocationType) => {
		refused.add(level.code);
		findings.push(
			circumstanceFinding("place-not-holdable", ORGANIZATION, {
				name: level.name,
			}),
		);
	};
	for (const level of levels) if (!holdable(level)) notHoldable(level);

	let placed = true;
	while (placed) {
		placed = false;
		for (const level of levels) {
			if (uuidOf.has(level.code) || refused.has(level.code)) continue;
			const parent =
				level.parentCode === null ? undefined : uuidOf.get(level.parentCode);
			if (level.parentCode !== null && parent === undefined) continue;
			const claim = resolver.claim(
				externalKey.organizationLevel(level.code),
				whereText(ORGANIZATION),
			);
			if (!claim.ok) {
				notHoldable(level);
				continue;
			}
			uuidOf.set(level.code, claim.uuid);
			out.push({
				uuid: claim.uuid,
				code: level.code,
				name: level.name,
				...(parent === undefined ? {} : { parentLevelUuid: parent }),
				caseFlow: {
					workers: "assigned",
					ownsCases: level.sharesCases,
					descendantCases: level.viewDescendants
						? { kind: "all" }
						: { kind: "none" },
				},
				addressBook: { reach: "own-branch" },
			});
			placed = true;
		}
	}

	/* A level never placed stands under the finding of a refused level above
	 * it; one with no refused level above it (its parent is not listed, or
	 * its parents run in a circle) is a finding of its own. */
	const underRefused = (level: HqLocationType): boolean => {
		const seen = new Set<string>();
		for (
			let code = level.parentCode;
			code !== null && !seen.has(code);
			code = byCode.get(code)?.parentCode ?? null
		) {
			if (refused.has(code)) return true;
			seen.add(code);
		}
		return false;
	};
	for (const level of levels)
		if (
			!uuidOf.has(level.code) &&
			!refused.has(level.code) &&
			!underRefused(level)
		)
			notHoldable(level);
	return { levels: out, findings };
}

/** Each distinct name of `names`, in the order first met. */
function distinct(names: readonly string[]): readonly string[] {
	return [...new Set(names)];
}

/**
 * The worker properties and the location properties an app's logic reads,
 * from what the first pass over its expressions met: a worker property for
 * each name read of the worker's own data that is a slug Nova can hold and
 * none CommCare supplies itself, and a location property for each slug read
 * as a place's `location_data`. Each is labelled with its slug, has no
 * choices and is not required: CommCare HQ serves no definition of either
 * to an API key. Every other name is left out, and the second pass words
 * it. Each list is in the order of its slugs.
 */
export function worldEntitiesFromReads(
	worldReads: ExpressionReading["worldReads"],
	resolver: IdentityResolver,
): {
	readonly userProperties: readonly UserProperty[];
	readonly locationProperties: readonly LocationProperty[];
} {
	const userProperties: UserProperty[] = [];
	for (const slug of distinct(worldReads.userFields)) {
		if (BUILT_IN_USER_PROPERTY_SLUGS.has(slug)) continue;
		if (!userPropertySlugVerdict(slug, new Set()).ok) continue;
		if (
			!userPropertySchema.shape.slug.safeParse(slug).success ||
			!userPropertySchema.shape.label.safeParse(slug).success
		)
			continue;
		const claim = resolver.claim(
			externalKey.userProperty(slug),
			whereText(APP),
		);
		if (!claim.ok) continue;
		userProperties.push({ uuid: claim.uuid, slug, label: slug });
	}
	const locationProperties: LocationProperty[] = [];
	for (const slug of distinct(worldReads.locationDataSlugs)) {
		if (!locationPropertySchema.shape.slug.safeParse(slug).success) continue;
		if (!locationPropertySchema.shape.label.safeParse(slug).success) continue;
		const claim = resolver.claim(
			externalKey.locationProperty(slug),
			whereText(ORGANIZATION),
		);
		if (!claim.ok) continue;
		locationProperties.push({ uuid: claim.uuid, slug, label: slug });
	}
	return { userProperties, locationProperties };
}
