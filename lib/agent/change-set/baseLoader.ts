/**
 * Exact base documents for change-set rehydration.
 *
 * The private candidate is DERIVED — the exact canonical base plus the
 * durable admitted steps — never stored. This module owns the two base
 * arms:
 *
 *   - **App edit:** `loadCanonicalBlueprintAtSequence` reconstructs the app
 *     at the recorded base sequence from the greatest immutable fold
 *     baseline at-or-below it plus the contiguous admitted `app_changes`
 *     suffix through it (`foldCanonicalAppChangeSuffixBounded` — exact
 *     mutation reduction, no lookup-context gate), then proves the result's
 *     canonical digest. Current app-head entities are never the base.
 *
 *   - **Genesis:** the canonical empty in-memory Blueprint carrying the
 *     proposed app id — never persisted as an app.
 *
 * Reads are lock-free by design: `app_changes` rows at-or-below a recorded
 * base sequence and fold baselines are immutable, and the contiguity plus
 * digest proofs reject any torn read louder than a lock would.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import { foldCanonicalAppChangeSuffixBounded } from "@/lib/db/canonicalMutationFold";
import type { AppDatabase } from "@/lib/db/pg";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import { canonicalJsonDigest } from "./digest";
import { ChangeSetIntegrityError } from "./errors";

export interface LoadedCanonicalBase {
	/** The hydrated document (fieldParent rebuilt; refIndex built lazily by
	 * the first apply). */
	readonly doc: BlueprintDoc;
	/** The exact persistable snapshot the digest is over. */
	readonly snapshot: PersistableDoc;
	/** Canonical JS JSON digest of `snapshot`. */
	readonly digest: string;
	/** The Project the fold arrived in at the target sequence. */
	readonly projectId: string;
}

/**
 * Reconstruct one app's exact canonical Blueprint at `seq`.
 *
 * `expectedDigest` is the digest recorded when the change set opened; a
 * replay that no longer reaches it is corruption, never silently adopted.
 * Pass `expectedDigest: null` for the recording read itself (beginChangeSet
 * verifies the fold against the live head snapshot instead).
 */
export async function loadCanonicalBlueprintAtSequence(
	db: Kysely<AppDatabase> | Transaction<AppDatabase>,
	args: {
		readonly appId: string;
		readonly seq: number;
		readonly expectedDigest: string | null;
	},
): Promise<LoadedCanonicalBase> {
	const baseline = await db
		.selectFrom("app_change_fold_baselines")
		.select(["seq", "project_id"])
		.select(
			sql<string>`${sql.ref("app_change_fold_baselines.snapshot")}::text`.as(
				"snapshot_text",
			),
		)
		.where("app_id", "=", args.appId)
		.where("seq", "<=", args.seq)
		.orderBy("seq", "desc")
		.limit(1)
		.executeTakeFirst();
	if (baseline === undefined) {
		throw new ChangeSetIntegrityError(
			`App ${args.appId} has no immutable fold baseline at or before sequence ${args.seq}, so its change-set base cannot be reconstructed.`,
		);
	}
	const baselineSeq = safePersistedSequence(
		baseline.seq,
		`app_change_fold_baselines.seq for app ${args.appId}`,
	);
	const suffix =
		baselineSeq === args.seq
			? []
			: await db
					.selectFrom("app_changes")
					.select([
						"seq",
						"batch_id",
						"run_id",
						"actor_id",
						"kind",
						"from_project_id",
						"to_project_id",
					])
					.select(
						sql<string>`${sql.ref("app_changes.mutations")}::text`.as(
							"mutations_text",
						),
					)
					.where("app_id", "=", args.appId)
					.where("seq", ">", baselineSeq)
					.where("seq", "<=", args.seq)
					.orderBy("seq", "asc")
					.execute();
	const folded = foldCanonicalAppChangeSuffixBounded({
		baselineSnapshotText: baseline.snapshot_text,
		baselineSeq,
		baselineProjectId: baseline.project_id,
		targetSeq: args.seq,
		suffix: suffix.map((row) => ({
			seq: row.seq,
			batch_id: row.batch_id,
			run_id: row.run_id,
			actor_id: row.actor_id,
			kind: row.kind,
			mutationsText: row.mutations_text,
			from_project_id: row.from_project_id,
			to_project_id: row.to_project_id,
		})),
	});
	const digest = canonicalJsonDigest(folded.snapshot);
	if (args.expectedDigest !== null && digest !== args.expectedDigest) {
		throw new ChangeSetIntegrityError(
			`App ${args.appId} at sequence ${args.seq} replays to digest ${digest}, but this change set recorded base digest ${args.expectedDigest}. The change set cannot be rehydrated.`,
		);
	}
	return {
		doc: hydratePersistedBlueprint(folded.snapshot),
		snapshot: folded.snapshot,
		digest,
		projectId: folded.projectId,
	};
}

export interface GenesisBase {
	readonly doc: BlueprintDoc;
	readonly snapshot: PersistableDoc;
	readonly digest: string;
}

/**
 * The canonical empty in-memory Blueprint a genesis change set builds over —
 * the ONE shared spelling (`lib/doc/scaffolds.ts::emptyBlueprintDoc`), so the
 * digest a change set records is exactly the base the prepared genesis
 * kernel replays from. Deterministic for one proposed app id; never
 * persisted as an app row.
 */
export function emptyGenesisBase(proposedAppId: string): GenesisBase {
	const snapshot = toPersistableDoc(emptyBlueprintDoc(proposedAppId));
	return {
		doc: hydratePersistedBlueprint(snapshot),
		snapshot,
		digest: canonicalJsonDigest(snapshot),
	};
}
