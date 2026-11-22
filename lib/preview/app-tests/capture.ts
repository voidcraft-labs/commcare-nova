import { getAuthDb } from "@/lib/auth/db";
import { previewProjectSpaceFor } from "@/lib/deployment/previewSpace";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { PersistableDoc } from "@/lib/domain";
import { balancedKeysBetween } from "@/lib/lookup/orderKeys";
import {readAppTestPlaces} from "@/lib/organization/testProjection";
import { type AppTestLookupScope, captureAppTestLookup } from "./lookupAccess";
import type { AppTestSnapshot, AppTestStartInput } from "./types";

/** Capture authorized external read inputs once. Test entry, navigation and
 * submission all use these exact rows; no evaluator reads mutable live tables. */
export async function captureAppTestSnapshot(
	scope: AppTestLookupScope & { role: string },
	blueprint: PersistableDoc,
	input: AppTestStartInput,
	checks: import("@/lib/deployment/workerLookupProjection").WorkerProjectionGrantCheck[],
): Promise<AppTestSnapshot> {
	const auth = await getAuthDb();
	const user = await auth
		.selectFrom("auth_user")
		.select(["id", "name", "email"])
		.where("id", "=", scope.actorUserId)
		.executeTakeFirst();
	if (!user) throw new Error("The signed-in author is unavailable.");
	const doc = hydratePersistedBlueprint(blueprint);
	const lookup = await captureAppTestLookup(
		scope,
		doc,
		extractLookupReferenceTargets(doc).tableIds,
		input,checks,
	);
	const assigned = new Set<string>();
	for (const assignment of input.assignments ?? []) {
		const persona = doc.personas?.[assignment.personaUuid];
		if (!persona || assigned.has(assignment.personaUuid))
			throw new Error(
				"Each test assignment must name one saved Preview identity, once.",
			);
		assigned.add(assignment.personaUuid);
		const [primaryUuid, ...additionalUuids] = [
			...new Set(assignment.locationUuids),
		];
		if (primaryUuid === undefined) delete persona.locations;
		else
			persona.locations = {
				primaryUuid,
				...(additionalUuids.length ? { additionalUuids } : {}),
			};
	}
	const testPlaces = input.places ?? [];
	const organization = await readAppTestPlaces(scope,doc,testPlaces,
		(input.owners ?? []).flatMap(({owner}) => owner.kind === "place" ? [owner.locationUuid] : []));
	const locations = [...organization.locations];
	const placeIds = new Set(locations.map((place) => place.id));
	const placeOrder = balancedKeysBetween(null, null, testPlaces.length);
	for (const [index, place] of testPlaces.entries()) {
		if (placeIds.has(place.uuid))
			throw new Error(
				"Each test place needs a distinct identity, separate from saved places.",
			);
		placeIds.add(place.uuid);
		locations.push({
			id: place.uuid,
			levelUuid: place.levelUuid,
			parentId: place.parentUuid ?? null,
			name: place.name,
			siteCode: `test-${place.uuid}`,
			externalId: null,
			latitude: null,
			longitude: null,
			values: place.values ?? {},
			archivedAt: null,
			orderKey: placeOrder[index],
		});
	}
	return {
		purpose: input.purpose,
		blueprint: toPersistableDoc(doc),
		user,
		projectSpace: await previewProjectSpaceFor({
			...scope,
			actorUserId: scope.actorUserId,
		}),
		lookup,
		organizationRevision: organization.revision,
		locations,
		testPlaceIds: (input.places ?? []).map((place) => place.uuid),
		testAssignmentPersonaIds: [...assigned],
	};
}
