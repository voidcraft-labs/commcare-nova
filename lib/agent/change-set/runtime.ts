/**
 * Overlay rehydration — the private candidate derived from the exact base
 * plus the durable admitted steps.
 *
 * Replay is deterministic and total: every step holds exact admitted
 * canonical mutations whose reducers are deterministic, so any process at
 * any time reconstructs byte-identical state (`§20.6`). A reducer throw
 * during replay is corruption — steps were proved replayable before they
 * appended — and surfaces as an integrity error, never a silent skip.
 *
 * Cache discipline: callers may memoize `(changeSetId, revision) → overlay`
 * (the workspace does), but every cache miss rehydrates from the durable
 * base and steps, and cache contents are discardable — never correctness
 * authorities.
 */

import { produce } from "immer";
import { parsePersistedMutationBatchText } from "@/lib/db/persistedJson";
import { getAppDb } from "@/lib/db/pg";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { encodeAdmittedMutationEnvelope } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import {
	emptyGenesisBase,
	loadCanonicalBlueprintAtSequence,
} from "./baseLoader";
import { canonicalJsonDigest } from "./digest";
import { ChangeSetIntegrityError } from "./errors";
import { loadChangeSetSteps } from "./store";
import type { ChangeSetStep, DesignChangeSet } from "./types";

export interface RehydratedOverlay {
	readonly doc: BlueprintDoc;
	readonly snapshot: PersistableDoc;
	readonly candidateDigest: string;
}

/** Apply the admitted steps over one base document. Pure. */
export function replayStepsOverBase(
	base: BlueprintDoc,
	steps: readonly ChangeSetStep[],
): RehydratedOverlay {
	// Staging and checkpoint commits reduce one complete batch. In particular,
	// reducer cleanup (such as pruning translations) must run at that same
	// boundary, not once per historical tool invocation.
	const batch = parsePersistedMutationBatchText(
		encodeAdmittedMutationEnvelope(steps.flatMap((step) => [...step.mutations]))
			.json,
		"private authoring replay batch",
	);
	let doc: BlueprintDoc;
	try {
		doc = produce(base, (draft) => {
			applyMutations(draft, batch);
		});
	} catch (error) {
		throw new ChangeSetIntegrityError(
			`The pending authoring batch no longer replays over its base: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const snapshot = toPersistableDoc(doc);
	return { doc, snapshot, candidateDigest: canonicalJsonDigest(snapshot) };
}

export interface RehydratedChangeSet {
	readonly overlay: RehydratedOverlay;
	readonly baseDoc: BlueprintDoc;
	readonly steps: readonly ChangeSetStep[];
}

/**
 * Rehydrate one change set from durable state: exact base (digest-proved)
 * plus its ordered mutation batches.
 */
export async function rehydrateChangeSet(
	changeSet: DesignChangeSet,
): Promise<RehydratedChangeSet> {
	const db = await getAppDb();
	const steps = await loadChangeSetSteps(changeSet.id, db);
	if (steps.length !== changeSet.nextOrdinal) {
		throw new ChangeSetIntegrityError(
			`Change set ${changeSet.id} records ${changeSet.nextOrdinal} step(s) but ${steps.length} are stored.`,
		);
	}
	let baseDoc: BlueprintDoc;
	if (changeSet.kind === "app-edit") {
		if (changeSet.appId === null || changeSet.baseSeq === null) {
			throw new ChangeSetIntegrityError(
				`Change set ${changeSet.id} is app-edit but carries no app/base sequence.`,
			);
		}
		const base = await loadCanonicalBlueprintAtSequence(db, {
			appId: changeSet.appId,
			seq: changeSet.baseSeq,
			expectedDigest: changeSet.baseSnapshotDigest,
		});
		if (base.projectId !== changeSet.baseProjectId) {
			throw new ChangeSetIntegrityError(
				`Change set ${changeSet.id} recorded base Project ${changeSet.baseProjectId}, but the fold at sequence ${changeSet.baseSeq} arrives in ${base.projectId}.`,
			);
		}
		baseDoc = base.doc;
	} else {
		if (changeSet.proposedAppId === null) {
			throw new ChangeSetIntegrityError(
				`Change set ${changeSet.id} is genesis but carries no proposed app id.`,
			);
		}
		const base = emptyGenesisBase(changeSet.proposedAppId);
		if (base.digest !== changeSet.baseSnapshotDigest) {
			throw new ChangeSetIntegrityError(
				`Change set ${changeSet.id} recorded genesis base digest ${changeSet.baseSnapshotDigest}, but the canonical empty base derives ${base.digest}.`,
			);
		}
		baseDoc = base.doc;
	}
	const overlay = replayStepsOverBase(baseDoc, steps);
	return {
		overlay,
		baseDoc,
		steps,
	};
}
