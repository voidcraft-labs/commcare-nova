/** Build the edit trail from the location and the selected-language names.
 * Entity subscriptions and language projection belong to the calling hook. */
import type { Uuid } from "@/lib/doc/types";
import {
	APP_SETUP_LABEL,
	APP_SETUP_SECTION_LABELS,
	DEFAULT_APP_SETUP_SECTION,
	type Location,
	PROJECT_DATA_LABEL,
} from "./types";
export interface BreadcrumbItem {
	key: string;
	label: string;
	location: Location;
}

export interface BreadcrumbContext {
	moduleUuid?: Uuid;
	formUuid?: Uuid;
	moduleName?: string;
	parentModuleUuid?: Uuid;
	parentModuleName?: string;
	formName?: string;
	moduleIsBareCaseList: boolean;
	parentModuleIsBareCaseList: boolean;
}
export function buildBreadcrumbs(
	loc: Location,
	{
		moduleUuid,
		formUuid,
		moduleName,
		parentModuleUuid,
		parentModuleName,
		formName,
		moduleIsBareCaseList,
		parentModuleIsBareCaseList,
	}: BreadcrumbContext,
): BreadcrumbItem[] {
	const items: BreadcrumbItem[] = [
		{ key: "home", label: "Home", location: { kind: "home" } },
	];
	if (parentModuleUuid) {
		items.push({
			key: `m:${parentModuleUuid}`,
			label: parentModuleName ?? "Menu",
			location: parentModuleIsBareCaseList
				? { kind: "cases", moduleUuid: parentModuleUuid }
				: { kind: "module", moduleUuid: parentModuleUuid },
		});
	}
	if (moduleUuid) {
		items.push({
			key: `m:${moduleUuid}`,
			label: moduleName ?? "Module",
			location: moduleIsBareCaseList
				? { kind: "cases", moduleUuid }
				: { kind: "module", moduleUuid },
		});
	}
	// The trailing crumb names the workspace tab, word-for-word
	// ("Search" / "Results" / "Details") — the module crumb
	// already carries the case-type context, so a "client search"-
	// style prefix would just restate it in a different casing.
	if (loc.kind === "cases") {
		/* The module crumb already points at Results for a bare case
		 * list, so this intermediate crumb would just repeat it. */
		if (!moduleIsBareCaseList) {
			items.push({
				key: `cases:${moduleUuid}`,
				label: "Results",
				location: { kind: "cases", moduleUuid: loc.moduleUuid },
			});
		}
		if (loc.caseId) {
			items.push({
				key: `case:${loc.caseId}`,
				label: loc.caseId,
				location: {
					kind: "cases",
					moduleUuid: loc.moduleUuid,
					caseId: loc.caseId,
				},
			});
		}
	}
	if (loc.kind === "search-config") {
		items.push({
			key: `search-config:${moduleUuid}`,
			label: "Search",
			location: { kind: "search-config", moduleUuid: loc.moduleUuid },
		});
	}
	if (loc.kind === "detail-config") {
		items.push({
			key: `detail-config:${moduleUuid}`,
			label: "Details",
			location: { kind: "detail-config", moduleUuid: loc.moduleUuid },
		});
	}
	if (loc.kind === "data-review") {
		items.push({
			key: `data-review:${moduleUuid}`,
			label: "Data to review",
			location: { kind: "data-review", moduleUuid: loc.moduleUuid },
		});
	}
	/* App setup roots directly off Home — it has no module ancestor, so its
	 * trail is Home → App setup → the section: the same
	 * workspace-then-screen shape a module's tabs produce. */
	if (loc.kind === "app-setup") {
		items.push({
			key: "app-setup",
			label: APP_SETUP_LABEL,
			location: { kind: "app-setup", section: DEFAULT_APP_SETUP_SECTION },
		});
		items.push({
			key: `app-setup:${loc.section}`,
			label: APP_SETUP_SECTION_LABELS[loc.section],
			location: { kind: "app-setup", section: loc.section },
		});
	}
	/* Project data roots off Home the same way, but its trail STOPS at the
	 * workspace even on a table URL. A table's name is Project state this
	 * hook has no reader for, so the crumb that could carry it would have to
	 * resolve it from a second source and could drift. The open table titles
	 * the workspace body instead, and this crumb stays the way back to the
	 * table list. */
	if (loc.kind === "project-data") {
		items.push({
			key: "project-data",
			label: PROJECT_DATA_LABEL,
			location: { kind: "project-data" },
		});
	}
	if (
		(loc.kind === "form" ||
			loc.kind === "form-condition" ||
			loc.kind === "form-operations" ||
			loc.kind === "form-links") &&
		formUuid &&
		moduleUuid
	) {
		items.push({
			key: `f:${formUuid}`,
			label: formName ?? "Form",
			location: { kind: "form", moduleUuid, formUuid },
		});
	}
	// The two display-condition screens share one crumb word so the
	// trail reads the same wherever the author opened it from.
	if (loc.kind === "module-condition" && moduleUuid) {
		items.push({
			key: `module-condition:${moduleUuid}`,
			label: "When it appears",
			location: { kind: "module-condition", moduleUuid },
		});
	}
	if (loc.kind === "form-condition" && moduleUuid && formUuid) {
		items.push({
			key: `form-condition:${formUuid}`,
			label: "When it appears",
			location: { kind: "form-condition", moduleUuid, formUuid },
		});
	}
	// The selected operation gets no crumb of its own: it is a selection
	// inside this screen, the way a selected field is inside a form.
	if (loc.kind === "form-operations" && moduleUuid && formUuid) {
		items.push({
			key: `form-operations:${formUuid}`,
			label: "Case changes",
			location: { kind: "form-operations", moduleUuid, formUuid },
		});
	}
	// The selected link gets no crumb either, for the same reason.
	if (loc.kind === "form-links" && moduleUuid && formUuid) {
		items.push({
			key: `form-links:${formUuid}`,
			label: "After submit",
			location: { kind: "form-links", moduleUuid, formUuid },
		});
	}
	return items;
}
