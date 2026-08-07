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
import { getAppDb } from "@/lib/db/pg";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import {
	emptyGenesisBase,
	loadCanonicalBlueprintAtSequence,
} from "./baseLoader";
import { canonicalJsonDigest } from "./digest";
import { ChangeSetIntegrityError } from "./errors";
import { externalContextDigest, normalizeReadSet } from "./readSets";
import type { ExternalReadDependency } from "./schemas";
import { loadChangeSetSteps, loadHandleBindings } from "./store";
import type {
	ChangeSetHandleBinding,
	ChangeSetStep,
	DesignChangeSet,
} from "./types";

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
	let doc = base;
	for (const step of steps) {
		try {
			doc = produce(doc, (draft) => {
				applyMutations(draft, step.mutations);
			});
		} catch (error) {
			throw new ChangeSetIntegrityError(
				`Step ${step.ordinal} (${step.toolName}) no longer replays over its base: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	const snapshot = toPersistableDoc(doc);
	return { doc, snapshot, candidateDigest: canonicalJsonDigest(snapshot) };
}

export interface RehydratedChangeSet {
	readonly overlay: RehydratedOverlay;
	readonly baseDoc: BlueprintDoc;
	readonly steps: readonly ChangeSetStep[];
	readonly handles: readonly ChangeSetHandleBinding[];
	readonly accumulatedReadSet: readonly ExternalReadDependency[];
	readonly externalContextDigest: string;
}

/**
 * Rehydrate one change set from durable state: exact base (digest-proved)
 * plus steps, handles, and the accumulated read set.
 */
export async function rehydrateChangeSet(
	changeSet: DesignChangeSet,
): Promise<RehydratedChangeSet> {
	const db = await getAppDb();
	const [steps, handles] = await Promise.all([
		loadChangeSetSteps(changeSet.id, db),
		loadHandleBindings(changeSet.id, db),
	]);
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
	const accumulated = normalizeReadSet(steps.flatMap((step) => step.readSet));
	return {
		overlay,
		baseDoc,
		steps,
		handles,
		accumulatedReadSet: accumulated,
		externalContextDigest: externalContextDigest(accumulated),
	};
}
