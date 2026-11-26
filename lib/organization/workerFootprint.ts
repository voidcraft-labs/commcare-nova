import "server-only";

import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import {
	ancestorLevels,
	assignedLocationUuids,
	type OrganizationCollections,
	organizationLevelsOf,
	type Persona,
} from "@/lib/domain";
import type { LocationFixtureRow } from "./footprint";
import { canonicalCoordinate } from "./schema";
import { readSourceObservation } from "./storedLocation";

/** Index walks for precisely the roots granted by the worker's address
 * books. The ancestor arm remains independent of the depth and allowlist
 * arms, just as in HQ's get_location_fixture_ids.sql. The depth of a
 * candidate is its physical depth; the stopping depth is a level depth. */
export function workerFootprintIds(
	appId: string,
	doc: OrganizationCollections,
	persona: Pick<Persona, "locations">,
	placeRows = sql.table("app_locations"),
) {
	const levels = organizationLevelsOf(doc);
	const depth = (id?: string) =>
		id && levels[id] ? ancestorLevels(levels[id], levels).length : null;
	const rules = Object.values(levels).map((level) => {
		const book = level.addressBook;
		return {
			level_id: level.uuid,
			reach: book.reach,
			max_depth: "downToLevelUuid" in book ? depth(book.downToLevelUuid) : null,
			from_level: book.reach === "shared-branch" ? book.fromLevelUuid : null,
			only_levels: book.reach === "own-branch-limited" ? book.levelUuids : null,
			top_depth:
				"alsoIncludeTopDownToLevelUuid" in book
					? depth(book.alsoIncludeTopDownToLevelUuid)
					: null,
		};
	});
	return sql<{ id: string }>`
		WITH RECURSIVE rules AS (
			SELECT * FROM jsonb_to_recordset(${JSON.stringify(rules)}::jsonb)
			AS rule(level_id uuid, reach text, max_depth int, from_level uuid, only_levels uuid[], top_depth int)
		), assigned AS (
			SELECT l.id, l.parent_id, l.level_uuid, r.reach, r.max_depth, r.from_level, r.only_levels, r.top_depth
			FROM ${placeRows} l JOIN rules r ON r.level_id = l.level_uuid
			WHERE l.app_id = ${appId} AND l.id = ANY(${assignedLocationUuids(persona.locations)}::uuid[]) AND l.archived_at IS NULL
		), ancestors(root_id, id, level_uuid, parent_id, hops) AS (
			SELECT id, id, level_uuid, parent_id, 0 FROM assigned
			UNION ALL
			SELECT a.root_id, p.id, p.level_uuid, p.parent_id, a.hops + 1 FROM ancestors a
			JOIN ${placeRows} p ON p.app_id = ${appId} AND p.id = a.parent_id
		), starts AS (
			SELECT src.id, root.hops - src.hops AS depth, w.max_depth, w.only_levels
			FROM assigned w JOIN ancestors root ON root.root_id = w.id AND root.parent_id IS NULL
			JOIN ancestors src ON src.root_id = w.id AND (
				(w.reach IN ('own-branch', 'own-branch-limited') AND src.hops = 0)
				OR (w.reach = 'shared-branch' AND src.level_uuid = w.from_level)
			)
			UNION
			SELECT root.id, 0, CASE WHEN w.reach = 'whole-organization' THEN w.max_depth ELSE w.top_depth END, NULL
			FROM assigned w JOIN ${placeRows} root ON root.app_id = ${appId} AND root.parent_id IS NULL AND root.archived_at IS NULL
			WHERE w.reach = 'whole-organization' OR w.top_depth IS NOT NULL
		), branch(id, depth, max_depth, only_levels) AS (
			SELECT id, depth, max_depth, only_levels FROM starts WHERE max_depth IS NULL OR depth <= max_depth
			UNION
			SELECT c.id, b.depth + 1, b.max_depth, b.only_levels FROM branch b
			JOIN ${placeRows} c ON c.app_id = ${appId} AND c.parent_id = b.id AND c.archived_at IS NULL
			WHERE b.max_depth IS NULL OR b.depth < b.max_depth
		)
		SELECT b.id FROM branch b JOIN ${placeRows} p ON p.app_id = ${appId} AND p.id = b.id
		WHERE b.only_levels IS NULL OR p.level_uuid = ANY(b.only_levels)
		UNION
		SELECT a.id FROM ancestors a JOIN assigned w ON w.id = a.root_id JOIN ${placeRows} p ON p.app_id = ${appId} AND p.id = a.id AND p.archived_at IS NULL
		WHERE a.hops > 0 AND w.reach <> 'whole-organization'
	`;
}

export async function readWorkerFixtureRows(
	tx: Transaction<AppDatabase>,
	appId: string,
	doc: OrganizationCollections,
	persona: Persona,
): Promise<LocationFixtureRow[]> {
	const result = await sql<{
		id: string;
		level_uuid: string;
		site_code: string;
		name: string;
		external_id: string | null;
		latitude: string | null;
		longitude: string | null;
		values: Record<string, string>;
		hq_observation: string | null;
		lineage: Record<string, string>;
	}>`
		WITH RECURSIVE footprint AS (${workerFootprintIds(appId, doc, persona)}),
		parents(root, parent_id, lineage) AS (
			SELECT l.id, l.parent_id, '{}'::jsonb FROM footprint f JOIN app_locations l ON l.app_id = ${appId} AND l.id = f.id
			UNION ALL
			SELECT p.root, l.parent_id, p.lineage || jsonb_build_object(l.level_uuid::text,l.id::text)
			FROM parents p JOIN app_locations l ON l.app_id = ${appId} AND l.id = p.parent_id
		)
		SELECT l.id, l.level_uuid, l.site_code, l.name, l.external_id, l.latitude, l.longitude, l.values, l.hq_observation, p.lineage
		FROM parents p JOIN app_locations l ON l.app_id = ${appId} AND l.id = p.root
		WHERE p.parent_id IS NULL AND l.archived_at IS NULL ORDER BY l.site_code COLLATE "C"
	`.execute(tx);
	return result.rows.map((row) => {
		const source = readSourceObservation(row.hq_observation);
		return {
			id: row.id,
			levelUuid: row.level_uuid,
			siteCode: row.site_code,
			name: row.name,
			externalId: row.external_id,
			latitude: source
				? source.latitudeText
				: row.latitude === null
					? null
					: canonicalCoordinate(row.latitude),
			longitude: source
				? source.longitudeText
				: row.longitude === null
					? null
					: canonicalCoordinate(row.longitude),
			values: row.values,
			lineage: row.lineage,
		};
	});
}
