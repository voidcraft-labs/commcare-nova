/**
 * The read-only Connect conversion scan behind `scripts/scan-connect-activities.ts`:
 * convert every app still holding the released Connect shape in memory and
 * report whether the current document admits it, by identities, counts and
 * finding codes only.
 */
import { type Kysely, sql } from "kysely";
import { readReleasedFoldSnapshot } from "@/lib/case-store/migrations/20261208000000_connect_activity_roles";
import type { AppDatabase } from "@/lib/db/pg";
import { convert } from "@/lib/db/releasedConnectShape.mjs";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";

/** One app's outcome. `converted` apps open after the conversion; every other
 *  outcome names what stops it, by code or schema path only. */
export type AppOutcome =
	| {
			readonly appId: string;
			readonly projectId: string;
			readonly deleted: boolean;
			readonly outcome: "converted";
			readonly roles: readonly string[];
			readonly activities: Readonly<Record<string, number>>;
			readonly runsOnlyOn: string | null;
	  }
	| {
			readonly appId: string;
			readonly projectId: string;
			readonly deleted: boolean;
			readonly outcome:
				| "conversion-refused"
				| "schema-refused"
				| "gate-refused";
			readonly reasons: readonly string[];
	  };

/** A schema path with each record key, an identity, replaced by `*`. */
function placeOf(step: PropertyKey): string {
	if (typeof step === "number") return "[]";
	const text = String(step);
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		text,
	)
		? "*"
		: text;
}

function activityCounts(doc: {
	fields: Record<string, { kind: string; activity?: { kind: string } }>;
}): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const field of Object.values(doc.fields))
		if (field.kind === "connect_activity" && field.activity)
			counts[field.activity.kind] = (counts[field.activity.kind] ?? 0) + 1;
	return counts;
}

/** Every app whose `connect_roles` is NULL (or the one named), converted in
 *  one repeatable-read, read-only transaction. */
export async function scanConnectActivities(
	db: Kysely<AppDatabase>,
	appId?: string,
): Promise<AppOutcome[]> {
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const { rows } = await sql<{
				id: string;
				project_id: string;
				deleted: boolean;
			}>`SELECT id, project_id, deleted_at IS NOT NULL AS deleted
					FROM public.apps
					WHERE connect_roles IS NULL
						${appId === undefined ? sql`` : sql`AND id = ${appId}`}
					ORDER BY id`.execute(tx);
			const found: AppOutcome[] = [];
			for (const row of rows) {
				const base = {
					appId: row.id,
					projectId: row.project_id,
					deleted: row.deleted,
				};
				let snapshot: unknown;
				try {
					snapshot = convert(
						JSON.parse(
							await readReleasedFoldSnapshot(
								tx as unknown as Kysely<unknown>,
								row.id,
							),
						),
						{},
						{ appId: row.id },
					);
				} catch (error) {
					found.push({
						...base,
						outcome: "conversion-refused",
						reasons: [error instanceof Error ? error.message : String(error)],
					});
					continue;
				}
				const parsed = blueprintDocSchema.safeParse(snapshot);
				if (!parsed.success) {
					found.push({
						...base,
						outcome: "schema-refused",
						reasons: [
							...new Set(
								parsed.error.issues.map(
									(issue) =>
										`${issue.code} at ${issue.path.map(placeOf).join(".")}`,
								),
							),
						],
					});
					continue;
				}
				const doc = hydratePersistedBlueprint(parsed.data);
				const lookup = await readLookupDefinitionsInTransaction(
					tx,
					row.project_id,
					extractLookupReferenceTargets(doc).tableIds,
				);
				const verdict = mutationCommitVerdict(doc, [], {
					kind: "available",
					...lookup,
				});
				if (!verdict.ok) {
					found.push({
						...base,
						outcome: "gate-refused",
						reasons: [
							...new Set(verdict.findings.map((finding) => finding.code)),
						].sort(),
					});
					continue;
				}
				found.push({
					...base,
					outcome: "converted",
					roles: doc.connectRoles,
					activities: activityCounts(
						doc as unknown as Parameters<typeof activityCounts>[0],
					),
					runsOnlyOn: doc.appSettings.runsOnlyOn ?? null,
				});
			}
			return found;
		});
}

/** The fleet totals the scan prints. */
export function summarizeConnectScan(outcomes: readonly AppOutcome[]) {
	const tally = (outcome: AppOutcome["outcome"]) =>
		outcomes.filter((entry) => entry.outcome === outcome).length;
	const reasons = new Map<string, number>();
	for (const entry of outcomes)
		if (entry.outcome !== "converted")
			for (const reason of entry.reasons)
				reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
	const activities: Record<string, number> = {};
	for (const entry of outcomes)
		if (entry.outcome === "converted")
			for (const [kind, count] of Object.entries(entry.activities))
				activities[kind] = (activities[kind] ?? 0) + count;
	return {
		unconverted: outcomes.length,
		converted: tally("converted"),
		conversionRefused: tally("conversion-refused"),
		schemaRefused: tally("schema-refused"),
		gateRefused: tally("gate-refused"),
		withRoles: outcomes.filter(
			(entry) => entry.outcome === "converted" && entry.roles.length > 0,
		).length,
		activities,
		reasons: Object.fromEntries([...reasons].sort()),
	};
}
