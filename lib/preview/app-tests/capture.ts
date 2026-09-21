import { getAuthDb } from "@/lib/auth/db";
import type { AppTestScope } from "@/lib/db/appTests";
import { previewProjectSpaceFor } from "@/lib/deployment/previewSpace";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { PersistableDoc } from "@/lib/domain";
import { balancedKeysBetween } from "@/lib/lookup/orderKeys";
import { getLookupFixtureData, getLookupManifest } from "@/lib/lookup/service";
import { readOrganization } from "@/lib/organization/service";
import type { AppTestSnapshot, AppTestStartInput } from "./types";

/** Capture authorized external read inputs once. Test entry, navigation and
 * submission all use these exact rows; no evaluator reads mutable live tables. */
export async function captureAppTestSnapshot(
	scope: AppTestScope & { role: string },
	blueprint: PersistableDoc,
	input: AppTestStartInput,
): Promise<AppTestSnapshot> {
	const auth = await getAuthDb();
	const user = await auth
		.selectFrom("auth_user")
		.select(["id", "name", "email"])
		.where("id", "=", scope.actorUserId)
		.executeTakeFirst();
	if (!user) throw new Error("The signed-in author is unavailable.");
	const doc = hydratePersistedBlueprint(blueprint);
	const lookupScope = {
		projectId: scope.projectId,
		actorId: scope.actorUserId,
		role: scope.role,
	};
	const tableIds = extractLookupReferenceTargets(doc).tableIds;
	const requested = new Set<string>(tableIds);
	const manifest = await getLookupManifest(lookupScope);
	if (
		manifest.tables
			.filter((table) => requested.has(table.id))
			.reduce((sum, table) => sum + table.dataBytes, 0) >
		32 * 1024 * 1024
	)
		throw new Error("The app's lookup data exceeds the 32 MB test limit.");
	const lookup = await getLookupFixtureData(lookupScope, tableIds);
	if (JSON.stringify([...lookup.rowsByTable]).length > 40 * 1024 * 1024)
		throw new Error("The app's lookup snapshot exceeds the test limit.");
	const organization = await readOrganization(scope);
	if (organization.locations.length > 2000)
		throw new Error(
			"The app's organization exceeds the 2,000-place test limit.",
		);
	const locations = [...organization.locations];
	const placeIds = new Set(locations.map((place) => place.id));
	const testPlaces = input.places ?? [];
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
	return {
		purpose: input.purpose,
		blueprint: toPersistableDoc(doc),
		user,
		projectSpace: await previewProjectSpaceFor({
			...scope,
			actorUserId: scope.actorUserId,
		}),
		lookup: {
			projectRevision: lookup.projectRevision,
			definitions: lookup.definitions,
			rows: [...lookup.rowsByTable],
		},
		organizationRevision: organization.revision,
		locations,
		testPlaceIds: (input.places ?? []).map((place) => place.uuid),
		testAssignmentPersonaIds: [...assigned],
	};
}
