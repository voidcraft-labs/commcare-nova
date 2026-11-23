import "server-only";
import { type Selectable, sql, type Transaction } from "kysely";
import { z } from "zod";
import { resolveAppScopeInTransaction } from "@/lib/db/appAccess";
import {
	type AppDatabase,
	type AppLocationsTable,
	withAppTx,
} from "@/lib/db/pg";
import {
	levelHoldsWorkers,
	organizationLevelSchema,
	personaSchema,
	uuidSchema,
} from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { OrganizationError, organizationNotFound } from "./errors";
import {
	fixedLocationOwnerIssue,
	reverseVerdictMessage,
} from "./ownerTargetVerdicts";
import {
	organizationRevisionSchema,
	parseOrganizationRevision,
} from "./schema";
import { toPublicLocation } from "./storedLocation";
import {
	storedOwnerPaths,
	storedReverseOwnerVerdict,
} from "./storedOwnerVerdict";
import type { OrganizationScope } from "./types";

export const ruleReadRequest = z.strictObject({
	revision: organizationRevisionSchema,
	levels: z.array(organizationLevelSchema),
	personas: z.array(
		personaSchema.pick({ uuid: true, name: true, locations: true }),
	),
	fixed: z.array(uuidSchema),
	reverse: z.array(uuidSchema),
});
/** Use the same place proofs as a document commit, over the open editor's
 * proposed levels and assignments and the current authorized store revision. */
export function readPlaceRuleIssues(
	scope: OrganizationScope,
	input: z.output<typeof ruleReadRequest>,
) {
	return withAppTx(
		async (tx) => {
			const state = await stateFor(tx, scope);
			if (state.revision !== input.revision)
				throw new OrganizationError(
					"conflict",
					"The places changed. Refresh the organization and try again.",
				);
			const levels = Object.fromEntries(
				input.levels.map((level) => [level.uuid, level]),
			);
			const doc = {
				forms: {},
				organizationLevels: levels,
				personas: Object.fromEntries(
					input.personas.map((persona) => [persona.uuid, persona]),
				),
			};
			const rows = await storedOwnerPaths(tx, scope.appId, doc, input.fixed);
			const byId = new Map(rows.map((row) => [row.id, row]));
			for (const persona of input.personas) {
				const assignments = persona.locations
					? [
							persona.locations.primaryUuid,
							...(persona.locations.additionalUuids ?? []),
						]
					: [];
				for (const id of assignments) {
					const row = byId.get(id);
					if (
						!row ||
						row.archivedAt !== null ||
						!levels[row.levelUuid] ||
						!levelHoldsWorkers(levels[row.levelUuid])
					) {
						return {
							assignment: `Choose a live place at a level where ${persona.name} can work.`,
							fixed: {},
							reverse: {},
						};
					}
				}
			}
			const fixed: Record<string, string> = {},
				reverse: Record<string, string> = {};
			for (const id of new Set(input.fixed)) {
				const issue = fixedLocationOwnerIssue(doc, rows, id);
				if (issue) fixed[id] = issue;
			}
			for (const level of new Set(input.reverse)) {
				const result = await storedReverseOwnerVerdict(
					tx,
					scope.appId,
					doc,
					level,
				);
				if (result)
					reverse[level] = reverseVerdictMessage(
						result.verdict,
						state.hq
							? { domain: state.hq.domain, goneIds: result.gone }
							: undefined,
					);
			}
			return { assignment: undefined, fixed, reverse };
		},
		{ isolationLevel: "repeatable read" },
	);
}

export const placePageRequest = z.strictObject({
	parentId: uuidSchema.nullable().optional(),
	levelIds: z.array(uuidSchema).optional(),
	excludeId: uuidSchema.optional(),
	activeOnly: z.boolean().optional(),
	query: z.string().trim().max(255).optional(),
	cursor: z.string().max(2048).optional(),
	revision: organizationRevisionSchema.optional(),
	limit: z.number().int().min(1).max(100).optional(),
});
const cursorShape = z.strictObject({
	appId: z.string(),
	revision: organizationRevisionSchema,
	position: uuidSchema,
	orderKey: z.string().max(256),
	filter: z.string().max(512),
});
type PlacePage = z.infer<typeof placePageRequest>;

async function stateFor(
	tx: Transaction<AppDatabase>,
	scope: OrganizationScope,
) {
	const access = await resolveAppScopeInTransaction(
		tx,
		scope.appId,
		scope.actorUserId,
		"view",
	);
	if (scope.projectId !== access.projectId) throw organizationNotFound();
	const state = await tx
		.selectFrom("app_organization_state")
		.select([
			"revision",
			"location_count",
			"hq_domain",
			"hq_server",
			"hq_refreshed_at",
			"hq_left_out",
		])
		.where("app_id", "=", scope.appId)
		.executeTakeFirst();
	return {
		revision: parseOrganizationRevision(state?.revision ?? "0"),
		total: state?.location_count ?? 0,
		...(state?.hq_server && state.hq_domain && state.hq_refreshed_at
			? {
					hq: {
						server: state.hq_server,
						domain: state.hq_domain,
						refreshedAt: state.hq_refreshed_at.toISOString(),
						leftOut: state.hq_left_out ?? {},
						goneIds: [],
					},
				}
			: {}),
	};
}

export function readPlaceState(scope: OrganizationScope) {
	return withAppTx((tx) => stateFor(tx, scope), {
		isolationLevel: "repeatable read",
	});
}

/** Name resolution on the SA and MCP auth scope. Return all exact matches so
 * duplicate display names can never silently resolve to an arbitrary place. */
export function readPlaceNames(
	scope: OrganizationScope,
	names: readonly string[],
) {
	return withAppTx(
		async (tx) => {
			await stateFor(tx, scope);
			const valid = [...new Set(names)].filter(
				(name) => name.isWellFormed() && !name.includes("\0"),
			);
			const ids = valid.filter((key) => uuidSchema.safeParse(key).success);
			return (
				await sql<{
					uuid: import("@/lib/domain").Uuid;
					name: string;
					siteCode: string;
				}>`
			SELECT id AS uuid, name, site_code AS "siteCode" FROM app_locations
			WHERE app_id=${scope.appId} AND (id=ANY(${ids}::uuid[]) OR name=ANY(${valid}::text[]) OR site_code=ANY(${valid}::text[]))
		`.execute(tx)
			).rows;
		},
		{ isolationLevel: "repeatable read" },
	);
}

function decodeCursor(token: string) {
	try {
		return cursorShape.parse(
			JSON.parse(Buffer.from(token, "base64url").toString("utf8")),
		);
	} catch {
		throw new OrganizationError(
			"invalid",
			"That place page has expired. Open the first page again.",
		);
	}
}

/** The parent/id index finds the next siblings. Only the requested page's
 * ancestors are joined, for unambiguous paths even when names repeat. */
export function readPlacePage(scope: OrganizationScope, request: PlacePage) {
	return withAppTx(
		async (tx) => {
			const state = await stateFor(tx, scope);
			const cursor = request.cursor ? decodeCursor(request.cursor) : undefined;
			if (
				(cursor && cursor.revision !== state.revision) ||
				(request.revision !== undefined && request.revision !== state.revision)
			) {
				throw new OrganizationError(
					"conflict",
					"The places changed while you were browsing. Open the first page again.",
					{ currentRevision: state.revision },
				);
			}
			const query = request.query || "";
			const parentId = request.parentId;
			const filter = canonicalJsonDigest([
				parentId === undefined ? "all" : parentId,
				query,
				request.levelIds,
				request.excludeId,
				request.activeOnly,
			]);
			if (cursor && (cursor.appId !== scope.appId || cursor.filter !== filter))
				throw new OrganizationError(
					"invalid",
					"That page belongs to another search. Open the first page again.",
				);
			const limit = request.limit ?? 40;
			const parent =
				parentId === undefined
					? sql``
					: parentId === null
						? sql`AND p.parent_id IS NULL`
						: sql`AND p.parent_id = ${parentId}::uuid`;
			const levels = request.levelIds
				? sql`AND p.level_uuid = ANY(${request.levelIds}::uuid[])`
				: sql``;
			const excluded = request.excludeId
				? sql`AND p.id <> ${request.excludeId}::uuid`
				: sql``;
			const live = request.activeOnly ? sql`AND p.archived_at IS NULL` : sql``;
			const search = query
				? sql`AND (strpos(lower(p.name), lower(${query})) > 0 OR strpos(lower(p.site_code), lower(${query})) > 0 OR strpos(lower(p.external_id), lower(${query})) > 0)`
				: sql``;
			const after = cursor
				? sql`AND (p.order_key, p.id) > (${cursor.orderKey}, ${cursor.position}::uuid)`
				: sql``;
			const matching =
				parentId === undefined &&
				!query &&
				!request.levelIds &&
				!request.excludeId &&
				!request.activeOnly
					? state.total
					: Number(
							(
								await sql<{
									count: string;
								}>`SELECT count(*)::text AS count FROM app_locations p WHERE p.app_id = ${scope.appId} ${parent} ${search} ${levels} ${excluded} ${live}`.execute(
									tx,
								)
							).rows[0].count,
						);
			const results = await sql<
				Selectable<AppLocationsTable> & {
					children: boolean;
					previous_id: string | null;
					has_next: boolean;
					path: {
						id: string;
						name: string;
						siteCode: string;
						levelUuid: string;
						parentId: string | null;
						archivedAt: string | null;
					}[];
				}
			>`
			WITH RECURSIVE page AS (
				SELECT p.* FROM app_locations p WHERE p.app_id = ${scope.appId} ${parent} ${search} ${levels} ${excluded} ${live} ${after}
				ORDER BY p.order_key, p.id LIMIT ${limit + 1}
			), above (root, parent_id, path) AS (
				SELECT id,parent_id,'[]'::jsonb FROM page
				UNION ALL
				SELECT a.root,p.parent_id, jsonb_build_array(jsonb_build_object('id',p.id,'name',p.name,'siteCode',p.site_code,'parentId',p.parent_id,'levelUuid',p.level_uuid,'archivedAt',p.archived_at)) || a.path
				FROM above a JOIN app_locations p ON p.app_id = ${scope.appId} AND p.id = a.parent_id
			)
			SELECT page.*, a.path,
			(SELECT sibling.id FROM app_locations sibling WHERE sibling.app_id=page.app_id AND sibling.parent_id IS NOT DISTINCT FROM page.parent_id
				AND (sibling.order_key,sibling.id)<(page.order_key,page.id) ORDER BY sibling.order_key DESC,sibling.id DESC LIMIT 1) AS previous_id,
			EXISTS(SELECT 1 FROM app_locations sibling WHERE sibling.app_id=page.app_id AND sibling.parent_id IS NOT DISTINCT FROM page.parent_id
				AND (sibling.order_key,sibling.id)>(page.order_key,page.id)) AS has_next, EXISTS (SELECT 1 FROM app_locations c WHERE c.app_id = page.app_id AND c.parent_id = page.id) AS children
			FROM page JOIN above a ON page.id = a.root AND a.parent_id IS NULL ORDER BY page.order_key,page.id
		`.execute(tx);
			const rows = results.rows.slice(0, limit);
			const last = rows.at(-1);
			const nextCursor =
				last && results.rows.length > limit
					? Buffer.from(
							JSON.stringify({
								appId: scope.appId,
								revision: state.revision,
								filter,
								position: last.id,
								orderKey: last.order_key,
							}),
						).toString("base64url")
					: null;
			return {
				...state,
				matching,
				locations: rows.map((row) => {
					const place = toPublicLocation(row);
					return {
						...place,
						previousId: row.previous_id,
						hasNextSibling: row.has_next,
						hasChildren: row.children,
						path: row.path,
						gone: row.hq_gone_at !== null,
					};
				}),
				nextCursor,
			};
		},
		{ isolationLevel: "repeatable read" },
	);
}

/** The browser starts with the complete small organization or the exact
 * places referenced by the app and one example per level. Remaining rows
 * are visited through server pages. Occupancy is always measured in SQL. */
export function readPlaceOverview(scope: OrganizationScope) {
	return withAppTx(
		async (tx) => {
			const state = await stateFor(tx, scope);
			const paged = state.total > 100;
			const rows = await sql<Selectable<AppLocationsTable>>`
            WITH RECURSIVE selected(id,parent_id) AS (
                SELECT p.id,p.parent_id FROM app_locations p WHERE p.app_id=${scope.appId}
                ${
									paged
										? sql`AND (EXISTS(SELECT 1 FROM app_location_references r WHERE r.app_id=p.app_id AND r.location_id=p.id)
                    OR p.id IN (SELECT DISTINCT ON (sample.level_uuid) sample.id FROM app_locations sample
                        WHERE sample.app_id=${scope.appId} AND sample.archived_at IS NULL ORDER BY sample.level_uuid,sample.order_key,sample.id))`
										: sql``
								}
                UNION
                SELECT p.id,p.parent_id FROM selected s JOIN app_locations p ON p.app_id=${scope.appId} AND p.id=s.parent_id
            ) SELECT p.* FROM selected s JOIN app_locations p ON p.app_id=${scope.appId} AND p.id=s.id
            ORDER BY p.parent_id,p.order_key,p.id`.execute(tx);
			const occupancy = paged
				? (
						await sql<{
							level_uuid: string;
							kept: boolean;
						}>`SELECT level_uuid,bool_and(hq_gone_at IS NOT NULL) AS kept
			FROM app_locations WHERE app_id=${scope.appId} ${state.hq ? sql`AND archived_at IS NULL` : sql``} GROUP BY level_uuid`.execute(
							tx,
						)
					).rows
				: [];
			const locations = rows.rows.map((row) => {
				const place = toPublicLocation(row);
				return place;
			});
			return {
				revision: state.revision,
				locations,
				...(paged && {
					paged: {
						total: state.total,
						occupied: Object.fromEntries(
							occupancy.map((row) => [row.level_uuid, { kept: row.kept }]),
						),
					},
				}),
				...(state.hq && {
					hq: {
						...state.hq,
						goneIds: locations
							.filter(
								(row, index) =>
									row.archivedAt === null &&
									rows.rows[index].hq_gone_at !== null,
							)
							.map((row) => row.id),
					},
				}),
			};
		},
		{ isolationLevel: "repeatable read" },
	);
}
