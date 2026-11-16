/** Pure URL-to-running-screen projection shared by preview and wayfinding. */

import type { Uuid } from "@/lib/doc/types";
import type { MenuScreenSource, Module } from "@/lib/domain";
import { moduleParent } from "@/lib/domain/moduleHierarchy";
import type { NavigationItemVisibility } from "@/lib/preview/engine/displayConditionEvaluation";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { previewRunningModuleScreen } from "@/lib/preview/menuProjection";
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
	continuesExistingTask = false,
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
		!continuesExistingTask &&
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

/**
 * The screen the running app shows for a location: `locationToPreviewScreen`,
 * then, in Preview, a module screen of a menu with no screen of its own (a
 * stored location, a typed URL, Back, a breadcrumb) resolved to the screen
 * that lists its forms (`previewRunningModuleScreen`). A module entered for
 * its parent case selection keeps its own screen, which starts that
 * selection. A parent case selector is entered at its case list
 * (`parentCaseSelectorLocation`), never at its menu, so a selector with no
 * screen of its own still chooses its case. Edit mode keeps every menu the
 * container of its own forms.
 */
export function previewRunningScreenForLocation(args: {
	readonly loc: Location;
	readonly mode: "edit" | "preview";
	readonly doc: MenuScreenSource;
	readonly moduleOrder: readonly Uuid[];
	readonly modules: Readonly<Record<string, Module>>;
	readonly formOrder: Readonly<Record<Uuid, readonly Uuid[]>>;
	readonly moduleVisibility: ReadonlyMap<Uuid, NavigationItemVisibility>;
	readonly requiredCaseAdmissionModuleUuid?: Uuid;
	readonly continuesExistingTask?: boolean;
}): PreviewScreen {
	const screen = locationToPreviewScreen(
		args.loc,
		args.moduleOrder,
		args.modules,
		args.formOrder,
		args.moduleVisibility,
		args.requiredCaseAdmissionModuleUuid,
		args.continuesExistingTask,
	);
	return args.mode === "preview" &&
		screen.type === "module" &&
		screen.moduleUuid !== args.requiredCaseAdmissionModuleUuid
		? previewRunningModuleScreen(args.doc, screen.moduleUuid)
		: screen;
}

/** Where a parent case selection enters its selector: the selector's case
 *  list. Its case list route mounts the selector's own screen first while
 *  the selector itself still needs a parent case, so a chain of selectors
 *  walks through each in turn. */
export function parentCaseSelectorLocation(
	selectorModuleUuid: Uuid,
): Extract<Location, { kind: "cases" }> {
	return { kind: "cases", moduleUuid: selectorModuleUuid };
}
