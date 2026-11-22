import "server-only";
import { sql, type Transaction } from "kysely";
import { ApiError } from "@/lib/apiError";
import { readHqPlaceInventory } from "@/lib/commcare/hq/locationInventory";
import { readHqPlaceExternalId } from "@/lib/commcare/hq/locations";
import {
	type PlaceIdUpdate,
	PlaceWorkbookMismatch,
	placeIdArchive,
} from "@/lib/commcare/hq/placeWorkbook";
import { isCommCareServer } from "@/lib/commcare/servers";
import { resolveAppScopeInTransaction } from "@/lib/db/appAccess";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { getHqCredentials } from "@/lib/db/settings";
import { exportTargetRevision } from "@/lib/deployment/exportTargetRevision";
import type { ExportActor, ExportSpec } from "@/lib/export/artifacts/access";
import { authorizeAssignmentExport } from "@/lib/export/privateAssignments";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

export interface PlaceWorkbookWitness {
	target: { server: string; domain: string };
	organizationRevision: string;
	destinationDigest: string;
}
type Target = PlaceWorkbookWitness["target"];
type ClaimedPlace = {
	remote_id: string;
	external_id: string | null;
	pending_id: string | null;
	previous_id: string | null;
	observed: boolean;
};
const unavailable = () =>
	new ApiError(
		"This place setup has changed. Open this destination in Publish and prepare a new workbook.",
		409,
	);

async function heldPlaces(
	tx: Transaction<AppDatabase>,
	actor: ExportActor,
	appId: string,
	target: Target,
) {
	const access = await resolveAppScopeInTransaction(
		tx,
		appId,
		actor.userId,
		"edit",
	);
	const scope = {
		appId,
		actorUserId: actor.userId,
		projectId: access.projectId,
	};
	await authorizeAssignmentExport(tx, scope, actor.grant, target);
	const row = await sql<{
		revision: string;
	}>`SELECT revision::text FROM app_organization_state WHERE app_id=${appId}
		AND (hq_server IS DISTINCT FROM ${target.server} OR hq_domain IS DISTINCT FROM ${target.domain}) FOR SHARE`.execute(
		tx,
	);
	if (!row.rows[0]) throw unavailable();
	const local = await sql<ClaimedPlace>`
		SELECT r.remote_id,p.external_id,b.canonical->>'pendingExternalId' AS pending_id,
            b.canonical->'observed'->>'externalId' AS previous_id,
            coalesce(b.origin='push' AND (b.canonical ? 'pendingExternalId') AND (b.canonical->'observed' ? 'externalId'),false) AS observed
        FROM app_deployments d
		JOIN app_deployment_resources r ON r.deployment_id=d.id AND r.kind='location' AND r.superseded_at IS NULL
		JOIN app_locations p ON p.app_id=d.app_id AND p.id::text=r.nova_resource_id AND p.archived_at IS NULL
		LEFT JOIN project_space_resource_baselines b ON b.project_id=d.project_id AND b.server=d.server AND b.domain=d.domain
            AND b.kind='location' AND b.remote_id=r.remote_id
        WHERE d.project_id=${access.projectId} AND d.app_id=${appId} AND d.server=${target.server} AND d.domain=${target.domain} AND d.state<>'ended'
		ORDER BY r.remote_id`.execute(tx);
	const data = await tx
		.selectFrom("lookup_project_state")
		.select("revision")
		.where("project_id", "=", access.projectId)
		.executeTakeFirst();
	return {
		appId,
		projectId: access.projectId,
		documentRevision: access.baseSeq,
		dataRevision: String(data?.revision ?? "0"),
		organizationRevision: row.rows[0].revision,
		targetRevision: await exportTargetRevision(tx, access.projectId, appId),
		claimed: local.rows,
	};
}

async function readDestination(
	actor: ExportActor,
	target: Target,
	claimed: readonly ClaimedPlace[],
) {
	if (!isCommCareServer(target.server)) throw unavailable();
	const auth = await getHqCredentials(actor.userId, target.domain);
	if (!auth.ok || auth.creds.server !== target.server) throw unavailable();
	const inventory = await readHqPlaceInventory(auth.creds, target.domain);
	if (inventory.kind !== "read") throw unavailable();
	const byId = new Map(
		inventory.places.map((place) => [place.locationId, place]),
	);
	const updates: PlaceIdUpdate[] = [];
	for (const intended of claimed) {
		const place = byId.get(intended.remote_id);
		if (!place?.observation) throw unavailable();
		if (place.observation.externalId === intended.external_id) continue;
		if (
			!intended.observed ||
			intended.previous_id !== place.observation.externalId ||
			intended.pending_id !== intended.external_id
		)
			throw unavailable();
		const detail = await readHqPlaceExternalId(
			auth.creds,
			target.domain,
			intended.remote_id,
		);
		if (
			"success" in detail ||
			detail.siteCode !== place.siteCode ||
			detail.externalId !== intended.previous_id
		)
			throw unavailable();
		const parent = place.parentLocationId
			? byId.get(place.parentLocationId)
			: undefined;
		if (place.parentLocationId && !parent) throw unavailable();
		updates.push({
			place,
			externalId: intended.external_id,
			parentCode: parent?.siteCode ?? null,
		});
	}
	const digest = canonicalJsonDigest({
		types: [...inventory.levels].sort((a, b) => a.id.localeCompare(b.id)),
		updates: updates.map(({ place, externalId, parentCode }) => ({
			id: place.locationId,
			name: place.name,
			site: place.siteCode,
			level: place.locationTypeCode,
			parent: place.parentLocationId,
			parentCode,
			latitude: place.latitude,
			longitude: place.longitude,
			current: place.observation,
			externalId,
		})),
	});
	return { levels: inventory.levels, updates, digest };
}

export async function verifyPlaceWitness(actor: ExportActor, spec: ExportSpec) {
	const expected = spec.places;
	if (!expected) throw unavailable();
	const held = await withAppTx(
		(tx) => heldPlaces(tx, actor, spec.appId, expected.target),
		{ isolationLevel: "repeatable read" },
	);
	if (
		held.projectId !== spec.projectId ||
		held.targetRevision !== spec.targetRevision ||
		held.organizationRevision !== expected.organizationRevision
	)
		throw unavailable();
	const actual = await readDestination(actor, expected.target, held.claimed);
	if (actual.digest !== expected.destinationDigest) throw unavailable();
}

export async function preparePlaceWorkbook(
	actor: ExportActor,
	appId: string,
	target: Target,
	signal?: AbortSignal,
) {
	const held = await withAppTx((tx) => heldPlaces(tx, actor, appId, target), {
		isolationLevel: "repeatable read",
	});
	const remote = await readDestination(actor, target, held.claimed);
	const spec: ExportSpec = {
		appId,
		projectId: held.projectId,
		documentRevision: held.documentRevision,
		dataRevision: held.dataRevision,
		targetRevision: held.targetRevision,
		target: null,
		format: "zip",
		filename: "place-ids-" + target.domain + ".zip",
		places: {
			target,
			organizationRevision: held.organizationRevision,
			destinationDigest: remote.digest,
		},
	};
	try {
		const source = placeIdArchive(target.domain, remote.levels, remote.updates);
		const { deliverExport } = await import("@/lib/export/artifacts/store");
		const result = await deliverExport(source, () => ({ actor, spec }), {
			protected: true,
			signal,
		});
		if (!("artifact" in result)) throw unavailable();
		return result.artifact;
	} catch (error) {
		if (error instanceof PlaceWorkbookMismatch)
			throw new ApiError(error.message, 409);
		throw error;
	}
}
