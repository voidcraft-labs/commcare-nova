/**
 * The recordings of held placements: what the latest recording wrote for
 * each target. A recording is a `holdPlacements` entry of a row whose kind
 * records placements (`placementAuthority.ts::PLACEMENT_RECORDING_KINDS`)
 * above the app's greatest fold baseline, or, for a target no such row names,
 * the hold that baseline's snapshot holds, since a cutover writes its holds
 * into each app's baseline rather than as mutations.
 *
 * Read by the commit kernel under the app lock, for the keys an editor's
 * batch needs justified, and by the builder's snapshot read, for the keys the
 * document it returns holds. Every table is named with its schema.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import {
	NO_RECORDED_HOLDS,
	type PlacementHold,
	type PlacementHoldEntry,
	placementTargetKey,
	type RecordedPlacementHolds,
	readPlacementHolds,
} from "@/lib/doc/placementHolds";
import { parseFoldBaselineSnapshot } from "./canonicalMutationFold";
import { parsePersistedMutationBatchText } from "./persistedJson";
import type { AppDatabase } from "./pg";
import { PLACEMENT_RECORDING_KINDS } from "./placementAuthority";

/** A `jsonb` containment probe for a batch holding a `holdPlacements`. */
const HOLDS_PLACEMENTS = JSON.stringify([{ kind: "holdPlacements" }]);

/**
 * The hold the latest recording wrote for each of `keys`: the newest
 * recording row above the app's greatest fold baseline whose
 * `holdPlacements` names the target, else the hold that baseline's snapshot
 * holds. A key whose latest recording cleared it, or that no recording names,
 * is absent. An empty `keys` reads nothing.
 */
export async function readRecordedPlacementHolds(
	db: Kysely<AppDatabase> | Transaction<AppDatabase>,
	appId: string,
	keys: readonly string[],
): Promise<RecordedPlacementHolds> {
	if (keys.length === 0) return NO_RECORDED_HOLDS;
	const asked = new Set(keys);
	const qualified = db.withSchema("public");
	const baseline = await qualified
		.selectFrom("app_change_fold_baselines")
		.select("seq")
		.where("app_id", "=", appId)
		.orderBy("seq", "desc")
		.limit(1)
		.executeTakeFirst();

	let rows = qualified
		.selectFrom("app_changes")
		.select("seq")
		.select(
			sql<string>`${sql.ref("app_changes.mutations")}::text`.as(
				"mutations_text",
			),
		)
		.where("app_id", "=", appId)
		.where("kind", "in", [...PLACEMENT_RECORDING_KINDS])
		.where(
			sql<boolean>`${sql.ref("app_changes.mutations")} @> ${HOLDS_PLACEMENTS}::jsonb`,
		);
	if (baseline !== undefined) rows = rows.where("seq", ">", baseline.seq);
	const recordings = await rows.orderBy("seq", "desc").execute();

	// Each asked key's latest entry, a clearing one included, so an older
	// recording or the baseline never answers a key a newer row cleared.
	const latest = new Map<string, PlacementHoldEntry>();
	for (const row of recordings) {
		const batch = parsePersistedMutationBatchText(
			row.mutations_text,
			`app_changes.mutations for app ${appId}, sequence ${row.seq}`,
		);
		for (let m = batch.length - 1; m >= 0; m--) {
			const mutation = batch[m];
			if (mutation.kind !== "holdPlacements") continue;
			for (let h = mutation.holds.length - 1; h >= 0; h--) {
				const entry = mutation.holds[h];
				const key = placementTargetKey(entry);
				if (asked.has(key) && !latest.has(key)) latest.set(key, entry);
			}
		}
		if (latest.size === asked.size) break;
	}

	if (latest.size < asked.size && baseline !== undefined) {
		const snapshot = await qualified
			.selectFrom("app_change_fold_baselines")
			.select(
				sql<string>`${sql.ref("app_change_fold_baselines.snapshot")}::text`.as(
					"snapshot_text",
				),
			)
			.where("app_id", "=", appId)
			.where("seq", "=", baseline.seq)
			.executeTakeFirstOrThrow();
		const baselineHolds = readPlacementHolds(
			parseFoldBaselineSnapshot(snapshot.snapshot_text),
		);
		for (const key of asked) {
			if (latest.has(key)) continue;
			const hold = baselineHolds.get(key);
			if (hold !== undefined) latest.set(key, hold);
		}
	}

	const recorded = new Map<string, PlacementHold>();
	for (const [key, entry] of latest) {
		if (entry.placement !== null) recorded.set(key, entry as PlacementHold);
	}
	return recorded;
}
