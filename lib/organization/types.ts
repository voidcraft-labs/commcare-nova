// lib/organization/types.ts
//
// The public shapes of the app-scoped locations store. Kept import-light so
// client surfaces can bind against them without pulling the server-only
// service into a bundle.

/**
 * An authorized handle on one app's organization.
 *
 * Constructed server-side only, from a freshly authorized app row — never
 * from a client-asserted app or Project id. The Project is the tenant and
 * the capability map is the authority; `actorUserId` is provenance and
 * attribution, never a filter.
 *
 * `projectId` travels alongside `appId` even though location rows key on
 * `app_id` alone. It is what every write re-proves under the app lock: an
 * app that moved Projects between the caller's read and its write must not
 * have that write land, exactly as the blueprint commit's
 * `expectedProjectId` works.
 */
export interface OrganizationScope {
	readonly appId: string;
	readonly projectId: string;
	readonly role: string;
	readonly actorUserId: string;
}

/**
 * The app's organization clock — a canonical nonnegative decimal string
 * within signed-int64 range, exactly as lookup revisions are.
 *
 * Never convert one through `Number`, never serialize a native `bigint`, and
 * never compare two lexically.
 */
export type OrganizationRevision = string;

/** One place in the organization, as stored. */
export interface StoredLocation {
	readonly id: string;
	/** The blueprint `organizationLevel` this place stands at. */
	readonly levelUuid: string;
	readonly parentId: string | null;
	/** Create-once external identity — the human and bulk-upload key. */
	readonly siteCode: string;
	readonly name: string;
	readonly externalId: string | null;
	/** Exact decimal strings; a coordinate is never a JavaScript float here. */
	readonly latitude: string | null;
	readonly longitude: string | null;
	/** Custom-field values keyed by location-property UUID, never by slug. */
	readonly values: Readonly<Record<string, string>>;
	readonly archivedAt: Date | null;
	readonly orderKey: string;
}

/**
 * The whole organization at one revision.
 *
 * One snapshot rather than a change log, for the reason every other
 * authoritative read in the codebase is: two ordinary `READ COMMITTED`
 * reads can pair data N with clock N+1 and leave a client permanently
 * stale.
 */
export interface OrganizationSnapshot {
	readonly revision: OrganizationRevision;
	/** Every place, archived included, in `(parentId, orderKey, id)` order. */
	readonly locations: readonly StoredLocation[];
}

/**
 * What archiving a place would actually do, read before the gesture so the
 * confirmation can state it rather than describe it vaguely.
 *
 * `locationIds` is the place plus every descendant, because archiving walks
 * down — `SQLLocation.archive` takes `get_descendants(include_self=True)`.
 * `unassignedPersonas` names the personas that would stop working there.
 * `ownedCases` is the count whose owner ids point into the archived set and
 * which therefore stop reaching anyone's device; nothing moves them, so the
 * number is the whole warning.
 */
export interface ArchiveImpact {
	readonly locationIds: readonly string[];
	readonly unassignedPersonas: readonly string[];
	readonly ownedCases: number;
	/** Forms whose fixed case-owner rule points into the subtree. Such a rule
	 *  is authored intent, so archiving is blocked until it is changed. */
	readonly blockingOwnerRuleForms: readonly string[];
}
