/**
 * History-preserving writer for the hidden value-source repair. The pure
 * scan, report, and planner live in `hiddenValueBothSourcesScan.ts` (read the
 * header there for why the repair exists and why it ships one release before
 * the validator rule); this module owns everything that touches the database.
 *
 * Modeled on `selectOptionValueRepair.ts` with two deliberate differences:
 *
 *   1. Candidates INCLUDE soft-deleted apps. The migration probe audits every
 *      row and a restored app must load, so a deleted offender would fail the
 *      release exactly like a live one.
 *   2. The batch id carries the expected base sequence
 *      (`hidden-value-both-sources-v1:<appId>:<seq>`), so a retry after a
 *      crash dedupes against the same head while a later run against a new
 *      head is a fresh batch.
 *
 * The document lands through `appendSyntheticBatch`, which derives the
 * mutations, proves replay identity, and requires the target to be
 * gate-clean.
 */

import { appendSyntheticBatch } from "../../lib/db/apps";
import { BlueprintCommitRejectedError } from "../../lib/db/commitGuard";
import { getAppDb } from "../../lib/db/pg";
import { planHiddenValueBothSourcesRepair } from "./hiddenValueBothSourcesScan";
import {
	loadPersistedBlueprintSnapshot,
	type PersistedBlueprintSnapshot,
} from "./loadPersistedBlueprint";

const REPAIR_ACTOR = "system:hidden-value-both-sources" as const;
const REPAIR_BATCH_PREFIX = "hidden-value-both-sources-v1";
const REPAIR_REASON =
	"Drop the dead default_value from hidden fields that also carry a calculate: the form evaluates every calculate after it seeds defaults, so only the calculate ever took effect.";

/** Every app, soft-deleted included, oldest first. See the header: the
 *  migration probe audits deleted rows and a restored app must load. */
export async function listHiddenValueBothSourcesCandidateAppIds(): Promise<
	string[]
> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("apps")
		.select("id")
		.orderBy("created_at")
		.orderBy("id")
		.execute();
	return rows.map((row) => row.id);
}

export type HiddenValueBothSourcesRepairSnapshot = PersistedBlueprintSnapshot;
export const loadHiddenValueBothSourcesRepairSnapshot =
	loadPersistedBlueprintSnapshot;

/**
 * An app this repair could not converge: the gate still refuses the repaired
 * document for a finding the repair does not own, the app moved under the
 * prepared snapshot, or the write itself failed. The repair names it and
 * moves on rather than holding the fleet hostage.
 */
export interface HiddenValueBothSourcesRepairBlock {
	readonly appId: string;
	readonly appName: string;
	readonly reason: string;
}

export interface HiddenValueBothSourcesRepairReport {
	readonly scannedApps: number;
	readonly repairedApps: number;
	readonly clearedFields: number;
	readonly blockedApps: readonly HiddenValueBothSourcesRepairBlock[];
}

/**
 * Repair each selected app as one `blueprint-migration` batch under the
 * system actor. An app with nothing to clear is skipped, so a rerun after a
 * completed run writes nothing. Per-app refusals are reported and the next
 * app still runs; a snapshot that cannot load is terminal because reporting
 * per-app results over unreadable data would mislead. The CLI exits nonzero
 * when any app remains blocked.
 */
/**
 * Walk every candidate app and clear the pair. `dryRun` performs the same
 * snapshot and plan but writes nothing, so its counts are exactly what the
 * write would touch; `repairedApps` / `clearedFields` then count planned
 * repairs.
 */
export async function runHiddenValueBothSourcesRepair(
	appIds: readonly string[],
	options: { readonly dryRun?: boolean } = {},
): Promise<HiddenValueBothSourcesRepairReport> {
	let scannedApps = 0;
	let repairedApps = 0;
	let clearedFields = 0;
	const blockedApps: HiddenValueBothSourcesRepairBlock[] = [];
	for (const appId of appIds) {
		const snapshot = await loadHiddenValueBothSourcesRepairSnapshot(appId);
		if (snapshot === null) continue;
		scannedApps++;
		const plan = planHiddenValueBothSourcesRepair(snapshot.blueprint);
		if (plan.cleared.length === 0) continue;
		if (options.dryRun) {
			repairedApps++;
			clearedFields += plan.cleared.length;
			continue;
		}
		try {
			const result = await appendSyntheticBatch({
				appId,
				expectedBaseSeq: snapshot.mutationSeq,
				targetDoc: plan.targetDoc,
				batchId: `${REPAIR_BATCH_PREFIX}:${appId}:${snapshot.mutationSeq}`,
				authority: {
					kind: "system",
					actorId: REPAIR_ACTOR,
					reason: REPAIR_REASON,
				},
			});
			if (result.kind === "committed") {
				repairedApps++;
				clearedFields += plan.cleared.length;
			}
		} catch (error) {
			blockedApps.push({
				appId,
				appName: snapshot.appName,
				reason:
					error instanceof BlueprintCommitRejectedError
						? error.message
						: error instanceof Error
							? `${error.name}: ${error.message}`
							: String(error),
			});
		}
	}
	return { scannedApps, repairedApps, clearedFields, blockedApps };
}
