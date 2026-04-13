/**
 * URL-driven location hooks — Phase 2's public client surface for the
 * builder's navigation and selection state.
 *
 * The URL on /build/[id] is the sole source of truth for "where you are"
 * (home / module / case list / form) and "what's focused" (selected
 * question). Nothing in any Zustand store represents this state.
 *
 * Navigation operations fall into two buckets:
 *
 * 1. **Screen changes** (home ↔ module ↔ form) use `router.push` so each
 *    move becomes a browser history entry. The back/forward buttons
 *    traverse this history for free.
 * 2. **Selection changes** (the `sel=` query param flipping on question
 *    clicks) use `router.replace` so rapid clicking through questions
 *    doesn't flood history. Back from a form goes to the module, not
 *    through every question the user happened to click in that form.
 *
 * Every navigation call passes `{ scroll: false }` — Next's App Router
 * otherwise scrolls to the top of the page on push, which would undo
 * our own scroll-to-selection behavior.
 */

"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef } from "react";
import { useBuilderEngine } from "@/hooks/useBuilder";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type {
	FormEntity,
	ModuleEntity,
	QuestionEntity,
	Uuid,
} from "@/lib/doc/types";
import {
	isValidLocation,
	parseLocation,
	serializeLocation,
} from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";

/**
 * Reactive parse of the current URL into a `Location`. Re-renders on
 * every URL param change (App Router's `useSearchParams` provides the
 * subscription).
 *
 * Malformed/incomplete URLs degrade to `{ kind: "home" }` — see
 * `parseLocation` for the rules.
 */
export function useLocation(): Location {
	const params = useSearchParams();
	return useMemo(() => parseLocation(params), [params]);
}

/**
 * Derive the selected question entity from the current URL and doc.
 * Returns `null` when there's no `sel=` in the URL, when the current
 * screen isn't a form, or when the referenced uuid no longer exists
 * (the deletion-recovery effect in `LocationRecoveryEffect` will strip
 * the stale param on the next tick).
 */
export function useSelectedQuestion(): QuestionEntity | null {
	const loc = useLocation();
	const selectedUuid = loc.kind === "form" ? loc.selectedUuid : undefined;
	const question = useBlueprintDoc((s) =>
		selectedUuid ? s.questions[selectedUuid] : undefined,
	);
	return question ?? null;
}

/**
 * Derive the `{ module, form }` context the selected-question panel
 * needs — one shallow read per entity, `null` if we're not on a form
 * screen or an entity is missing.
 */
export function useSelectedFormContext(): {
	module: ModuleEntity;
	form: FormEntity;
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
 * changes), because `useLocation` subscribes to the full search params.
 * The boolean return prevents child reconciliation for non-matching cards.
 * Phase 5's virtualization bounds the number of consumers to visible rows.
 */
export function useIsModuleSelected(uuid: Uuid | string): boolean {
	const loc = useLocation();
	return (
		(loc.kind === "module" || loc.kind === "cases" || loc.kind === "form") &&
		loc.moduleUuid === uuid
	);
}

/**
 * `true` when the current URL points to this exact form.
 * Used by `FormCard` in the tree sidebar for highlight state.
 *
 * Tradeoff: same as `useIsModuleSelected` — any URL change triggers a
 * re-render, but the boolean return prevents child reconciliation.
 * Phase 5's virtualization bounds the consumer count.
 */
export function useIsFormSelected(uuid: Uuid | string): boolean {
	const loc = useLocation();
	return loc.kind === "form" && loc.formUuid === uuid;
}

/**
 * `true` when a specific question uuid is the current selection.
 * Each `EditableQuestionWrapper` calls this with its own identity —
 * only the previously-selected and newly-selected wrappers re-render
 * on a selection change (every other wrapper's boolean stays `false`).
 *
 * Tradeoff: this hook re-renders on any URL change (not just selection
 * changes), because `useLocation` subscribes to the full search params.
 * Phase 5's virtualization makes this moot — the boolean return still
 * prevents child reconciliation for unselected wrappers.
 */
export function useIsQuestionSelected(uuid: Uuid | string): boolean {
	const loc = useLocation();
	return loc.kind === "form" && loc.selectedUuid === uuid;
}

/**
 * True when the URL's location references exist in the doc. Consumed
 * by the root `LocationRecoveryEffect` to decide when to scrub stale
 * params. Callers should not use this to gate rendering — the effect
 * replaces the URL in the same tick as a mismatch is detected, and
 * gating rendering would cause a flash.
 */
export function useLocationValid(): boolean {
	const loc = useLocation();
	return useBlueprintDoc((s) => isValidLocation(loc, s));
}

/**
 * A `BreadcrumbItem` matches the legacy `lib/services/builderSelectors`
 * shape so migrated consumers keep their render code unchanged.
 * `navigateTo` fires a `useNavigate()` action on click — Task 1 doesn't
 * embed a click handler here; consumers get the raw list and wire the
 * click via the navigate action.
 */
export interface BreadcrumbItem {
	key: string;
	label: string;
	location: Location;
}

/**
 * Derived breadcrumb trail from the current location + doc names.
 * Everything is read through shallow-stable selectors, so unrelated
 * doc mutations don't cause re-renders here.
 */
export function useBreadcrumbs(): BreadcrumbItem[] {
	const loc = useLocation();
	const appName = useBlueprintDoc((s) => s.appName);

	const moduleUuid =
		loc.kind === "module" || loc.kind === "cases" || loc.kind === "form"
			? loc.moduleUuid
			: undefined;
	const formUuid = loc.kind === "form" ? loc.formUuid : undefined;

	const moduleName = useBlueprintDoc((s) =>
		moduleUuid ? s.modules[moduleUuid]?.name : undefined,
	);
	const formName = useBlueprintDoc((s) =>
		formUuid ? s.forms[formUuid]?.name : undefined,
	);
	const moduleCaseType = useBlueprintDoc((s) =>
		moduleUuid ? s.modules[moduleUuid]?.caseType : undefined,
	);

	return useMemo<BreadcrumbItem[]>(() => {
		const items: BreadcrumbItem[] = [
			{ key: "home", label: appName || "Home", location: { kind: "home" } },
		];
		if (moduleUuid) {
			items.push({
				key: `m:${moduleUuid}`,
				label: moduleName ?? "Module",
				location: { kind: "module", moduleUuid },
			});
		}
		if (loc.kind === "cases") {
			items.push({
				key: `cases:${moduleUuid}`,
				label: moduleCaseType ? `${moduleCaseType} cases` : "Cases",
				location: { kind: "cases", moduleUuid: loc.moduleUuid },
			});
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
		if (loc.kind === "form" && formUuid && moduleUuid) {
			items.push({
				key: `f:${formUuid}`,
				label: formName ?? "Form",
				location: { kind: "form", moduleUuid, formUuid },
			});
		}
		return items;
	}, [
		appName,
		loc,
		moduleUuid,
		formUuid,
		moduleName,
		formName,
		moduleCaseType,
	]);
}

/**
 * Location + navigation actions. Selection edits use `router.replace`
 * (no history entry); screen changes use `router.push` with
 * `{ scroll: false }`.
 *
 * The returned object is stable across URL changes — a ref captures the
 * current location for `up()` without adding it to the `useMemo` deps.
 * Every method is a standalone arrow, safe to destructure without losing
 * `this` context.
 */
export function useNavigate(): NavigateActions {
	const router = useRouter();
	const pathname = usePathname();
	const loc = useLocation();

	// Capture current location in a ref so `up()` can read it without
	// including `loc` in useMemo deps (which would recreate every action
	// on every URL change, churning downstream memoization).
	const locRef = useRef(loc);
	locRef.current = loc;

	return useMemo(() => {
		/** Push a new location (history entry). Use for screen changes. */
		const push = (next: Location, opts?: { replace?: boolean }): void => {
			const params = serializeLocation(next).toString();
			const url = params ? `${pathname}?${params}` : pathname;
			if (opts?.replace) router.replace(url, { scroll: false });
			else router.push(url, { scroll: false });
		};

		/** Replace the current location (no history entry). */
		const replace = (next: Location): void => {
			const params = serializeLocation(next).toString();
			const url = params ? `${pathname}?${params}` : pathname;
			router.replace(url, { scroll: false });
		};

		return {
			push,
			replace,
			goHome: () => router.push(pathname, { scroll: false }),
			openModule: (moduleUuid: Uuid) => push({ kind: "module", moduleUuid }),
			openCaseList: (moduleUuid: Uuid) => push({ kind: "cases", moduleUuid }),
			openCaseDetail: (moduleUuid: Uuid, caseId: string) =>
				push({ kind: "cases", moduleUuid, caseId }),
			openForm: (moduleUuid: Uuid, formUuid: Uuid, selectedUuid?: Uuid) =>
				push({ kind: "form", moduleUuid, formUuid, selectedUuid }),
			back: () => router.back(),
			up: () => {
				const parent = parentLocation(locRef.current);
				if (parent) push(parent);
			},
		};
	}, [router, pathname]);
}

/** Pure parent-derivation for the `up` navigation. */
function parentLocation(loc: Location): Location | undefined {
	switch (loc.kind) {
		case "home":
			return undefined;
		case "module":
			return { kind: "home" };
		case "cases":
			return loc.caseId
				? { kind: "cases", moduleUuid: loc.moduleUuid }
				: { kind: "module", moduleUuid: loc.moduleUuid };
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
 * Selection-only operation. Flips the `sel=` query param on the
 * current form without otherwise changing the screen. No-ops when
 * not on a form location (selection only exists inside a form).
 *
 * `uuid === undefined` clears the current selection.
 *
 * **Edit guard integration.** Inline editors with unsaved invalid
 * content (e.g. the XPath editor in `XPathField`) install a guard via
 * `engine.setEditGuard()`. Before changing the URL, `useSelect`
 * consults `engine.checkEditGuard()` — if the guard returns `false`,
 * the selection change is blocked. The documented two-strike UX
 * ("warn then allow") lives inside the guard predicate itself: its
 * first invocation returns `false` and surfaces a warning; its second
 * invocation returns `true`, letting the selection through.
 *
 * `useNavigate` intentionally does NOT consult the guard — the spec
 * only requires guarding selection changes, and screen-level
 * navigation (back/forward, breadcrumb clicks, sidebar form switches)
 * should never be silently swallowed by an unrelated field's unsaved
 * state. Revisit if users report lost XPath edits on screen change.
 */
export function useSelect(): SelectAction {
	const router = useRouter();
	const pathname = usePathname();
	// `useBuilderEngine` returns the engine created once per
	// `BuilderProvider` mount, so its identity is stable across renders
	// and doesn't churn this memo's dependency set.
	const engine = useBuilderEngine();
	const loc = useLocation();

	return useMemo<SelectAction>(() => {
		return (uuid: Uuid | undefined): void => {
			/* Honor any guard registered by an inline editor with unsaved
			 * invalid content. The two-strike pattern (warn, then allow on
			 * repeat) is owned by the guard predicate — this call site is
			 * just a gate. */
			if (!engine.checkEditGuard()) return;
			if (loc.kind !== "form") return;
			const next: Location = {
				kind: "form",
				moduleUuid: loc.moduleUuid,
				formUuid: loc.formUuid,
				selectedUuid: uuid,
			};
			const params = serializeLocation(next).toString();
			const url = params ? `${pathname}?${params}` : pathname;
			router.replace(url, { scroll: false });
		};
	}, [router, pathname, engine, loc]);
}
