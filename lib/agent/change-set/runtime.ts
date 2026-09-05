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
import {
	authoredBlueprintIdentities,
	type BlueprintAuthoredIdentityKind,
	type BlueprintDoc,
	type PersistableDoc,
} from "@/lib/domain";
import {
	emptyGenesisBase,
	loadCanonicalBlueprintAtSequence,
} from "./baseLoader";
import { canonicalJsonDigest } from "./digest";
import { ChangeSetIntegrityError } from "./errors";
import { externalContextDigest, normalizeReadSet } from "./readSets";
import type { ExternalReadDependency, StagedEntityKind } from "./schemas";
import {
	loadChangeSetSteps,
	loadHandleBindings,
	loadPriorCommittedPlanHandleBindings,
} from "./store";
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

const AUTHORED_KIND_BY_STAGED_KIND: Readonly<
	Record<StagedEntityKind, BlueprintAuthoredIdentityKind>
> = {
	entry_point: "entryPoint",
	module: "module",
	form: "form",
	field: "field",
	option: "selectOption",
	case_list_column: "caseListColumn",
	search_input: "searchInput",
	case_operation: "caseOperation",
	worker_property: "userProperty",
	user_type: "userType",
	persona: "persona",
	organization_level: "organizationLevel",
	location_property: "locationProperty",
	automation: "automation",
	automation_criterion: "automationCriterion",
	automation_setup_criterion: "automationSetupOnlyCriterion",
	automation_update: "automationUpdate",
	automation_recipient: "automationRecipient",
	automation_event: "automationEvent",
	automation_user_data_filter: "automationUserDataFilter",
};

function verifiedPlanHandles(
	changeSet: DesignChangeSet,
	baseDoc: BlueprintDoc,
	overlayDoc: BlueprintDoc,
	local: readonly ChangeSetHandleBinding[],
	inherited: readonly ChangeSetHandleBinding[],
): ChangeSetHandleBinding[] {
	const baseKinds = new Map(
		authoredBlueprintIdentities(baseDoc).map((identity) => [
			identity.uuid,
			identity.kind,
		]),
	);
	const overlayKinds = new Map(
		authoredBlueprintIdentities(overlayDoc).map((identity) => [
			identity.uuid,
			identity.kind,
		]),
	);
	const byHandle = new Map<string, ChangeSetHandleBinding>();
	const byUuid = new Map<string, ChangeSetHandleBinding>();
	for (const binding of inherited) {
		const baseKind = baseKinds.get(binding.uuid);
		const expectedKind = AUTHORED_KIND_BY_STAGED_KIND[binding.entityKind];
		/* A later committed slice may intentionally delete an earlier entity.
		 * Its old symbol is no longer seedable; absence is a prune, while a UUID
		 * surviving under another kind is corruption. */
		if (baseKind === undefined) continue;
		if (baseKind !== expectedKind) {
			throw new ChangeSetIntegrityError(
				`Change set ${changeSet.id} cannot inherit ${binding.handle}: its ${binding.entityKind} UUID has kind ${baseKind} in the exact base.`,
			);
		}
		const overlayKind = overlayKinds.get(binding.uuid);
		if (overlayKind === undefined) continue;
		if (overlayKind !== expectedKind) {
			throw new ChangeSetIntegrityError(
				`Change set ${changeSet.id} cannot restore ${binding.handle}: its replayed private candidate carries kind ${overlayKind}.`,
			);
		}
		const priorHandle = byHandle.get(binding.handle);
		const priorUuid = byUuid.get(binding.uuid);
		if (
			(priorHandle !== undefined &&
				(priorHandle.uuid !== binding.uuid ||
					priorHandle.entityKind !== binding.entityKind)) ||
			(priorUuid !== undefined && priorUuid.handle !== binding.handle)
		) {
			throw new ChangeSetIntegrityError(
				`Accepted plan ${changeSet.buildPlanId} contains conflicting durable handle bindings before slice ${changeSet.sliceId}.`,
			);
		}
		byHandle.set(binding.handle, binding);
		byUuid.set(binding.uuid, binding);
	}
	for (const binding of local) {
		const actualKind = overlayKinds.get(binding.uuid);
		const expectedKind = AUTHORED_KIND_BY_STAGED_KIND[binding.entityKind];
		if (actualKind === undefined) continue;
		if (actualKind !== expectedKind) {
			throw new ChangeSetIntegrityError(
				`Change set ${changeSet.id} bound ${binding.handle} as ${binding.entityKind}, but its final private candidate carries kind ${actualKind}.`,
			);
		}
		if (byHandle.has(binding.handle) || byUuid.has(binding.uuid)) {
			throw new ChangeSetIntegrityError(
				`Change set ${changeSet.id} redeclared a durable handle inherited from an earlier committed slice.`,
			);
		}
		byHandle.set(binding.handle, binding);
		byUuid.set(binding.uuid, binding);
	}
	return [...byHandle.values()];
}

/**
 * Rehydrate one change set from durable state: exact base (digest-proved)
 * plus steps, handles, and the accumulated read set.
 */
export async function rehydrateChangeSet(
	changeSet: DesignChangeSet,
): Promise<RehydratedChangeSet> {
	const db = await getAppDb();
	const [steps, localHandles] = await Promise.all([
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
	const inheritedHandles = await loadPriorCommittedPlanHandleBindings(
		changeSet,
		db,
	);
	const overlay = replayStepsOverBase(baseDoc, steps);
	const handles = verifiedPlanHandles(
		changeSet,
		baseDoc,
		overlay.doc,
		localHandles,
		inheritedHandles,
	);
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
