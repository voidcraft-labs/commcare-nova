/** Pure URL-to-running-screen projection shared by preview and wayfinding. */

import type { Uuid } from "@/lib/doc/types";
import type { Module } from "@/lib/domain";
import { moduleParent } from "@/lib/domain/moduleHierarchy";
import type { NavigationItemVisibility } from "@/lib/preview/engine/displayConditionEvaluation";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import type { Location } from "@/lib/routing/types";

/**
 * Translate a URL-derived location into the screen the running app can
 * actually show. The projection validates UUIDs, applies menu visibility, and
 * routes direct case-dependent leaves through their module's selector.
 */
export function locationToPreviewScreen(
	loc: Location,
	moduleOrder: readonly Uuid[],
	modules: Readonly<Record<string, Module>>,
	formOrder: Readonly<Record<Uuid, readonly Uuid[]>>,
	moduleVisibility: ReadonlyMap<Uuid, NavigationItemVisibility>,
	requiredCaseAdmissionModuleUuid?: Uuid,
): PreviewScreen {
	if (loc.kind === "home") return { type: "home" };
	if (loc.kind === "app-setup") {
		return { type: "appSetup", section: loc.section };
	}
	if (loc.kind === "project-data") {
		return { type: "projectData", tableId: loc.tableId };
	}

	if (!moduleOrder.includes(loc.moduleUuid)) return { type: "home" };

	/* A display-condition URL runs the surface its condition governs. A root
	 * module is offered on Home; a child is offered on its structural parent's
	 * menu, so that is where its inherited condition is previewed. */
	if (loc.kind === "module-condition") {
		const parentUuid = moduleParent({ modules, moduleOrder }, loc.moduleUuid);
		return parentUuid
			? { type: "module", moduleUuid: parentUuid }
			: { type: "home" };
	}

	/* Running routes cannot bypass a structural ancestor's menu condition.
	 * A hidden child falls back to its visible parent menu; when the parent is
	 * itself hidden or pending, Home is the nearest runnable screen. */
	const parentUuid = moduleParent({ modules, moduleOrder }, loc.moduleUuid);
	if (
		parentUuid !== undefined &&
		parentUuid !== null &&
		moduleVisibility.get(loc.moduleUuid) !== "shown"
	) {
		return moduleVisibility.get(parentUuid) === "shown"
			? { type: "module", moduleUuid: parentUuid }
			: { type: "home" };
	}

	/* A directly addressed running leaf must enter through its module before
	 * it can mount when case ancestry still requires a parent selection. */
	if (requiredCaseAdmissionModuleUuid === loc.moduleUuid) {
		return { type: "module", moduleUuid: loc.moduleUuid };
	}

	if (loc.kind === "module") {
		return { type: "module", moduleUuid: loc.moduleUuid };
	}
	if (loc.kind === "cases") {
		return { type: "caseList", moduleUuid: loc.moduleUuid };
	}
	if (loc.kind === "search-config") {
		return { type: "searchConfig", moduleUuid: loc.moduleUuid };
	}
	if (loc.kind === "detail-config") {
		return { type: "detailConfig", moduleUuid: loc.moduleUuid };
	}
	if (loc.kind === "data-review") {
		return { type: "dataReview", moduleUuid: loc.moduleUuid };
	}

	const formIds = formOrder[loc.moduleUuid] ?? [];
	if (!formIds.includes(loc.formUuid)) {
		return { type: "module", moduleUuid: loc.moduleUuid };
	}
	return {
		type: "form",
		moduleUuid: loc.moduleUuid,
		formUuid: loc.formUuid,
	};
}
