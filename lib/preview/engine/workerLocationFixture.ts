// lib/preview/engine/workerLocationFixture.ts
//
// The worker's `locations` fixture, which a restore delivers beside their
// cases: the places of their footprint (`lib/organization/footprint.ts`).
// Preview's casedb read and the form check (`evaluate_form`) both load it
// here, so a form reads the same places wherever it runs.

import "server-only";
import {
	assignedLocationUuids,
	type OrganizationCollections,
	orderedOrganizationLevels,
	ownRecordValue,
	personasOf,
	type UserCollections,
} from "@/lib/domain";
import {
	type LocationFixtureRow,
	locationFixtureRows,
	personaFootprint,
} from "@/lib/organization/footprint";
import { readOrganizationPlaces } from "@/lib/organization/service";

/** The persona whose device holds places: `undefined` for yourself, a
 * persona assigned nowhere, or an app with no organization, each a worker HQ
 * sends an empty fixture. */
function placedPersona(
	doc: (OrganizationCollections & UserCollections) | undefined,
	personaUuid: string | undefined,
) {
	if (doc === undefined || personaUuid === undefined) return undefined;
	if (orderedOrganizationLevels(doc).length === 0) return undefined;
	const persona = ownRecordValue(personasOf(doc), personaUuid);
	if (
		persona === undefined ||
		assignedLocationUuids(persona.locations).length === 0
	)
		return undefined;
	return persona;
}

/**
 * The places a worker's device holds. Previewing as yourself, or as a persona
 * assigned nowhere, is a worker HQ sends an empty fixture; so is any worker of
 * an app with no organization, whose forms the checker keeps from reading
 * places at all. The caller has already proven its access to the app.
 */
export async function workerLocationFixture(
	appId: string,
	doc: (OrganizationCollections & UserCollections) | undefined,
	personaUuid: string | undefined,
): Promise<readonly LocationFixtureRow[]> {
	const persona = placedPersona(doc, personaUuid);
	if (doc === undefined || persona === undefined) return [];
	return locationFixtureRows(doc, persona, await readOrganizationPlaces(appId));
}

/** The ids of the places {@link workerLocationFixture} holds, for a
 * submission whose entry carried no device snapshot of them. */
export async function workerPlaceIds(
	appId: string,
	doc: (OrganizationCollections & UserCollections) | undefined,
	personaUuid: string | undefined,
): Promise<readonly string[]> {
	const persona = placedPersona(doc, personaUuid);
	if (doc === undefined || persona === undefined) return [];
	return personaFootprint(
		doc,
		persona,
		await readOrganizationPlaces(appId),
	).map((place) => place.id);
}
