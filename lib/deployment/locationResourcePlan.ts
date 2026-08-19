/**
 * Which of an app's places Nova may put on a project space, in what
 * order, and under what claim.
 *
 * Three separate decisions live here because they have to be made
 * together, against one snapshot of what the target holds:
 *
 *   * **Can CommCare HQ take this tree at all?** Nova cannot create a
 *     level (`locations/resources/v0_5.py::LocationTypeResource.Meta`
 *     allows only `get`), and it admits authored shapes CommCare HQ
 *     refuses: a place that skips a rung, two siblings sharing a name.
 *     Those are refusals, not mid-push failures.
 *   * **Whose place is this?** `util.py::validate_site_code` makes a site
 *     code domain-unique, so a code Nova wants and did not create belongs
 *     to somebody. Nothing is taken over without being named.
 *   * **What order?** A child names its parent by the `location_id` the
 *     parent's own batch returned, and `patch_list` takes at most 100 at
 *     a time, so the push is depth-ordered batches rather than one call.
 *
 * Everything here is pure. The reads that supply `hqLevels` and
 * `hqPlaces` are the caller's, and their FAILURE is the caller's too: a
 * plan built from "nothing came back" would read an unanswerable question
 * as permission.
 */

import type { OrganizationCollections } from "@/lib/domain";
import {
	orderedLocationProperties,
	organizationLevelsOf,
	ownRecordValue,
} from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import type { DeploymentResource, DeploymentResourceOwnership } from "./types";

/** One level the target defines. Nova reads these; it cannot make them. */
export interface RemoteLevel {
	readonly code: string;
	/** The level directly above, by code. Null at the top of the tree. */
	readonly parentCode: string | null;
}

/** One place the target already holds. Archived ones are not in here. */
export interface RemotePlace {
	readonly locationId: string;
	readonly name: string;
	readonly siteCode: string;
	readonly parentLocationId: string | null;
	/** What the place currently carries in CommCare HQ's `location_data`. */
	readonly values: Readonly<Record<string, string>>;
}

/** One of Nova's live places, as the push would present it. */
export interface PlannedPlace {
	readonly locationUuid: string;
	/** Create-once in Nova, and domain-unique on CommCare HQ. */
	readonly siteCode: string;
	readonly name: string;
	/** The code of the level this place stands at. */
	readonly levelCode: string;
	readonly parentLocationUuid: string | null;
	/** Exact decimal strings. A coordinate is never a float here. */
	readonly latitude: string | null;
	readonly longitude: string | null;
	/**
	 * The place's information, keyed by each property's CURRENT slug.
	 * Every property the app defines appears, empty string included, so
	 * clearing a value in Nova clears it on the target too.
	 */
	readonly values: Readonly<Record<string, string>>;
}

/**
 * A place CommCare HQ will not take, whatever Nova does about ownership.
 *
 * Four kinds, and each names a different thing to change. They are found
 * before any mutation for the reason every blocking edge is: `patch_list`
 * is atomic per batch, so a tree that fails on its fourth level has
 * already put three levels of places on somebody's project space.
 *
 * Deliberately not exhaustive of everything CommCare HQ can refuse. It
 * also declines to change the level of a place that has children
 * (`util.py::get_location_type`), which Nova's own store already forbids
 * while a place has any, and it holds a site code that an ARCHIVED place
 * still owns and this list cannot see. Those surface as the push's own
 * refusal, carrying CommCare HQ's sentence and the site code it names:
 * the right answer for a state Nova cannot observe, and the wrong one for
 * these four, which it can.
 */
export type PlacePushProblem =
	| {
			/** The level this place stands at does not exist on the target. */
			readonly kind: "level-missing";
			readonly locationUuid: string;
			readonly name: string;
			readonly siteCode: string;
			readonly levelCode: string;
	  }
	| {
			/**
			 * The target's level graph does not put this place's level
			 * directly under its parent place's level.
			 * `forms.py::LocationForm.get_allowed_types` filters
			 * `parent_type=parent.location_type`, so a skipped rung, which
			 * Nova models on purpose, has nowhere to go.
			 */
			readonly kind: "level-not-under-parent";
			readonly locationUuid: string;
			readonly name: string;
			readonly siteCode: string;
			readonly levelCode: string;
			/** The parent place, and the level it stands at. */
			readonly parentName: string;
			readonly parentLevelCode: string;
	  }
	| {
			/**
			 * Two live places share a name under the same parent.
			 * `util.py::has_siblings_with_name` matches on
			 * `(domain, name, parent)` and refuses the second one. Nova
			 * constrains only the site code, so this is authorable.
			 */
			readonly kind: "duplicate-sibling-name";
			readonly locationUuid: string;
			readonly name: string;
			readonly siteCode: string;
			/** The parent they share, or null when both are at the top. */
			readonly parentName: string | null;
	  }
	| {
			/**
			 * The place stands at the top of Nova's tree and under a parent
			 * on the target. `_update` reads `parent_location_id` only to
			 * look one UP (`::_get_parent_location`), so there is no value
			 * that clears a parent: v0.6 cannot make an existing place a
			 * root, and retrying will never change that.
			 */
			readonly kind: "cannot-become-root";
			readonly locationUuid: string;
			readonly name: string;
			readonly siteCode: string;
			/** What the target currently has above it. */
			readonly remoteParentName: string;
	  };

/** A site code the target already uses for a place Nova cannot account for. */
export interface PlaceConflict {
	readonly locationUuid: string;
	readonly siteCode: string;
	/** What Nova calls it. */
	readonly name: string;
	/** What the target calls the place sitting there. */
	readonly remoteName: string;
	readonly remoteId: string;
}

/** One place's place in the push. */
export interface PlannedPlacePush {
	readonly locationUuid: string;
	/** Resolved to a remote id at push time, from the batch above this one. */
	readonly parentLocationUuid: string | null;
	/** The target place this updates, or null to create one. */
	readonly remoteId: string | null;
	readonly ownership: DeploymentResourceOwnership;
	readonly siteCode: string;
	readonly name: string;
	readonly levelCode: string;
	readonly latitude: string | null;
	readonly longitude: string | null;
	/**
	 * What to send as `location_data`, or null to send nothing at all.
	 *
	 * Null when the app models no place information: `_update` runs the
	 * target's whole validator the moment the key is present, so sending
	 * an empty object would ask a project space to prove its required
	 * place fields about an app that has no opinion on them.
	 *
	 * Otherwise this is the target's current values with Nova's written
	 * over them. `_update` REPLACES `metadata` wholesale, so sending
	 * Nova's alone would delete every field the app does not model, and on
	 * an adopted place those belong to whoever made it.
	 */
	readonly locationData: Readonly<Record<string, string>> | null;
}

export type LocationResourcePlan =
	| {
			readonly ok: true;
			/**
			 * Depth-ordered, each already within CommCare HQ's atomic limit.
			 * Every batch's parents are in an earlier one.
			 */
			readonly batches: readonly (readonly PlannedPlacePush[])[];
	  }
	| {
			readonly ok: false;
			readonly reason: "unpushable";
			readonly problems: readonly PlacePushProblem[];
	  }
	| {
			readonly ok: false;
			readonly reason: "conflict";
			readonly conflicts: readonly PlaceConflict[];
	  };

export interface PlanLocationResourcePushInput {
	/** Every LIVE place, parents included. Archived places are not pushed. */
	readonly places: readonly PlannedPlace[];
	/** The deployment's live mappings: every kind; this filters its own. */
	readonly mappings: readonly DeploymentResource[];
	/** What the target holds right now. Never a guess, never a default. */
	readonly hqLevels: readonly RemoteLevel[];
	readonly hqPlaces: readonly RemotePlace[];
	/**
	 * Whether the app models any place information at all. False means no
	 * `location_data` is sent, which is different from sending none.
	 */
	readonly appModelsPlaceInformation: boolean;
	/**
	 * The Nova location UUIDs whose conflicts the caller has explicitly
	 * resolved by taking the existing place over. Nothing is adopted that
	 * is not named here.
	 */
	readonly adoptLocationUuids: readonly string[];
}

/** CommCare HQ's `patch_limit`, and therefore one batch's ceiling. */
const BATCH_LIMIT = 100;

/**
 * Plan the push, or refuse it.
 *
 * The two refusals are reported one at a time and in this order, because
 * they ask for different things and only one of them is a choice. A tree
 * CommCare HQ cannot hold has to be changed in Nova whoever owns the
 * places on the target, so naming an ownership decision alongside it
 * would ask somebody to decide something that does not matter yet.
 */
export function planLocationResourcePush(
	input: PlanLocationResourcePushInput,
): LocationResourcePlan {
	const placeByUuid = new Map(
		input.places.map((place) => [place.locationUuid, place] as const),
	);
	const levelByCode = new Map(
		input.hqLevels.map((level) => [level.code, level] as const),
	);
	const remoteBySiteCode = new Map(
		input.hqPlaces.map((place) => [place.siteCode, place] as const),
	);
	const remoteById = new Map(
		input.hqPlaces.map((place) => [place.locationId, place] as const),
	);
	const mappingByLocationUuid = new Map(
		input.mappings
			.filter((resource) => resource.kind === "location")
			.map((resource) => [resource.novaResourceId, resource] as const),
	);

	const problems = unpushablePlaces(
		input.places,
		placeByUuid,
		levelByCode,
		remoteBySiteCode,
		remoteById,
		mappingByLocationUuid,
	);
	if (problems.length > 0) return { ok: false, reason: "unpushable", problems };

	const adopting = new Set(input.adoptLocationUuids);
	const pushes: PlannedPlacePush[] = [];
	const conflicts: PlaceConflict[] = [];

	for (const place of input.places) {
		const mapping = mappingByLocationUuid.get(place.locationUuid);
		const remote = remoteBySiteCode.get(place.siteCode);

		/* Nova already owns a place under this exact code, and the place on
		 * the target IS the one it owns. Gone from CommCare HQ counts too:
		 * the push is the same act, it creates what is missing, and the
		 * claim is the one already recorded.
		 *
		 * The id comparison is not belt-and-braces. A place Nova pushed can
		 * be deleted on CommCare HQ and a DIFFERENT one made under the same
		 * code, and the ledger cannot tell those apart by name, which is
		 * the whole reason this planner exists. A mapping whose remote id
		 * no longer matches therefore falls through to the same explicit
		 * decision a stranger's place gets. */
		if (
			mapping !== undefined &&
			mapping.pushedIdentity === place.siteCode &&
			(remote === undefined || remote.locationId === mapping.remoteId)
		) {
			pushes.push(plannedPush(place, remote ?? null, mapping.ownership, input));
			continue;
		}

		/* Nothing of that code is there, so the push creates it and the
		 * claim is unambiguous. Nova's site codes are create-once
		 * (`lib/organization/CLAUDE.md`), so unlike a lookup table's tag
		 * this is never a rename: it is a place the target has never held,
		 * or one that was removed there. */
		if (remote === undefined) {
			pushes.push(plannedPush(place, null, "nova-created", input));
			continue;
		}

		/* Something of that code is there and Nova cannot account for it.
		 * Only an explicit decision resolves this. */
		if (!adopting.has(place.locationUuid)) {
			conflicts.push({
				locationUuid: place.locationUuid,
				siteCode: place.siteCode,
				name: place.name,
				remoteName: remote.name,
				remoteId: remote.locationId,
			});
			continue;
		}
		pushes.push(plannedPush(place, remote, "adopted", input));
	}

	if (conflicts.length > 0) return { ok: false, reason: "conflict", conflicts };
	return { ok: true, batches: batchByDepth(pushes, placeByUuid) };
}

/** One place's push payload, once its claim is settled. */
function plannedPush(
	place: PlannedPlace,
	remote: RemotePlace | null,
	ownership: DeploymentResourceOwnership,
	input: PlanLocationResourcePushInput,
): PlannedPlacePush {
	return {
		locationUuid: place.locationUuid,
		parentLocationUuid: place.parentLocationUuid,
		remoteId: remote?.locationId ?? null,
		ownership,
		siteCode: place.siteCode,
		name: place.name,
		levelCode: place.levelCode,
		latitude: place.latitude,
		longitude: place.longitude,
		locationData: input.appModelsPlaceInformation
			? { ...(remote?.values ?? {}), ...place.values }
			: null,
	};
}

/**
 * Every place the target's own rules will not accept, found before any of
 * them is sent.
 */
function unpushablePlaces(
	places: readonly PlannedPlace[],
	placeByUuid: ReadonlyMap<string, PlannedPlace>,
	levelByCode: ReadonlyMap<string, RemoteLevel>,
	remoteBySiteCode: ReadonlyMap<string, RemotePlace>,
	remoteById: ReadonlyMap<string, RemotePlace>,
	mappingByLocationUuid: ReadonlyMap<string, DeploymentResource>,
): readonly PlacePushProblem[] {
	const problems: PlacePushProblem[] = [];
	/* Counted over the whole set first, so BOTH halves of a duplicate are
	 * named. Telling somebody about one "North clinic" leaves them looking
	 * for the other. */
	const siblingNameCounts = new Map<string, number>();
	for (const place of places) {
		siblingNameCounts.set(
			siblingKey(place),
			(siblingNameCounts.get(siblingKey(place)) ?? 0) + 1,
		);
	}

	for (const place of places) {
		const level = levelByCode.get(place.levelCode);
		if (level === undefined) {
			problems.push({
				kind: "level-missing",
				locationUuid: place.locationUuid,
				name: place.name,
				siteCode: place.siteCode,
				levelCode: place.levelCode,
			});
			continue;
		}

		const parent =
			place.parentLocationUuid === null
				? null
				: (placeByUuid.get(place.parentLocationUuid) ?? null);
		if (level.parentCode !== (parent === null ? null : parent.levelCode)) {
			problems.push(
				parent === null
					? /* A root place standing at a level that is not a root
						 * level on the target. Nova's own store keeps roots at
						 * root levels, so reaching here means the two level
						 * graphs disagree, which is the same repair as a level
						 * that is not there at all. */
						{
							kind: "level-missing",
							locationUuid: place.locationUuid,
							name: place.name,
							siteCode: place.siteCode,
							levelCode: place.levelCode,
						}
					: {
							kind: "level-not-under-parent",
							locationUuid: place.locationUuid,
							name: place.name,
							siteCode: place.siteCode,
							levelCode: place.levelCode,
							parentName: parent.name,
							parentLevelCode: parent.levelCode,
						},
			);
			continue;
		}

		if ((siblingNameCounts.get(siblingKey(place)) ?? 0) > 1) {
			problems.push({
				kind: "duplicate-sibling-name",
				locationUuid: place.locationUuid,
				name: place.name,
				siteCode: place.siteCode,
				parentName: parent?.name ?? null,
			});
			continue;
		}

		if (place.parentLocationUuid !== null) continue;
		/* A root in Nova. If the target holds this same place under a
		 * parent, no push can move it back to the top. */
		const mapping = mappingByLocationUuid.get(place.locationUuid);
		const remote =
			remoteBySiteCode.get(place.siteCode) ??
			(mapping === undefined ? undefined : remoteById.get(mapping.remoteId));
		if (remote === undefined || remote.parentLocationId === null) continue;
		problems.push({
			kind: "cannot-become-root",
			locationUuid: place.locationUuid,
			name: place.name,
			siteCode: place.siteCode,
			remoteParentName:
				remoteById.get(remote.parentLocationId)?.name ??
				remote.parentLocationId,
		});
	}
	return problems;
}

/**
 * What CommCare HQ compares siblings on: the parent, and the name.
 *
 * The separator is a character no UUID carries, so two different parent
 * and name pairs cannot collapse into one key.
 */
function siblingKey(place: PlannedPlace): string {
	return `${place.parentLocationUuid ?? ""}\u0000${place.name}`;
}

/**
 * Group the push into batches a parent's own batch always precedes.
 *
 * Depth in Nova's tree is the ordering, because that is exactly what the
 * dependency is: a child cannot be sent until its parent has a
 * `location_id`, and every place at depth N has its parent at depth N-1.
 * Each depth is then chunked to CommCare HQ's atomic limit, which is safe
 * because places at one depth never depend on each other.
 */
function batchByDepth(
	pushes: readonly PlannedPlacePush[],
	placeByUuid: ReadonlyMap<string, PlannedPlace>,
): readonly (readonly PlannedPlacePush[])[] {
	const depthByUuid = new Map<string, number>();
	const depthOf = (uuid: string, seen: ReadonlySet<string>): number => {
		const known = depthByUuid.get(uuid);
		if (known !== undefined) return known;
		const parentUuid = placeByUuid.get(uuid)?.parentLocationUuid ?? null;
		/* A cycle cannot exist in the store, where a place's parent is a
		 * real row and the writer proves ancestry. A depth walk that
		 * trusted that would hang rather than fail if one ever did. */
		const depth =
			parentUuid === null || seen.has(parentUuid)
				? 0
				: depthOf(parentUuid, new Set([...seen, parentUuid])) + 1;
		depthByUuid.set(uuid, depth);
		return depth;
	};

	const byDepth = new Map<number, PlannedPlacePush[]>();
	for (const push of pushes) {
		const depth = depthOf(push.locationUuid, new Set([push.locationUuid]));
		const group = byDepth.get(depth);
		if (group === undefined) byDepth.set(depth, [push]);
		else group.push(push);
	}

	const batches: (readonly PlannedPlacePush[])[] = [];
	for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
		const group = byDepth.get(depth) ?? [];
		for (let start = 0; start < group.length; start += BATCH_LIMIT) {
			batches.push(group.slice(start, start + BATCH_LIMIT));
		}
	}
	return batches;
}

/**
 * The live places of an app, as the push presents them.
 *
 * Two projections happen here, and both are the same rule the rest of the
 * program follows: references are identity, text is a projection. A place
 * stores its level as a UUID and its information keyed by property UUID,
 * because both of those survive a rename; CommCare HQ knows only the
 * level's code and the property's slug, so the current spelling is
 * resolved at the moment of the push.
 *
 * Archived places are absent by construction. They are not pushed — v0.6
 * exposes no archive method, so Nova has nothing to say to CommCare HQ
 * about one — and the ledger reports whatever an earlier publish left
 * there instead.
 */
export function plannedPlacesFor(
	doc: OrganizationCollections,
	locations: readonly StoredLocation[],
): readonly PlannedPlace[] {
	const levels = organizationLevelsOf(doc);
	const properties = orderedLocationProperties(doc);
	const live: PlannedPlace[] = [];
	for (const location of locations) {
		if (location.archivedAt !== null) continue;
		/* Every place's level is a live entity, proved inside the blueprint
		 * commit (`lib/organization/commitIntegrity.ts`). Falling back to the
		 * uuid keeps this total anyway, and the plan reports it as a level
		 * the target does not have, which is exactly what it would be. */
		const level = ownRecordValue(levels, location.levelUuid);
		live.push({
			locationUuid: location.id,
			siteCode: location.siteCode,
			name: location.name,
			levelCode: level?.code ?? location.levelUuid,
			parentLocationUuid: location.parentId,
			latitude: location.latitude,
			longitude: location.longitude,
			/* Only the information that APPLIES at this place's level, and
			 * every one of those, empty included. A property scoped to other
			 * levels has nothing to say about this place, while one that does
			 * apply and holds no value has to say so: `_update` replaces the
			 * whole bag, so an omitted key would leave a stale value on the
			 * target that Nova could never clear. */
			values: Object.fromEntries(
				properties
					.filter(
						(property) =>
							property.levelUuids === undefined ||
							property.levelUuids.some((uuid) => uuid === location.levelUuid),
					)
					.map((property) => [
						property.slug,
						ownRecordValue(location.values, property.uuid) ?? "",
					]),
			),
		});
	}
	return live;
}
