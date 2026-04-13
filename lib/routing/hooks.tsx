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
import { useMemo } from "react";
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
 * `true` when a specific question uuid is the current selection.
 * Each `EditableQuestionWrapper` calls this with its own identity —
 * only the previously-selected and newly-selected wrappers re-render
 * on a selection change (every other wrapper's boolean stays `false`).
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
 * The returned object is frozen to make mis-uses obvious; every value
 * is stable across renders (the closures only close over the stable
 * `router` and `pathname` references).
 */
export function useNavigate() {
	const router = useRouter();
	const pathname = usePathname();
	const loc = useLocation();

	return useMemo(
		() => ({
			/** Push a new location (history entry). Use for screen changes. */
			push(next: Location, opts?: { replace?: boolean }): void {
				const params = serializeLocation(next).toString();
				const url = params ? `${pathname}?${params}` : pathname;
				if (opts?.replace) router.replace(url, { scroll: false });
				else router.push(url, { scroll: false });
			},
			/** Replace the current location (no history entry). */
			replace(next: Location): void {
				const params = serializeLocation(next).toString();
				const url = params ? `${pathname}?${params}` : pathname;
				router.replace(url, { scroll: false });
			},
			/** Go to the app home. */
			goHome(): void {
				router.push(pathname, { scroll: false });
			},
			/** Go to a module screen. */
			openModule(moduleUuid: Uuid): void {
				this.push({ kind: "module", moduleUuid });
			},
			/** Go to a module's case list. */
			openCaseList(moduleUuid: Uuid): void {
				this.push({ kind: "cases", moduleUuid });
			},
			/** Open a specific case detail (form-screen precursor). */
			openCaseDetail(moduleUuid: Uuid, caseId: string): void {
				this.push({ kind: "cases", moduleUuid, caseId });
			},
			/** Open a form. Clears any existing selection. */
			openForm(moduleUuid: Uuid, formUuid: Uuid, selectedUuid?: Uuid): void {
				this.push({
					kind: "form",
					moduleUuid,
					formUuid,
					selectedUuid,
				});
			},
			/** Browser-back. Walks the actual history stack. */
			back(): void {
				router.back();
			},
			/** Go to the immediate parent of the current location. */
			up(): void {
				const parent = parentLocation(loc);
				if (parent) this.push(parent);
			},
		}),
		[router, pathname, loc],
	);
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
 */
export function useSelect() {
	const router = useRouter();
	const pathname = usePathname();
	const loc = useLocation();

	return useMemo(() => {
		return (uuid: Uuid | undefined): void => {
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
	}, [router, pathname, loc]);
}
