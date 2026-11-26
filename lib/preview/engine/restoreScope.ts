import "server-only";
import { sql, type Transaction } from "kysely";
import type { RestoreScope } from "@/lib/case-store";
import {
	locationWorkerGroup,
	workerGroupDetails,
} from "@/lib/commcare/workerGroupsWire";
import { resolveAppScopeInTransaction } from "@/lib/db/appAccess";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import {
	locationPropertiesOf,
	organizationLevelsOf,
	ownRecordValue,
	type PersistableDoc,
	personasOf,
} from "@/lib/domain";
import type { WorkerGroupRow } from "@/lib/domain/workerGroups";
import {
	chargeDeviceFixture,
	DEVICE_FIXTURE_BYTES,
} from "@/lib/lookup/fixtureValues";
import { readPersonaGroups } from "@/lib/lookup/workerGroups";
import type { StoredLocation } from "@/lib/organization/types";
import { readWorkerOwnerPlaces } from "@/lib/organization/workerPlaces";
import type { ResolvedPreviewIdentity } from "./identity";

export interface WorkerRestoreScope extends RestoreScope {
	readonly groups: readonly WorkerGroupRow[];
	readonly placeGroupCount?: number;
	readonly revisions?: { project: string; places: string };
}
export interface WorkerGroupRead {
	appId: string;
	projectId?: string;
	identity: Pick<
		ResolvedPreviewIdentity,
		"actorUserId" | "ownerId" | "personaUuid"
	>;
	blueprint: PersistableDoc | undefined;
}

export function workerPlaceGroup(
	blueprint: Pick<PersistableDoc, "organizationLevels" | "locationProperties">,
	place: StoredLocation,
	path: readonly string[],
) {
	const level = ownRecordValue(
		organizationLevelsOf(blueprint),
		place.levelUuid,
	);
	if (!level)
		throw new Error(
			"One of this worker's places changed level. You can refresh Preview.",
		);
	const properties = locationPropertiesOf(blueprint);
	return locationWorkerGroup({
		...place,
		path,
		levelName: level.name,
		metadata: {
			...place.source?.worker,
			...Object.fromEntries(
				Object.entries(place.values).flatMap(([id, value]) => {
					const property = ownRecordValue(properties, id);
					return property ? [[property.slug, value]] : [];
				}),
			),
		},
	});
}

/** HQ emits eligible places first, then classic case-sharing groups. Keep
 * fixture multiplicity; the case query alone reduces it to unique owners. */
export async function workerRestoreScope(
	tx: Transaction<AppDatabase>,
	args: WorkerGroupRead,
): Promise<WorkerRestoreScope> {
	const { appId, blueprint, identity } = args;
	const access = await resolveAppScopeInTransaction(
		tx,
		appId,
		identity.actorUserId,
		"view",
	);
	if (args.projectId && args.projectId !== access.projectId)
		throw new Error("The app changed Projects. You can reopen Preview.");
	const person =
		blueprint &&
		identity.personaUuid &&
		ownRecordValue(personasOf(blueprint), identity.personaUuid);
	if (!person || !blueprint)
		return { ownerIds: [identity.ownerId], groups: [] };
	const {
		rows: [revisions],
	} = await sql<{
		project: string;
		places: string;
	}>`SELECT COALESCE((SELECT revision FROM lookup_project_state WHERE project_id=${access.projectId}),0)::text project,
 COALESCE((SELECT revision FROM app_organization_state WHERE app_id=${appId}),0)::text places`.execute(
		tx,
	);

	const groups: WorkerGroupRow[] = [];
	const remaining = { bytes: DEVICE_FIXTURE_BYTES };
	function append(row: WorkerGroupRow) {
		chargeDeviceFixture(96 + Buffer.byteLength(JSON.stringify(row)), remaining);
		groups.push(row);
	}
	let after: string | undefined;
	do {
		const page = await readWorkerOwnerPlaces(tx, appId, blueprint, person, {
			after,
			limit: 500,
		});
		for (const place of page.places)
			append(workerPlaceGroup(blueprint, place, place.path));
		after = page.nextAfter ?? undefined;
	} while (after);
	const placeGroupCount = groups.length;
	let afterGroup: string | undefined;
	do {
		const classic = await readPersonaGroups(tx, appId, person.uuid, true, {
			after: afterGroup,
			limit: 40,
		});
		for (const group of classic)
			append({
				id: group.id,
				name: group.name,
				details: workerGroupDetails(group.metadata),
			});
		afterGroup =
			classic.length === 40 ? classic[classic.length - 1].id : undefined;
	} while (afterGroup);
	return {
		groups,
		placeGroupCount,
		ownerIds: [...new Set([identity.ownerId, ...groups.map((row) => row.id)])],
		revisions,
	};
}
/** The restore scope of a preview its caller has just authorized. Previewing
 * as the signed-in member is a worker assigned nowhere and in no group: their
 * own id and nothing else, derivable without a query, so the common case-list
 * render adds none. A persona reads its places and groups in one snapshot. */
export async function resolveRestoreScope(
	args: WorkerGroupRead,
): Promise<WorkerRestoreScope> {
	const { blueprint, identity } = args;
	if (
		identity.personaUuid === undefined ||
		blueprint === undefined ||
		!ownRecordValue(personasOf(blueprint), identity.personaUuid)
	)
		return { ownerIds: [identity.ownerId], groups: [] };
	return withAppTx((tx) => workerRestoreScope(tx, args), {
		isolationLevel: "repeatable read",
	});
}
