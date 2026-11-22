import type { Selectable } from "kysely";
import type { AppLocationsTable } from "@/lib/db/pg";
import { asUuid } from "@/lib/domain";
import { canonicalCoordinate } from "./schema";
import type { PlaceSourceObservation, StoredLocation } from "./types";

/** A JSON document encoded as text, as in the native location metadata column. */
export function readSourceObservation(
	serialized: string | null,
): PlaceSourceObservation | null {
	return serialized === null
		? null
		: (JSON.parse(serialized) as PlaceSourceObservation);
}

export function toStoredLocation(
	row: Selectable<AppLocationsTable>,
): StoredLocation {
	const source = readSourceObservation(row.hq_observation);
	return {
		id: asUuid(row.id),
		...(source ? { source } : {}),
		levelUuid: row.level_uuid,
		parentId: row.parent_id === null ? null : asUuid(row.parent_id),
		siteCode: row.site_code,
		name: row.name,
		externalId: row.external_id,
		latitude: row.latitude === null ? null : canonicalCoordinate(row.latitude),
		longitude:
			row.longitude === null ? null : canonicalCoordinate(row.longitude),
		values: row.values,
		archivedAt: row.archived_at,
		orderKey: row.order_key,
	};
}

/** Public organization data contains the worker's modeled values. The exact
 * API observation belongs solely to a managed transfer. */
export function toPublicLocation(
	row: Selectable<AppLocationsTable>,
): StoredLocation {
	const { source, ...place } = toStoredLocation(row);
	return source
		? {
				...place,
				latitude: source.latitudeText,
				longitude: source.longitudeText,
			}
		: place;
}
