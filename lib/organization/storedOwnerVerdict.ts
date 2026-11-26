import "server-only";

import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import {
	ancestorLevels,
	assignedLocationUuids,
	levelOwnsCases,
	organizationLevelsOf,
	personasOf,
} from "@/lib/domain";
import {
	type OrganizationRuleInputs,
	ownerVerdictRows,
	type ReverseLocationOwnerVerdict,
	reverseLocationOwnerVerdict,
} from "./ownerTargetVerdicts";
import { workerFootprintIds } from "./workerFootprint";
import { workerCaseOwnerPaths } from "./workerPlaces";

/** Each source expands down the indexed local parent relation. A ragged
 * branch stopping before the destination yields zero; a second match is all
 * the evidence the editor needs, however many more places that source has. */
export async function storedReverseOwnerVerdict(
	tx: Transaction<AppDatabase>,
	appId: string,
	doc: OrganizationRuleInputs,
	levelId: string,
	archiving: readonly string[] = [],
): Promise<{
	verdict: ReverseLocationOwnerVerdict;
	gone: ReadonlySet<string>;
} | null> {
	const levels = organizationLevelsOf(doc);
	const level = levels[levelId];
	const source = level && ancestorLevels(level, levels).find(levelOwnsCases);
	if (!level || !levelOwnsCases(level) || !source) {
		const verdict = reverseLocationOwnerVerdict(doc, [], levelId);
		return verdict ? { verdict, gone: new Set() } : null;
	}
	const availableSources = archiving.length
		? sql`AND NOT(id=ANY(${archiving}::uuid[]))`
		: sql``;
	const availableChildren = archiving.length
		? sql`AND NOT(c.id=ANY(${archiving}::uuid[]))`
		: sql``;
	const branches = sql`WITH RECURSIVE branches(owner,id,level) AS (
		SELECT id,id,level_uuid FROM app_locations WHERE app_id=${appId} AND level_uuid=${source.uuid} AND archived_at IS NULL ${availableSources}
		UNION ALL
		SELECT b.owner,c.id,c.level_uuid FROM branches b JOIN app_locations c ON c.app_id=${appId} AND c.parent_id=b.id
		WHERE c.archived_at IS NULL ${availableChildren} AND b.level <> ${level.uuid}::uuid AND c.level_uuid <> ${source.uuid}::uuid
	) SELECT owner,id,level FROM branches`;
	const counts = await sql<{ owner: string; places: string[] }>`
		WITH branch AS (${branches}), pairs AS (
			SELECT owner,id,row_number() OVER (PARTITION BY owner ORDER BY id) AS rank FROM branch WHERE level=${level.uuid}::uuid
		) SELECT b.owner,coalesce(array_agg(p.id ORDER BY p.id) FILTER (WHERE p.id IS NOT NULL),'{}'::uuid[]) AS places
		FROM branch b LEFT JOIN pairs p ON p.owner=b.id AND p.rank <= 2
		WHERE b.id=b.owner GROUP BY b.owner HAVING count(p.id) <> 1
		ORDER BY count(p.id) DESC,b.owner LIMIT 1
	`.execute(tx);
	const mismatch = counts.rows[0];
	if (mismatch) {
		const rows = await tx
			.selectFrom("app_locations")
			.select([
				"id",
				"parent_id",
				"level_uuid",
				"name",
				"archived_at",
				"hq_gone_at",
			])
			.where("app_id", "=", appId)
			.where("id", "in", [mismatch.owner, ...mismatch.places])
			.execute();
		const byId = new Map(ownerVerdictRows(rows).map((row) => [row.id, row]));
		const owner = byId.get(mismatch.owner);
		if (!owner)
			throw new Error("A checked case owner disappeared from its transaction.");
		const gone = new Set(
			rows.filter((row) => row.hq_gone_at !== null).map((row) => row.id),
		);
		const [first, second] = mismatch.places.map((id) => byId.get(id));
		return {
			verdict:
				first && second
					? {
							kind: "ambiguous",
							level: level.name,
							source: owner,
							first,
							second,
						}
					: { kind: "none-below", level: level.name, source: owner },
			gone,
		};
	}
	for (const persona of Object.values(personasOf(doc))) {
		if (!assignedLocationUuids(persona.locations).length) continue;
		const missing = await sql<{
			id: string;
			name: string;
			parent_id: string | null;
			level_uuid: string;
			archived_at: null;
		}>`
			WITH branches AS (${branches}), owners AS (${workerCaseOwnerPaths(appId, doc, persona)}), footprint AS (${workerFootprintIds(appId, doc, persona)})
			SELECT p.id,p.name,p.parent_id,p.level_uuid,p.archived_at FROM branches b
			JOIN owners w ON w.place_id=b.owner JOIN app_locations p ON p.app_id=${appId} AND p.id=b.id
			WHERE b.level=${level.uuid}::uuid AND NOT EXISTS(SELECT 1 FROM footprint f WHERE f.id=b.id)
			ORDER BY p.id LIMIT 1
		`.execute(tx);
		const [destination] = ownerVerdictRows(missing.rows);
		if (destination)
			return {
				verdict: {
					kind: "outside-address-book",
					level: level.name,
					persona: persona.name,
					destination,
				},
				gone: new Set(),
			};
	}
	return null;
}

// Fixed owner visibility depends only on the selected places, the persona's
// assignments, and their paths to the root, even for a shared address book.
export async function storedOwnerPaths(
	tx: Transaction<AppDatabase>,
	appId: string,
	doc: OrganizationRuleInputs,
	ids: readonly string[],
) {
	const starts = [
		...new Set([
			...ids,
			...Object.values(personasOf(doc)).flatMap((persona) =>
				assignedLocationUuids(persona.locations),
			),
		]),
	];
	const rows = await sql<{
		id: string;
		parent_id: string | null;
		name: string;
		level_uuid: string;
		archived_at: Date | null;
	}>`
        WITH RECURSIVE paths(id,parent_id,name,level_uuid,archived_at) AS (
            SELECT id,parent_id,name,level_uuid,archived_at FROM app_locations WHERE app_id=${appId} AND id=ANY(${starts}::uuid[])
            UNION
            SELECT p.id,p.parent_id,p.name,p.level_uuid,p.archived_at FROM paths a JOIN app_locations p ON p.app_id=${appId} AND p.id=a.parent_id
        ) SELECT * FROM paths`.execute(tx);
	return ownerVerdictRows(rows.rows);
}
