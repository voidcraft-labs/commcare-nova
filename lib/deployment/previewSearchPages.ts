import "server-only";
import { sql } from "kysely";
import { z } from "zod";
import {
	AppAccessError,
	resolveAppScopeInTransaction,
} from "@/lib/db/appAccess";
import { withAppTx } from "@/lib/db/pg";
import {
	fuzzySearchPropertySchema,
	ignoredSearchTextSchema,
	localSearchDefaults,
	type PreviewSearchTarget,
	previewSearchTargetKey,
	previewSearchTargetSchema,
} from "@/lib/preview/searchSettings";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { readPreviewDeploymentRecordsIn } from "./previewRecords";
import { previewSearchTargets } from "./previewSearchSettings";

const pageSize = 12;
export const previewSearchPageSchema = z.strictObject({
	target: previewSearchTargetSchema
		.optional()
		.describe(
			"Omit to list destinations. Choose a listed target to read every matching rule in order.",
		),
	cursor: z
		.strictObject({
			version: z.string().regex(/^[a-f0-9]{64}$/),
			offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		})
		.optional()
		.describe(
			"Pass nextCursor from the same app and target. Omit to start or restart.",
		),
});

const targetTable = (targets: PreviewSearchTarget[]) =>
	sql`jsonb_to_recordset(${JSON.stringify(targets.map((t) => (t.kind === "local" ? { server: "local", domain: "" } : { server: t.server, domain: t.domain })))}::jsonb) AS t(server text, domain text)`;
type Summary = {
	target: PreviewSearchTarget;
	revision: string;
	maximum: 500 | 1500 | null;
	timeZone: string | null;
	matching: { fuzzyProperties: number; ignoredText: number } | null;
};

export async function readPreviewSearchPage(
	appId: string,
	projectId: string,
	actorId: string,
	input: z.infer<typeof previewSearchPageSchema>,
) {
	return withAppTx(
		async (tx) => {
			const access = await resolveAppScopeInTransaction(
				tx,
				appId,
				actorId,
				"view",
			);
			if (access.projectId !== projectId) throw new AppAccessError("not_found");
			const eligible = previewSearchTargets(
				await readPreviewDeploymentRecordsIn(tx, { appId, projectId }),
			);
			const key = input.target && previewSearchTargetKey(input.target);
			const targets = eligible
				.filter((t) => !key || previewSearchTargetKey(t) === key)
				.sort((a, b) => {
					const left = previewSearchTargetKey(a),
						right = previewSearchTargetKey(b);
					return left < right ? -1 : left > right ? 1 : 0;
				});
			if (!targets.length)
				return {
					error:
						"This destination is no longer available. List the current destinations to choose one.",
					code: "target-unavailable",
				};
			const { rows } = await sql<{
				server: string;
				domain: string;
				revision: string | null;
				maximum: 500 | 1500 | null;
				time_zone: string | null;
				fuzzy_count: number | null;
				ignored_count: number | null;
			}>`SELECT t.server,t.domain,s.revision::text,
			(s.settings->>'maximum')::integer AS maximum, s.settings->>'timeZone' AS time_zone,
			jsonb_array_length(s.settings->'propertyMatchers'->'fuzzyProperties') AS fuzzy_count,
			jsonb_array_length(s.settings->'propertyMatchers'->'ignoredText') AS ignored_count
			FROM ${targetTable(targets)} LEFT JOIN preview_search_settings s
			ON s.project_id=${projectId} AND s.server=t.server AND s.domain=t.domain`.execute(
				tx,
			);
			const byKey = new Map(
				rows.map((row) => [JSON.stringify([row.server, row.domain]), row]),
			);
			const summaries = targets.map((target): Summary => {
				const local = target.kind === "local";
				const row = byKey.get(
					local
						? JSON.stringify(["local", ""])
						: previewSearchTargetKey(target),
				);
				if (!row) throw new Error("Missing an eligible destination summary");
				if (row.revision === null && local)
					return {
						target,
						revision: "0",
						maximum: localSearchDefaults.maximum,
						timeZone: localSearchDefaults.timeZone,
						matching: { fuzzyProperties: 0, ignoredText: 0 },
					};
				return {
					target,
					revision: row.revision ?? "0",
					maximum: row.maximum,
					timeZone: row.time_zone,
					matching:
						row.fuzzy_count === null
							? null
							: {
									fuzzyProperties: row.fuzzy_count,
									ignoredText: row.ignored_count ?? 0,
								},
				};
			});
			const version = canonicalJsonDigest([
				appId,
				projectId,
				key ?? null,
				summaries.map((s) => [s.target, s.revision]),
			]);
			const offset = input.cursor?.offset ?? 0;
			const first = summaries[0];
			const fuzzy = first.matching?.fuzzyProperties ?? 0;
			const count = key
				? fuzzy + (first.matching?.ignoredText ?? 0)
				: summaries.length;
			if (input.cursor && (input.cursor.version !== version || offset >= count))
				return {
					error:
						"These settings changed or this page belongs to a different selection. Start again without the cursor.",
					code: "restart",
				};
			const end = Math.min(offset + pageSize, count);
			const nextCursor = end < count ? { version, offset: end } : null;
			if (!input.target)
				return { profiles: summaries.slice(offset, end), nextCursor };
			const { server, domain } =
				input.target.kind === "local"
					? { server: "local", domain: "" }
					: input.target;
			const items =
				end === offset
					? []
					: (
							await sql<{
								i: number;
								row: unknown;
							}>`SELECT i, CASE WHEN i<${fuzzy} THEN
			s.settings->'propertyMatchers'->'fuzzyProperties'->i ELSE
			s.settings->'propertyMatchers'->'ignoredText'->(i-${fuzzy}) END AS row
			FROM preview_search_settings s CROSS JOIN generate_series(${offset}::integer,${end - 1}::integer) i
			WHERE s.project_id=${projectId} AND s.server=${server} AND s.domain=${domain} ORDER BY i`.execute(
								tx,
							)
						).rows;
			return {
				profile: first,
				rules: items.map(({ i, row }) =>
					i < fuzzy
						? {
								list: "fuzzyProperties",
								index: i,
								...fuzzySearchPropertySchema.parse(row),
							}
						: {
								list: "ignoredText",
								index: i - fuzzy,
								...ignoredSearchTextSchema.parse(row),
							},
				),
				nextCursor,
			};
		},
		{ isolationLevel: "repeatable read" },
	);
}
