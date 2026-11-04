/**
 * Step 10, `search-workflow` (part 09 §7.8; part 05 §14, class M1).
 *
 * `main` decided what a searching menu showed first from its stored
 * `caseSearchConfig.searchFirst` flag and the shape of its search (its
 * `searchWireShape`): search first where the flag was on, skip to results
 * where nothing was there to fill in but a filter narrowed the list, list
 * first otherwise. Step 5 stores that choice as the authored `workflow` and
 * `formsReadSearch` slots. The structure phase lifted the flag
 * (`LiftedFacts.searchFirst`); this step reads the rest of the shape with the
 * same predicates `main` read (`visibleSearchInputs`,
 * `effectiveFilterForEmission`), which step 5 leaves as they were, and hands
 * the facts to `lib/doc/searchWorkflowPlan.ts::authoredSearchWorkflow`, the
 * one planner the fuzz mapping and the corpus sources share.
 *
 * A menu with no effective ordinary search is untouched, an owner-only
 * configuration included, and so is a menu whose stored configuration
 * already holds an authored workflow slot, which `main` could not store.
 * Every menu keeps its wire except a list-first one in an app that declares
 * Web Apps, which now opens on its Search screen or on its results there:
 * its `menu-opens-on-search` line says which.
 */

import { orderedModuleUuids } from "@/lib/doc/fieldWalk";
import {
	type AuthoredSearchWorkflow,
	authoredSearchWorkflow,
	type StoredSearchFacts,
} from "@/lib/doc/searchWorkflowPlan";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { effectiveFilterForEmission } from "@/lib/domain/expression/simplify";
import { substituteUnansweredSearchInputs } from "@/lib/domain/expression/walk";
import {
	effectiveCaseSearchConfig,
	isOwnerOnlyCaseSearchConfig,
	visibleSearchInputs,
} from "@/lib/domain/modules";
import { declaresWebApps } from "@/lib/domain/platforms";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";
import { menuOpensOnSearch } from "../notice";
import type { LiftedFacts, PlannedChange } from "../types";
import { applyStepMutations, type StepResult, stoppedStep } from "./apply";

/** Whether the step maps this menu: an effective ordinary search whose
 *  stored configuration holds no authored workflow slot yet. */
function mapsMenu(module: Module): boolean {
	const stored = module.caseSearchConfig;
	if (isOwnerOnlyCaseSearchConfig(stored)) return false;
	if (stored?.workflow !== undefined || stored?.formsReadSearch !== undefined)
		return false;
	return effectiveCaseSearchConfig(module) !== undefined;
}

/**
 * The stored search facts of every menu the step maps, in menu order: the
 * predicates `main`'s `searchWireShape` read, with the lifted `searchFirst`
 * flag.
 */
export function storedSearchFacts(
	doc: BlueprintDoc,
	facts: Pick<LiftedFacts, "searchFirst">,
): ReadonlyMap<Uuid, StoredSearchFacts> {
	const webApps = declaresWebApps(doc);
	const byModule = new Map<Uuid, StoredSearchFacts>();
	for (const moduleUuid of orderedModuleUuids(doc)) {
		const module = doc.modules[moduleUuid];
		if (module === undefined || !mapsMenu(module)) continue;
		const filter = module.caseListConfig?.filter;
		byModule.set(moduleUuid, {
			searchFirst: facts.searchFirst.has(moduleUuid),
			hasVisibleInput:
				visibleSearchInputs(module.caseListConfig?.searchInputs ?? []).length >
				0,
			hasEffectiveFilter:
				filter !== undefined &&
				effectiveFilterForEmission(substituteUnansweredSearchInputs(filter)) !==
					undefined,
			declaresWebApps: webApps,
		});
	}
	return byModule;
}

/** The one `updateModule` writing a menu's authored slots, or none where
 *  the answer stores nothing. */
function workflowMutation(
	moduleUuid: Uuid,
	answer: AuthoredSearchWorkflow,
): Mutation | undefined {
	if (answer.workflow === undefined && answer.formsReadSearch === undefined)
		return undefined;
	return {
		kind: "updateModule",
		uuid: moduleUuid,
		patch: {},
		caseSearchConfigPatch: {
			...(answer.workflow !== undefined && { workflow: answer.workflow }),
			...(answer.formsReadSearch !== undefined && {
				formsReadSearch: answer.formsReadSearch,
			}),
		},
	};
}

/** Step `search-workflow` over the document the earlier steps left. */
export function searchWorkflowStep(
	doc: BlueprintDoc,
	facts: Pick<LiftedFacts, "searchFirst">,
): StepResult {
	const mutations: Mutation[] = [];
	const changes: PlannedChange[] = [];
	const notice: MigrationNoticeEntry[] = [];
	for (const [moduleUuid, stored] of storedSearchFacts(doc, facts)) {
		const answer = authoredSearchWorkflow(stored);
		const mutation = workflowMutation(moduleUuid, answer);
		if (mutation !== undefined) {
			mutations.push(mutation);
			changes.push({
				step: "search-workflow",
				kind: "workflow-written",
				entityUuid: moduleUuid,
				detail: {
					listFirst: answer.workflow === "listFirst" ? 1 : 0,
					skipToResults: answer.workflow === "skipToResults" ? 1 : 0,
					formsReadSearch: answer.formsReadSearch === true ? 1 : 0,
				},
			});
		}
		if (answer.webAppsOpensOn !== undefined)
			notice.push(
				menuOpensOnSearch(
					{ uuid: moduleUuid, name: doc.modules[moduleUuid]?.name ?? "" },
					answer.webAppsOpensOn,
				),
			);
	}
	const applied = applyStepMutations(doc, mutations);
	if (!applied.ok) return stoppedStep(doc, [applied.blocker]);
	return { doc: applied.doc, changes, notice, blockers: [] };
}
