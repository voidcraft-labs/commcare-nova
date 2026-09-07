/** Navigation decisions read the current URL and document at event time.
 * The browser adapter supplies History writes; no React state duplicates the URL. */
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { buildUrl, parsePathToLocation } from "./location";
import {
	type AppSetupSection,
	DEFAULT_APP_SETUP_SECTION,
	type Location,
} from "./types";

export interface NavigateActions {
	push: (next: Location, opts?: { replace?: boolean }) => void;
	replace: (next: Location) => void;
	goHome: () => void;
	openModule: (moduleUuid: Uuid) => void;
	openCaseList: (moduleUuid: Uuid) => void;
	openCaseDetail: (moduleUuid: Uuid, caseId: string) => void;
	/**
	 * Open the case-search authoring workspace for `moduleUuid`. Routes
	 * to `/build/{appId}/{moduleUuid}/search`. Sibling to
	 * `openCaseList` — same per-module shape, different config slot.
	 */
	openSearchConfig: (moduleUuid: Uuid) => void;
	/**
	 * Open the case-details authoring workspace for `moduleUuid`. Routes
	 * to `/build/{appId}/{moduleUuid}/details` — the third tab of
	 * the case-list workspace alongside `openCaseList` / `openSearchConfig`.
	 */
	openDetailConfig: (moduleUuid: Uuid) => void;
	/**
	 * Open the data review screen for `moduleUuid`. Routes
	 * to `/build/{appId}/{moduleUuid}/data-review` — reached from the
	 * Case data popover, the conversion toast, and shared deep links.
	 */
	openDataReview: (moduleUuid: Uuid) => void;
	openModuleCondition: (moduleUuid: Uuid) => void;
	openFormCondition: (moduleUuid: Uuid, formUuid: Uuid) => void;
	/**
	 * Open the App setup workspace. Routes to
	 * `/build/{appId}/setup/{section}`, defaulting to its first section.
	 * App administration, not app content — it names no module.
	 */
	openAppSetup: (section?: AppSetupSection, entryPointUuid?: Uuid) => void;
	/**
	 * Open the Project data workspace. Routes to
	 * `/build/{appId}/project-data`, or straight to one table when given its
	 * id. Project-shared data, not app content — it names no module.
	 */
	openProjectData: (tableId?: LookupTableId) => void;
	openFormOperations: (
		moduleUuid: Uuid,
		formUuid: Uuid,
		operationUuid?: Uuid,
	) => void;
	/**
	 * Open a form's after-submit links. Routes to
	 * `/build/{appId}/{formUuid}/links`, or straight to one link's detail
	 * when given its uuid.
	 */
	openFormLinks: (moduleUuid: Uuid, formUuid: Uuid, linkUuid?: Uuid) => void;
	openForm: (moduleUuid: Uuid, formUuid: Uuid, selectedUuid?: Uuid) => void;
	back: () => void;
	up: () => void;
}

/**
 * Selection callback returned by `useSelect`.
 * Passing `undefined` clears the current selection.
 */
export type SelectAction = (
	uuid: Uuid | undefined,
	from?: Extract<Location, { kind: "form" }>,
) => void;

export interface NavigationPort {
	getPathname(): string;
	getSegments(): string[];
	getDoc(): BlueprintDoc;
	write(url: string, replace?: boolean): void;
	back(): void;
}

export function createNavigateActions(port: NavigationPort): NavigateActions {
	/** Read the `/build/{appId}` prefix at call time.
	 * `port.getPathname()` is external mutable state we don't own
	 * — the new-build flow rewrites the prefix via `history.replaceState`
	 * once the server mints the appId. Caching the prefix in a ref would
	 * leave us building URLs against a stale `/build/new/...` value
	 * after that rewrite lands. */
	const getBasePath = (): string => {
		const parts = port.getPathname().split("/").filter(Boolean);
		return `/${parts.slice(0, 2).join("/")}`;
	};

	/** Push a new location (history entry). Use for screen changes. */
	const push = (next: Location, opts?: { replace?: boolean }): void => {
		const url = buildUrl(getBasePath(), next);
		port.write(url, opts?.replace);
	};

	/** Replace the current location (no history entry). */
	const replace = (next: Location): void => {
		const url = buildUrl(getBasePath(), next);
		port.write(url, true);
	};

	return {
		push,
		replace,
		goHome: () => push({ kind: "home" }),
		openModule: (moduleUuid: Uuid) => push({ kind: "module", moduleUuid }),
		openCaseList: (moduleUuid: Uuid) => push({ kind: "cases", moduleUuid }),
		openCaseDetail: (moduleUuid: Uuid, caseId: string) =>
			push({ kind: "cases", moduleUuid, caseId }),
		openSearchConfig: (moduleUuid: Uuid) =>
			push({ kind: "search-config", moduleUuid }),
		openDetailConfig: (moduleUuid: Uuid) =>
			push({ kind: "detail-config", moduleUuid }),
		openDataReview: (moduleUuid: Uuid) =>
			push({ kind: "data-review", moduleUuid }),
		openModuleCondition: (moduleUuid: Uuid) =>
			push({ kind: "module-condition", moduleUuid }),
		openFormCondition: (moduleUuid: Uuid, formUuid: Uuid) =>
			push({ kind: "form-condition", moduleUuid, formUuid }),
		openAppSetup: (
			section: AppSetupSection = DEFAULT_APP_SETUP_SECTION,
			entryPointUuid?: Uuid,
		) =>
			push({
				kind: "app-setup",
				section,
				...(section === "deep-links" && entryPointUuid
					? { entryPointUuid }
					: {}),
			}),
		openProjectData: (tableId?: LookupTableId) =>
			push({ kind: "project-data", tableId }),
		openFormOperations: (
			moduleUuid: Uuid,
			formUuid: Uuid,
			operationUuid?: Uuid,
		) =>
			push({
				kind: "form-operations",
				moduleUuid,
				formUuid,
				...(operationUuid !== undefined && { operationUuid }),
			}),
		openFormLinks: (moduleUuid: Uuid, formUuid: Uuid, linkUuid?: Uuid) =>
			push({
				kind: "form-links",
				moduleUuid,
				formUuid,
				...(linkUuid !== undefined && { linkUuid }),
			}),
		openForm: (moduleUuid: Uuid, formUuid: Uuid, selectedUuid?: Uuid) =>
			push({ kind: "form", moduleUuid, formUuid, selectedUuid }),
		back: () => port.back(),
		up: () => {
			const current = parsePathToLocation(port.getSegments(), port.getDoc());
			const parent = parentLocation(current);
			if (parent) push(parent);
		},
	};
}

export function parentLocation(loc: Location): Location | undefined {
	switch (loc.kind) {
		case "home":
			return undefined;
		case "app-setup":
			return { kind: "home" };
		/* An open table's parent is the table list; the list's parent is Home. */
		case "project-data":
			return loc.tableId !== undefined
				? { kind: "project-data" }
				: { kind: "home" };
		case "module":
			return { kind: "home" };
		case "cases":
			return loc.caseId
				? { kind: "cases", moduleUuid: loc.moduleUuid }
				: { kind: "module", moduleUuid: loc.moduleUuid };
		case "search-config":
		case "detail-config":
		case "data-review":
		case "module-condition":
			return { kind: "module", moduleUuid: loc.moduleUuid };
		case "form-condition":
			return {
				kind: "form",
				moduleUuid: loc.moduleUuid,
				formUuid: loc.formUuid,
			};
		case "form-operations":
			// A selected operation's parent is the list; the list's is the form.
			return loc.operationUuid !== undefined
				? {
						kind: "form-operations",
						moduleUuid: loc.moduleUuid,
						formUuid: loc.formUuid,
					}
				: {
						kind: "form",
						moduleUuid: loc.moduleUuid,
						formUuid: loc.formUuid,
					};
		case "form-links":
			// A selected link's parent is the list; the list's is the form.
			return loc.linkUuid !== undefined
				? {
						kind: "form-links",
						moduleUuid: loc.moduleUuid,
						formUuid: loc.formUuid,
					}
				: {
						kind: "form",
						moduleUuid: loc.moduleUuid,
						formUuid: loc.formUuid,
					};
		case "form":
			return loc.selectedUuid
				? {
						kind: "form",
						moduleUuid: loc.moduleUuid,
						formUuid: loc.formUuid,
					}
				: { kind: "module", moduleUuid: loc.moduleUuid };
	}
}

export function createSelectAction(
	port: NavigationPort,
	consultGuard: () => boolean,
	clearFocusHint: () => void,
): SelectAction {
	const getBasePath = (): string => {
		const parts = port.getPathname().split("/").filter(Boolean);
		return `/${parts.slice(0, 2).join("/")}`;
	};

	return (
		uuid: Uuid | undefined,
		from?: Extract<Location, { kind: "form" }>,
	): void => {
		/* Honor any guard registered by an inline editor with unsaved
		 * invalid content. The two-strike pattern (warn, then allow on
		 * repeat) is owned by the guard predicate — this call site is
		 * just a gate. */
		if (!consultGuard()) return;
		/* Drop any pending undo/redo focus hint. It was scoped to the
		 * field selected when undo ran; a selection change (including
		 * deselect) makes it stale. Without this, an uncleared "id" hint
		 * would auto-focus + select the NEXT field's id-rename box on
		 * mount, so a keystroke would rename an unrelated field. */
		clearFocusHint();
		/* A successful field removal invalidates its selected URL segment
		 * before the adjacent-selection write runs. The removing action passes
		 * its freshly-read form location so this final route write does not
		 * have to rediscover the deleted field's parent. Ordinary callers read
		 * the live path here. */
		const current =
			from ?? parsePathToLocation(port.getSegments(), port.getDoc());
		if (current.kind !== "form") return;
		const next: Location = {
			kind: "form",
			moduleUuid: current.moduleUuid,
			formUuid: current.formUuid,
			selectedUuid: uuid,
		};
		const url = buildUrl(getBasePath(), next);
		port.write(url, true);
	};
}
