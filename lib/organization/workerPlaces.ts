import "server-only";

import { type Selectable, sql, type Transaction } from "kysely";
import type { AppDatabase, AppLocationsTable } from "@/lib/db/pg";
import {
	ancestorLevels,
	assignedLocationUuids,
	type OrganizationCollections,
	organizationLevelsOf,
	type Persona,
} from "@/lib/domain";
import { toPublicLocation } from "./storedLocation";
import type { StoredLocation } from "./types";

/** The caller owns one authorized repeatable-read transaction for all pages.
 * Case reach uses the place's actual tree depth for a down-to cap, including
 * on ragged trees. The level forest supplies the depth of the cap itself. */
export function workerCaseOwnerPaths(
	appId: string,
	doc: OrganizationCollections,
	persona: Pick<Persona, "locations">,
	placeRows = sql.table("app_locations"),
) {
	const assignments = assignedLocationUuids(persona.locations);
	const levels = organizationLevelsOf(doc);
	const rules = Object.values(levels).flatMap((level) => {
		if (level.caseFlow.workers !== "assigned") return [];
		const scope = level.caseFlow.descendantCases;
		const bottom =
			scope.kind === "down-to" ? levels[scope.levelUuid] : undefined;
		// -1 makes the assigned root a leaf. NULL is an unrestricted descent.
		const maxDepth =
			scope.kind === "all"
				? null
				: bottom
					? ancestorLevels(bottom, levels).length
					: -1;
		return [{ level_id: level.uuid, max_depth: maxDepth }];
	});
	const owners = Object.values(levels)
		.filter((level) => level.caseFlow.ownsCases)
		.map((level) => level.uuid);
	return sql<{ place_id: string; path: string[] }>`
		WITH RECURSIVE rules AS (
			SELECT * FROM jsonb_to_recordset(${JSON.stringify(rules)}::jsonb) AS r(level_id uuid, max_depth int)
		), ancestry(root_id, parent_id, path, max_depth) AS (
			SELECT l.id, l.parent_id, ARRAY[l.name], r.max_depth
			FROM ${placeRows} l JOIN rules r ON l.level_uuid = r.level_id
			WHERE l.app_id = ${appId} AND l.id = ANY(${assignments}::uuid[]) AND l.archived_at IS NULL
			UNION ALL
			SELECT a.root_id, p.parent_id, array_prepend(p.name, a.path), a.max_depth
			FROM ancestry a JOIN ${placeRows} p ON p.app_id = ${appId} AND p.id = a.parent_id
		), branch(place_id, path, max_depth) AS (
			SELECT root_id, path, max_depth FROM ancestry WHERE parent_id IS NULL
			UNION ALL
			SELECT c.id, array_append(b.path, c.name), b.max_depth
			FROM branch b JOIN ${placeRows} c ON c.app_id = ${appId} AND c.parent_id = b.place_id
			WHERE c.archived_at IS NULL AND (b.max_depth IS NULL OR cardinality(b.path) <= b.max_depth)
		)
		SELECT DISTINCT ON (b.place_id) b.place_id,b.path FROM branch b
		JOIN ${placeRows} l ON l.app_id = ${appId} AND l.id = b.place_id
		WHERE l.level_uuid = ANY(${owners}::uuid[])
		ORDER BY b.place_id
	`;
}

export async function readWorkerOwnerPlaces(
	tx: Transaction<AppDatabase>,
	appId: string,
	doc: OrganizationCollections,
	persona: Pick<Persona, "locations">,
	page: { readonly after?: string; readonly limit?: number } = {},
): Promise<{
	places: Array<StoredLocation & { path: string[] }>;
	nextAfter: string | null;
}> {
	const limit = Math.max(1, Math.min(500, Math.trunc(page.limit ?? 100)));
	const result = await sql<Selectable<AppLocationsTable> & { path: string[] }>`
		WITH matches AS (
			SELECT * FROM (${workerCaseOwnerPaths(appId, doc, persona)}) AS owners
			${page.after ? sql`WHERE place_id > ${page.after}::uuid` : sql``}
			ORDER BY place_id LIMIT ${limit + 1}
		)
		SELECT l.*, m.path FROM matches m JOIN app_locations l ON l.app_id = ${appId} AND l.id = m.place_id
		ORDER BY m.place_id
	`.execute(tx);
	const places = result.rows
		.slice(0, limit)
		.map((row) => ({ ...toPublicLocation(row), path: row.path }));
	return {
		places,
		nextAfter: result.rows.length > limit ? places[places.length - 1].id : null,
	};
}
