/**
 * URL-driven location hooks — the builder's public client surface for
 * navigation and selection state.
 *
 * The URL on /build/[id] is the sole source of truth for "where you are"
 * (home / module / case list / form) and "what's focused" (selected
 * field). Nothing in any Zustand store represents this state.
 *
 * Navigation uses the browser History API directly (pushState/replaceState)
 * instead of Next.js's router to avoid server-side RSC re-renders on
 * every navigation. The RSC page only renders on initial load and when
 * the [id] segment changes.
 *
 * Navigation operations fall into two buckets:
 *
 * 1. **Screen changes** (home ↔ module ↔ form) use `pushState` so each
 *    move becomes a browser history entry. The back/forward buttons
 *    traverse this history for free.
 * 2. **Selection changes** (the field UUID segment flipping on clicks)
 *    use `replaceState` so rapid clicking through fields doesn't
 *    flood history. Back from a form goes to the module, not through
 *    every field the user happened to click in that form.
 */

"use client";

/* Intra-builder navigation uses the browser History API directly via
 * pushState/replaceState + notifyPathChange() — see `useNavigate` below.
 * Next.js's `useRouter` is imported only for `useExternalNavigate`, the
 * ONE sanctioned wrapper for cross-route navigation (leaving the
 * builder, landing-page flows, etc.) — no other app code should import
 * `next/navigation` directly. */
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useConsultEditGuard } from "@/components/builder/contexts/EditGuardContext";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useField, useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { useIsBareCaseListModule } from "@/lib/doc/hooks/useModuleIds";
import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import type { Field, Form, Module } from "@/lib/domain";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { parsePathToLocation } from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";
import {
	getBuilderPathSegmentsSnapshot,
	pushBuilderHistory,
	subscribeBuilderPathChange,
	useIsBuilderFieldPathSelected,
} from "@/lib/routing/useClientPath";
import { useClearFocusHint } from "@/lib/session/hooks";

import { type BreadcrumbItem, buildBreadcrumbs } from "./breadcrumbs";
import {
	createBuilderLocationSource,
	hasSelectedField,
	locationKind,
	selectedFieldUuid,
	selectedFormLinkUuid,
	selectedFormOperationUuid,
	selectedFormUuid,
	selectedModuleUuid,
	selectedProjectDataTableId,
} from "./builderLocation";
import {
	createNavigateActions,
	createSelectAction,
	type NavigateActions,
	type NavigationPort,
	type SelectAction,
} from "./navigation";

export type { BreadcrumbItem } from "./breadcrumbs";
export type { NavigateActions, SelectAction } from "./navigation";
export { parentLocation } from "./navigation";

/**
 * Reactive parse of the current URL path into a `Location`. Path and document
 * changes both re-check entity disambiguation, but the cached semantic snapshot
 * re-renders consumers only when the resolved location actually changes.
 *
 * Malformed/incomplete URLs degrade to `{ kind: "home" }` — see
 * `parsePathToLocation` for the rules.
 */
const HOME_LOCATION: Location = { kind: "home" };

const builderLocationSource = createBuilderLocationSource({
	getSegments: getBuilderPathSegmentsSnapshot,
	subscribe: subscribeBuilderPathChange,
});
const builderLocationSnapshot = builderLocationSource.getSnapshot;
const subscribeBuilderLocation = builderLocationSource.subscribe;

export function useLocation(): Location {
	const docApi = useBlueprintDocApi();
	const subscribe = useCallback(
		(onStoreChange: () => void) =>
			subscribeBuilderLocation(docApi, onStoreChange),
		[docApi],
	);
	const getSnapshot = useCallback(
		() => builderLocationSnapshot(docApi),
		[docApi],
	);
	return useSyncExternalStore(subscribe, getSnapshot, () => HOME_LOCATION);
}

/** Read the current URL location against a live document snapshot without
 * subscribing the caller to route changes. Event handlers use this when the
 * route matters only at fire time; making their owning layout reactive would
 * otherwise cascade every field-selection change through the whole Builder. */
export function readBuilderLocation(doc: BlueprintDoc): Location {
	return parsePathToLocation(getBuilderPathSegmentsSnapshot(), doc);
}

/**
 * Derive the selected field entity from the current URL and doc.
 * Returns `null` when there's no selection in the URL, when the current
 * screen isn't a form, or when the referenced uuid no longer exists
 * (the deletion-recovery effect in `LocationRecoveryEffect` will fix
 * the URL on the next tick).
 */
export function useSelectedField(): Field | null {
	const loc = useLocation();
	const selectedUuid = loc.kind === "form" ? loc.selectedUuid : undefined;
	const field = useField(selectedUuid);
	return field ?? null;
}

/**
 * Derive the `{ module, form }` context the selected-field panel
 * needs — one shallow read per entity, `null` if we're not on a form
 * screen or an entity is missing.
 */
export function useSelectedFormContext(): {
	module: Module;
	form: Form;
} | null {
	const loc = useLocation();
	const moduleUuid = loc.kind === "form" ? loc.moduleUuid : undefined;
	const formUuid = loc.kind === "form" ? loc.formUuid : undefined;
	const mod = useModule(moduleUuid);
	const form = useForm(formUuid);
	return useMemo(
		() => (mod && form ? { module: mod, form } : null),
		[mod, form],
	);
}

type LocationProjection = boolean | string | null | undefined;

/** Subscribe to the current route and document topology, but expose only a
 * primitive projection to React. Route listeners still receive every path
 * notification; `useSyncExternalStore` prevents a component render when its
 * own selected module/form/kind did not change. */
function useLocationProjection<T extends LocationProjection>(
	project: (location: Location) => T,
): T {
	const docApi = useBlueprintDocApi();
	const subscribe = useCallback(
		(onStoreChange: () => void) =>
			subscribeBuilderLocation(docApi, onStoreChange),
		[docApi],
	);
	const getProjectedSnapshot = useCallback(
		() => project(builderLocationSnapshot(docApi)),
		[docApi, project],
	);
	const getServerSnapshot = useCallback(
		() => project({ kind: "home" }),
		[project],
	);
	return useSyncExternalStore(
		subscribe,
		getProjectedSnapshot,
		getServerSnapshot,
	);
}

/** The route kind without subscribing consumers to selection-only path
 * changes within that route. */
export function useLocationKind(): Location["kind"] {
	return useLocationProjection(locationKind);
}

/** The selected module identity without subscribing to field-selection-only
 * URL changes. */
export function useSelectedModuleUuid(): Uuid | undefined {
	return useLocationProjection(selectedModuleUuid);
}

/** The selected form identity without subscribing to field-selection-only
 * URL changes. */
export function useSelectedFormUuid(): Uuid | undefined {
	return useLocationProjection(selectedFormUuid);
}

/** The selected field identity without subscribing to field entity changes. */
export function useSelectedFieldUuid(): Uuid | undefined {
	return useLocationProjection(selectedFieldUuid);
}

/** The open Project data table identity, stable throughout every non-Project
 * data route and across unrelated field selections. */
export function useSelectedProjectDataTableId(): LookupTableId | undefined {
	return useLocationProjection(selectedProjectDataTableId);
}

/** Whether a valid field selection is present. Unlike `useSelectedField`, this
 * remains stable while the author moves between fields, for layout consumers
 * that only need to reserve inspector space. */
export function useHasSelectedField(): boolean {
	return useLocationProjection(hasSelectedField);
}

export function useSelectedFormOperationUuid(): Uuid | undefined {
	return useLocationProjection(selectedFormOperationUuid);
}

export function useSelectedFormLinkUuid(): Uuid | undefined {
	return useLocationProjection(selectedFormLinkUuid);
}

/**
 * `true` when a module (or any descendant screen) references this module uuid.
 * Used by `ModuleCard` in the tree sidebar for highlight state.
 *
 * The primitive external-store projection means a field-only URL change
 * notifies this hook but does not re-render its module card.
 */
export function useIsModuleSelected(uuid: Uuid): boolean {
	const project = useCallback(
		(location: Location) => selectedModuleUuid(location) === uuid,
		[uuid],
	);
	return useLocationProjection(project);
}

/**
 * `true` when any of the case-list workspace's URLs (list / search /
 * detail tab) is open for this module. Used by the tree sidebar's
 * Search, Results & Details node for highlight state.
 */
export function useIsCaseListSelected(uuid: Uuid): boolean {
	const project = useCallback(
		(location: Location) =>
			(location.kind === "cases" ||
				location.kind === "search-config" ||
				location.kind === "detail-config") &&
			location.moduleUuid === uuid,
		[uuid],
	);
	return useLocationProjection(project);
}

/**
 * `true` when the current URL points to this exact form.
 * Used by `FormCard` in the tree sidebar for highlight state.
 */
export function useIsFormSelected(uuid: Uuid): boolean {
	const project = useCallback(
		(location: Location) => selectedFormUuid(location) === uuid,
		[uuid],
	);
	return useLocationProjection(project);
}

/**
 * `true` when a specific field uuid is the current selection.
 * Each `EditableFieldWrapper` calls this with its own identity —
 * only the previously-selected and newly-selected wrappers re-render
 * on a selection change.
 */
export function useIsFieldSelected(uuid: Uuid): boolean {
	return useIsBuilderFieldPathSelected(uuid);
}

/** A single entry in the breadcrumb trail rendered by BuilderSubheader. */
/**
 * Derived breadcrumb trail from the current location + doc names.
 * Everything is read through shallow-stable selectors, so unrelated
 * doc mutations don't cause re-renders here.
 *
 * The trail roots at a "Home" crumb; the app's name titles the
 * structure sidebar instead.
 */
export function useBreadcrumbs(): BreadcrumbItem[] {
	const loc = useLocation();

	const moduleUuid =
		loc.kind === "module" ||
		loc.kind === "cases" ||
		loc.kind === "search-config" ||
		loc.kind === "detail-config" ||
		loc.kind === "data-review" ||
		loc.kind === "module-condition" ||
		loc.kind === "form-condition" ||
		loc.kind === "form-operations" ||
		loc.kind === "form-links" ||
		loc.kind === "form"
			? loc.moduleUuid
			: undefined;
	const formUuid =
		loc.kind === "form" ||
		loc.kind === "form-condition" ||
		loc.kind === "form-operations" ||
		loc.kind === "form-links"
			? loc.formUuid
			: undefined;

	const module = useModule(moduleUuid);
	const moduleName = module?.name;
	const parentModuleUuid = module?.parentModuleUuid;
	const parentModuleName = useModule(parentModuleUuid)?.name;
	const formName = useForm(formUuid)?.name;
	/* A bare case list (a `caseListOnly` module) has no module screen — it IS
	 * its Results screen. Its module crumb points straight at Results, and the
	 * intermediate "Results" crumb is dropped (below) so the trail doesn't
	 * restate the same destination twice. */
	const moduleIsBareCaseList = useIsBareCaseListModule(moduleUuid);
	const parentModuleIsBareCaseList = useIsBareCaseListModule(parentModuleUuid);

	return useMemo(
		() =>
			buildBreadcrumbs(loc, {
				moduleUuid,
				formUuid,
				moduleName,
				parentModuleUuid,
				parentModuleName,
				formName,
				moduleIsBareCaseList,
				parentModuleIsBareCaseList,
			}),
		[
			loc,
			moduleUuid,
			formUuid,
			moduleName,
			parentModuleUuid,
			parentModuleName,
			formName,
			moduleIsBareCaseList,
			parentModuleIsBareCaseList,
		],
	);
}

/** The action objects stay stable; their port reads URL and doc at event time. */
function navigationPort(docApi: BlueprintDocStore): NavigationPort {
	return {
		getPathname: () => window.location.pathname,
		getSegments: getBuilderPathSegmentsSnapshot,
		getDoc: docApi.getState,
		write: pushBuilderHistory,
		back: () => window.history.back(),
	};
}

export function useNavigate(): NavigateActions {
	const docApi = useBlueprintDocApi();
	return useMemo(() => createNavigateActions(navigationPort(docApi)), [docApi]);
}

export function useSelect(): SelectAction {
	const docApi = useBlueprintDocApi();
	const consultGuard = useConsultEditGuard();
	const clearFocusHint = useClearFocusHint();
	return useMemo(
		() =>
			createSelectAction(navigationPort(docApi), consultGuard, clearFocusHint),
		[docApi, consultGuard, clearFocusHint],
	);
}

/**
 * Action bag for cross-route navigation — the three methods an app
 * navigating between Next.js routes actually needs. Kept deliberately
 * minimal: no `back`/`forward`/`prefetch` — if a future call site
 * genuinely needs one, add it here rather than re-exposing the full
 * router surface. Every method is a standalone arrow, safe to
 * destructure without losing `this` context.
 */
export interface ExternalNavigateActions {
	push: (path: string) => void;
	replace: (path: string) => void;
	refresh: () => void;
}

/**
 * Sanctioned wrapper over Next.js's `useRouter` for cross-route
 * navigation (leaving the builder, landing/auth flows, admin pages).
 *
 * Components navigating WITHIN the builder use `useNavigate` — that
 * hook talks to the browser History API directly so intra-builder
 * clicks don't trigger server-side RSC re-renders. Components
 * navigating ACROSS routes use `useExternalNavigate`, which routes
 * through `useRouter` so Next.js can prefetch + stream the next route
 * normally.
 *
 * Keeping both behind named hooks means app code never imports
 * `next/navigation` directly — reviewers can search for
 * `useExternalNavigate` to audit every cross-route jump, and switching
 * navigation strategies in the future is a one-file change.
 *
 * The returned object is memoized on `router` so consumers can safely
 * place `navigate` in `useCallback`/`useMemo` dependency arrays without
 * re-firing on every parent render. App Router's `router` reference is
 * stable within a session, so in practice the memo returns the same
 * object bag for the lifetime of the component.
 */
export function useExternalNavigate(): ExternalNavigateActions {
	const router = useRouter();
	return useMemo(
		() => ({
			push: (path: string) => router.push(path),
			replace: (path: string) => router.replace(path),
			refresh: () => router.refresh(),
		}),
		[router],
	);
}
