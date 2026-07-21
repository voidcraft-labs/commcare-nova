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
import { useMemo, useRef } from "react";
import { useConsultEditGuard } from "@/components/builder/contexts/EditGuardContext";
import {
	useBlueprintDoc,
	useBlueprintDocShallow,
} from "@/lib/doc/hooks/useBlueprintDoc";
import { useIsBareCaseListModule } from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/doc/types";
import type { Field, Form, Module } from "@/lib/domain";
import { buildUrl, parsePathToLocation } from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";
import {
	notifyPathChange,
	useBuilderPathSegments,
} from "@/lib/routing/useClientPath";
import { useClearFocusHint } from "@/lib/session/hooks";

/**
 * Reactive parse of the current URL path into a `Location`. Re-renders
 * on every path change (via `useBuilderPathSegments`'s
 * `useSyncExternalStore` subscription) and whenever the doc's entity
 * maps change (so entity disambiguation stays current).
 *
 * Malformed/incomplete URLs degrade to `{ kind: "home" }` — see
 * `parsePathToLocation` for the rules.
 */
export function useLocation(): Location {
	const segments = useBuilderPathSegments();
	const doc = useBlueprintDocShallow((s) => ({
		modules: s.modules,
		forms: s.forms,
		fields: s.fields,
		formOrder: s.formOrder,
		fieldOrder: s.fieldOrder,
	}));
	return useMemo(() => parsePathToLocation(segments, doc), [segments, doc]);
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
	const field = useBlueprintDoc((s) =>
		selectedUuid ? s.fields[selectedUuid] : undefined,
	);
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
	const mod = useBlueprintDoc((s) =>
		moduleUuid ? s.modules[moduleUuid] : undefined,
	);
	const form = useBlueprintDoc((s) =>
		formUuid ? s.forms[formUuid] : undefined,
	);
	if (!mod || !form) return null;
	return { module: mod, form };
}

/**
 * Stable action bag returned by `useNavigate`.
 *
 * Every method is a standalone closure — safe to destructure
 * (`const { openForm } = useNavigate()`) without losing `this` context.
 */
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
	openForm: (moduleUuid: Uuid, formUuid: Uuid, selectedUuid?: Uuid) => void;
	back: () => void;
	up: () => void;
}

/**
 * Selection callback returned by `useSelect`.
 * Passing `undefined` clears the current selection.
 */
export type SelectAction = (uuid: Uuid | undefined) => void;

/**
 * `true` when a module (or any descendant screen) references this module uuid.
 * Used by `ModuleCard` in the tree sidebar for highlight state.
 *
 * Tradeoff: this hook re-renders on any URL change (not just module
 * changes), because `useLocation` subscribes to the full path. The
 * boolean return prevents child reconciliation for non-matching cards.
 */
export function useIsModuleSelected(uuid: Uuid): boolean {
	const loc = useLocation();
	return (
		(loc.kind === "module" ||
			loc.kind === "cases" ||
			loc.kind === "search-config" ||
			loc.kind === "detail-config" ||
			loc.kind === "data-review" ||
			loc.kind === "form") &&
		loc.moduleUuid === uuid
	);
}

/**
 * `true` when any of the case-list workspace's URLs (list / search /
 * detail tab) is open for this module. Used by the tree sidebar's
 * Search, Results & Details node for highlight state.
 */
export function useIsCaseListSelected(uuid: Uuid): boolean {
	const loc = useLocation();
	return (
		(loc.kind === "cases" ||
			loc.kind === "search-config" ||
			loc.kind === "detail-config") &&
		loc.moduleUuid === uuid
	);
}

/**
 * `true` when the current URL points to this exact form.
 * Used by `FormCard` in the tree sidebar for highlight state.
 */
export function useIsFormSelected(uuid: Uuid): boolean {
	const loc = useLocation();
	return loc.kind === "form" && loc.formUuid === uuid;
}

/**
 * `true` when a specific field uuid is the current selection.
 * Each `EditableFieldWrapper` calls this with its own identity —
 * only the previously-selected and newly-selected wrappers re-render
 * on a selection change.
 */
export function useIsFieldSelected(uuid: Uuid): boolean {
	const loc = useLocation();
	return loc.kind === "form" && loc.selectedUuid === uuid;
}

/** A single entry in the breadcrumb trail rendered by BuilderSubheader. */
export interface BreadcrumbItem {
	key: string;
	label: string;
	location: Location;
}

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
		loc.kind === "form"
			? loc.moduleUuid
			: undefined;
	const formUuid = loc.kind === "form" ? loc.formUuid : undefined;

	const moduleName = useBlueprintDoc((s) =>
		moduleUuid ? s.modules[moduleUuid]?.name : undefined,
	);
	const formName = useBlueprintDoc((s) =>
		formUuid ? s.forms[formUuid]?.name : undefined,
	);
	/* A bare case list (a `caseListOnly` module) has no module screen — it IS
	 * its Results screen. Its module crumb points straight at Results, and the
	 * intermediate "Results" crumb is dropped (below) so the trail doesn't
	 * restate the same destination twice. */
	const moduleIsBareCaseList = useIsBareCaseListModule(moduleUuid);

	return useMemo<BreadcrumbItem[]>(() => {
		const items: BreadcrumbItem[] = [
			{ key: "home", label: "Home", location: { kind: "home" } },
		];
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
		if (loc.kind === "form" && formUuid && moduleUuid) {
			items.push({
				key: `f:${formUuid}`,
				label: formName ?? "Form",
				location: { kind: "form", moduleUuid, formUuid },
			});
		}
		return items;
	}, [loc, moduleUuid, formUuid, moduleName, formName, moduleIsBareCaseList]);
}

/**
 * Location + navigation actions. Selection edits use `replaceState`
 * (no history entry); screen changes use `pushState`.
 *
 * The returned object is stable across URL changes — a ref captures the
 * current location for `up()` without adding it to the `useMemo` deps.
 * Every method is a standalone arrow, safe to destructure without losing
 * `this` context.
 */
export function useNavigate(): NavigateActions {
	const loc = useLocation();

	/* Capture current location in a ref so `up()` can read it without
	 * including `loc` in useMemo deps. */
	const locRef = useRef(loc);
	locRef.current = loc;

	return useMemo(() => {
		/** Read the `/build/{appId}` prefix at call time.
		 * `window.location.pathname` is external mutable state we don't own
		 * — the new-build flow rewrites the prefix via `history.replaceState`
		 * once the server mints the appId. Caching the prefix in a ref would
		 * leave us building URLs against a stale `/build/new/...` value
		 * after that rewrite lands. */
		const getBasePath = (): string => {
			const parts = window.location.pathname.split("/").filter(Boolean);
			return `/${parts.slice(0, 2).join("/")}`;
		};

		/** Push a new location (history entry). Use for screen changes. */
		const push = (next: Location, opts?: { replace?: boolean }): void => {
			const url = buildUrl(getBasePath(), next);
			if (opts?.replace) window.history.replaceState(null, "", url);
			else window.history.pushState(null, "", url);
			notifyPathChange();
		};

		/** Replace the current location (no history entry). */
		const replace = (next: Location): void => {
			const url = buildUrl(getBasePath(), next);
			window.history.replaceState(null, "", url);
			notifyPathChange();
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
			openForm: (moduleUuid: Uuid, formUuid: Uuid, selectedUuid?: Uuid) =>
				push({ kind: "form", moduleUuid, formUuid, selectedUuid }),
			back: () => window.history.back(),
			up: () => {
				const parent = parentLocation(locRef.current);
				if (parent) push(parent);
			},
		};
		// Intentional stable object; all state read at call time via locRef/window.location.
	}, []);
}

/**
 * Pure parent-derivation for the `up` navigation.
 *
 * Exported for unit testing — the function has no hook semantics
 * (no React imports, no store access) and can be called standalone.
 * Consumers should prefer `useNavigate().up()` for actual navigation;
 * this export exists to cover every branch of the parent walk without
 * a full `renderHook` harness.
 */
export function parentLocation(loc: Location): Location | undefined {
	switch (loc.kind) {
		case "home":
			return undefined;
		case "module":
			return { kind: "home" };
		case "cases":
			return loc.caseId
				? { kind: "cases", moduleUuid: loc.moduleUuid }
				: { kind: "module", moduleUuid: loc.moduleUuid };
		case "search-config":
		case "detail-config":
		case "data-review":
			return { kind: "module", moduleUuid: loc.moduleUuid };
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

/**
 * Selection-only operation. Updates the field UUID segment on the
 * current form URL without otherwise changing the screen. No-ops when
 * not on a form location (selection only exists inside a form).
 *
 * `uuid === undefined` clears the current selection.
 *
 * **Edit guard integration.** Inline editors with unsaved invalid
 * content (e.g. the XPath editor in `XPathField`) install a guard via
 * `useRegisterEditGuard()` from `EditGuardContext`. Before changing
 * the URL, `useSelect` consults the guard via `useConsultEditGuard()`
 * — if the guard returns `false`, the selection change is blocked.
 */
export function useSelect(): SelectAction {
	const consultGuard = useConsultEditGuard();
	const clearFocusHint = useClearFocusHint();
	const loc = useLocation();

	/* Ref for `loc` so the returned callback doesn't churn on every
	 * selection change. The callback only needs the screen identity
	 * (moduleUuid, formUuid) — not the selected field — and those
	 * only change on screen navigation, not selection clicks. */
	const locRef = useRef(loc);
	locRef.current = loc;

	return useMemo<SelectAction>(() => {
		const getBasePath = (): string => {
			const parts = window.location.pathname.split("/").filter(Boolean);
			return `/${parts.slice(0, 2).join("/")}`;
		};

		return (uuid: Uuid | undefined): void => {
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
			const current = locRef.current;
			if (current.kind !== "form") return;
			const next: Location = {
				kind: "form",
				moduleUuid: current.moduleUuid,
				formUuid: current.formUuid,
				selectedUuid: uuid,
			};
			const url = buildUrl(getBasePath(), next);
			window.history.replaceState(null, "", url);
			notifyPathChange();
		};
	}, [consultGuard, clearFocusHint]);
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
