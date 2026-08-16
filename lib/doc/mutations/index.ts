/**
 * Mutation dispatcher. Every way the doc can change flows through here.
 *
 * Sub-files (`app.ts`, `modules.ts`, `forms.ts`, `fields.ts`) each
 * handle a related family of mutations. This top-level switch routes
 * on `kind` and delegates.
 *
 * `applyMutation` operates on an Immer draft — call sites wrap it in
 * `produce()` or let the Zustand store's Immer middleware handle the
 * drafting. Reducers return no side-channel metadata.
 *
 * `applyMutations` is the batched variant — it runs the same dispatch
 * loop and returns a parallel `MutationResult[]` (one entry per input
 * mutation). This is what backs the store's sole public write entry point,
 * `applyMany`, used by the agent stream and for restoring a doc from a
 * mutation log.
 */

import type { Draft } from "immer";
import {
	applyCasePropertyRenamePlan,
	CasePropertyRenamePlanError,
	planCasePropertyRenames,
} from "@/lib/doc/casePropertyRenames";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import {
	dematerializeLegacyLocalization,
	pruneOrphanTranslationEntries,
} from "@/lib/doc/localizationMaintenance";
import {
	applyReferenceIndexMaintenance,
	devAssertReferenceIndexParity,
	ensureReferenceIndex,
	planReferenceIndexMaintenance,
} from "@/lib/doc/referenceIndex";
import type { BlueprintDoc, Mutation, MutationResult } from "@/lib/doc/types";
import { assertNever } from "@/lib/utils/assertNever";
import { normalizeBlueprintOwnRecords } from "../ownRecords";
import { applyAppMutation } from "./app";
import { applyAutomationMutation } from "./automations";
import { applyFieldMutation } from "./fields";
import { applyFormMutation } from "./forms";
import { applyModuleMutation } from "./modules";
import { applyOrganizationMutation } from "./organization";
import { applyUserMutation } from "./users";

/**
 * Internal: dispatch a single mutation to the appropriate sub-reducer
 * WITHOUT rebuilding the `fieldParent` reverse index.
 *
 * Individual reducers never touch `fieldParent` themselves — the index is
 * rebuilt by the public entry points (`applyMutation` / `applyMutations`)
 * after the reducer(s) finish. That makes `applyMutations` O(N) in the
 * parent-index rebuild regardless of batch size, instead of O(N × M)
 * when every reducer triggered its own rebuild.
 */
function dispatchMutation(
	draft: Draft<BlueprintDoc>,
	mut: Mutation,
): MutationResult {
	switch (mut.kind) {
		case "setAppName":
		case "setConnectType":
		case "setAppLogo":
		case "relabelSourceLanguage":
		case "addLanguage":
		case "updateLanguage":
		case "removeLanguage":
		case "setDefaultLanguage":
		case "setTranslation":
		case "reviewTranslation":
		case "declareCaseType":
		case "retireCaseType":
		case "addCaseProperty":
		case "setCaseProperty":
		case "removeCaseProperty":
		case "setCaseTypeMeta":
			applyAppMutation(draft, mut);
			return;
		case "renameCaseProperties": {
			const plan = planCasePropertyRenames(
				draft as unknown as BlueprintDoc,
				mut,
			);
			if (!plan.ok) throw new CasePropertyRenamePlanError(plan.issue);
			applyCasePropertyRenamePlan(draft, plan.plan);
			return;
		}
		case "addModule":
		case "removeModule":
		case "moveModule":
		case "renameModule":
		case "updateModule":
		case "setModuleMedia":
		case "addColumn":
		case "updateColumn":
		case "removeColumn":
		case "moveColumn":
		case "addSearchInput":
		case "updateSearchInput":
		case "removeSearchInput":
		case "moveSearchInput":
		case "setCaseListMeta":
			applyModuleMutation(draft, mut);
			return;
		case "addForm":
		case "removeForm":
		case "moveForm":
		case "renameForm":
		case "updateForm":
		case "setFormMedia":
			applyFormMutation(draft, mut);
			return;
		case "addField":
		case "removeField":
		case "moveField":
		case "updateField":
		case "convertField":
		case "setFieldMedia":
		case "addOption":
		case "updateOption":
		case "removeOption":
		case "moveOption":
			applyFieldMutation(draft, mut);
			return;
		case "addUserProperty":
		case "updateUserProperty":
		case "removeUserProperty":
		case "addUserType":
		case "updateUserType":
		case "removeUserType":
		case "addPersona":
		case "updatePersona":
		case "removePersona":
			applyUserMutation(draft, mut);
			return;
		case "addOrganizationLevel":
		case "updateOrganizationLevel":
		case "removeOrganizationLevel":
		case "addLocationProperty":
		case "updateLocationProperty":
		case "removeLocationProperty":
			applyOrganizationMutation(draft, mut);
			return;
		case "addAutomation":
		case "updateAutomation":
		case "removeAutomation":
		case "moveAutomation":
		case "editAutomationItem":
		case "setAutomationSchedule":
		case "updateAutomationSchedule":
			applyAutomationMutation(draft, mut);
			return;
		default:
			assertNever(mut, "applyMutation");
	}
}

/**
 * Internal: one mutation's full application — the reference-index
 * maintenance bracketing the reducer. The plan captures pre-state facts
 * only the doc-before-the-reducer can answer (removed subtrees, the
 * carriers a rename re-keys); the apply step re-derives those carriers
 * from post-reducer state. The index is therefore CURRENT after every
 * mutation, not just at batch end — reducers later in the same batch
 * (a rename following an add that referenced it) read fresh lookups,
 * which is what lets them be lookup-driven at all.
 */
function applyOne(draft: Draft<BlueprintDoc>, mut: Mutation): MutationResult {
	const doc = draft as unknown as BlueprintDoc;
	const plan = planReferenceIndexMaintenance(doc, mut);
	const result = dispatchMutation(draft, mut);
	applyReferenceIndexMaintenance(doc, plan);
	return result;
}

/**
 * Apply a single mutation to an Immer draft and return any metadata the
 * reducer produces. Every mutation returns `undefined`.
 *
 * The reference index is seeded (built from the full doc) on first
 * contact and maintained incrementally by the mutation's application;
 * after the reducer runs, the `fieldParent` reverse index is rebuilt so
 * consumers observing the post-mutation draft see consistent indexes.
 */
export function applyMutation(
	draft: Draft<BlueprintDoc>,
	mut: Mutation,
): MutationResult {
	return applyMutations(draft, [mut])[0];
}

/**
 * Apply a batch of mutations to a single Immer draft.
 *
 * The `fieldParent` reverse index is rebuilt EXACTLY ONCE at the end of
 * the batch — not per mutation. This collapses an O(N × M) rebuild cost
 * (N = fields, M = mutations) into a single O(N) pass, critical when
 * agent streams land hundreds of mutations in one batch. Mid-batch reads
 * of `fieldParent` would see stale data, but no reducer reads it —
 * structural lookups use `fieldOrder` directly.
 *
 * The reference index is the opposite: maintained PER MUTATION (see
 * `applyOne`), because reducers inside the batch read it — its
 * increments are scoped to what each mutation touched, so the batch
 * cost stays proportional to the batch's own changes.
 */
export function applyMutations(
	draft: Draft<BlueprintDoc>,
	muts: readonly Mutation[],
): MutationResult[] {
	normalizeBlueprintOwnRecords(draft as unknown as BlueprintDoc);
	ensureReferenceIndex(draft as unknown as BlueprintDoc);
	const results: MutationResult[] = [];
	// A reducer may retain nested payload values in the candidate document.
	// Always reduce a detached copy so the candidate never aliases the admitted
	// command and never inherits its non-enumerable serialization protectors.
	// The authoritative batch itself remains frozen and byte-stable for its
	// accepted-row, event, stream, and tool-result consumers.
	const reductionMutations = structuredClone(muts) as Mutation[];
	for (const mut of reductionMutations) {
		results.push(applyOne(draft, mut));
	}
	// Translation overlays are dependent state of the final structural
	// endpoint, not an invariant any mid-batch reducer reads. Prune and collapse
	// once after the complete batch: initial localization may contain one entry
	// mutation per unit per target, so rebuilding the whole inventory after each
	// one would turn a linear commit into quadratic work.
	pruneOrphanTranslationEntries(draft);
	dematerializeLegacyLocalization(draft);
	normalizeBlueprintOwnRecords(draft as unknown as BlueprintDoc);
	rebuildFieldParent(draft as unknown as BlueprintDoc);
	devAssertReferenceIndexParity(draft as unknown as BlueprintDoc);
	return results;
}
