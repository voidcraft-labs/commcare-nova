/**
 * The search workflow a stored menu's search maps to: the one pure planner
 * from the facts of a menu whose search had no authored workflow (a stored
 * `searchFirst` flag and the shape of its search) to the authored
 * `workflow` / `formsReadSearch` slots and, where the menu moves off list
 * first in Web Apps, the line its notice states.
 *
 * Every class keeps the wire it had except a list-first menu in an app that
 * declares Web Apps, whose `auto_launch` turns on (and its `default_search`
 * too where it has nothing to fill in): CommCare HQ's editor offers no list
 * first for a menu that searches in Web Apps. The mapping, row by row:
 *
 *   | searchFirst | visible input | effective filter | Web Apps | stored                          | notice    |
 *   |-------------|---------------|------------------|----------|---------------------------------|-----------|
 *   | true        | yes           | any              | any      | formsReadSearch                 | none      |
 *   | true        | no            | any              | any      | skipToResults + formsReadSearch | none      |
 *   | false       | no            | yes              | any      | skipToResults                   | none      |
 *   | false       | yes           | any              | no       | listFirst                       | none      |
 *   | false       | no            | no               | no       | listFirst                       | none      |
 *   | false       | yes           | any              | yes      | nothing (search first)          | "search"  |
 *   | false       | no            | no               | yes      | skipToResults                   | "results" |
 *
 * A stored `searchFirst` was CommCare's inline search, whose `default_search`
 * was on exactly where no input was visible; the derived skip to results was
 * a filter with nothing to fill in. A menu with no visible input and no
 * filter in an app that declares Web Apps gets skip to results rather than
 * search first, since its Search screen would hold only its Search button.
 *
 * The planner reads plain facts, so it decides nothing about which menus it
 * applies to: the caller passes only a menu with an effective ordinary search
 * (an owner-only config maps to nothing). Its readers are the fuzz mapping,
 * the corpus sources and the cutover's `search-workflow` transform, each of
 * which derives the facts from `visibleSearchInputs`,
 * `effectiveFilterForEmission` and the app's declared platforms.
 */

/** What a stored menu's search shows the planner. */
export interface StoredSearchFacts {
	/** `caseSearchConfig.searchFirst === true` in the stored shape. */
	readonly searchFirst: boolean;
	/** The search has an input a worker sees (`visibleSearchInputs`). */
	readonly hasVisibleInput: boolean;
	/** The case list's filter narrows something (`effectiveFilterForEmission`). */
	readonly hasEffectiveFilter: boolean;
	/** `declaredPlatforms` includes Web Apps (absent `runsOnlyOn` is both). */
	readonly declaresWebApps: boolean;
}

/** The authored slots a stored menu's search maps to, and its notice line. */
export interface AuthoredSearchWorkflow {
	/** The stored `workflow`; absent is search first. */
	readonly workflow?: "listFirst" | "skipToResults";
	/** The stored `formsReadSearch`; absent is off. */
	readonly formsReadSearch?: true;
	/** The menu moved off list first in Web Apps: the notice's line. */
	readonly webAppsOpensOn?: "search" | "results";
}

/** Map one stored menu's search facts to its authored workflow (table above). */
export function authoredSearchWorkflow(
	facts: StoredSearchFacts,
): AuthoredSearchWorkflow {
	if (facts.searchFirst) {
		return facts.hasVisibleInput
			? { formsReadSearch: true }
			: { workflow: "skipToResults", formsReadSearch: true };
	}
	if (!facts.hasVisibleInput && facts.hasEffectiveFilter) {
		return { workflow: "skipToResults" };
	}
	if (!facts.declaresWebApps) {
		return { workflow: "listFirst" };
	}
	return facts.hasVisibleInput
		? { webAppsOpensOn: "search" }
		: { workflow: "skipToResults", webAppsOpensOn: "results" };
}
