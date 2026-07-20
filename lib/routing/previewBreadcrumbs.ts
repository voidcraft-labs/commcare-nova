/**
 * Preview-mode breadcrumb trail — the running-app wayfinding derivation.
 *
 * In preview the trail follows the RUNNING APP, not the editor: a case-list
 * URL is the case-selection step for a case-loading form, so its trailing
 * crumb names that FORM (never "Search" / "Results" / "Details") and
 * the picked case appends after it; a form URL names the form and, when the
 * session's case target binds THIS form, the bound case.
 *
 * This logic used to live inline in `BreadcrumbStrip`. It now lives here as a
 * pure, exhaustively unit-tested function (the sibling of `parentLocation`)
 * for one reason: the breadcrumb and the preview engine each derive from the
 * SAME ephemeral session state
 * (`previewCaseTarget`), and they had drifted — `PreviewShell` gated the
 * loaded case on `formUuid === loc.formUuid` while the breadcrumb did not, so
 * a register form opened after a follow-up form named a case it never loaded.
 * `previewCaseTargetBindsLocation` is the one predicate both now share, so the
 * displayed case and the loaded case cannot disagree, and the whole class of
 * "the trail shows a screen the app isn't on" bugs is validated out by test.
 */

import type { Uuid } from "@/lib/doc/types";
import { CASE_LOADING_FORM_TYPES, type FormType } from "@/lib/domain";
import type { Location } from "@/lib/routing/types";
import type {
	PreviewCaseTarget,
	PreviewSelectedCase,
} from "@/lib/session/types";
import type { BreadcrumbItem } from "./hooks";

/** The slice of a form the trail needs: uuid (identity), name (label), and
 *  type (case-loading vs register — decides the case crumb and reselect). */
export interface PreviewTrailForm {
	uuid: Uuid;
	name: string;
	type: FormType;
}

/**
 * A preview breadcrumb — the URL-driven `BreadcrumbItem` plus the one
 * preview-only behavior the running app needs.
 */
export interface PreviewBreadcrumbItem extends BreadcrumbItem {
	/**
	 * Present on a case-loading form's crumb. A case-loading form is reached
	 * THROUGH its case list (pick a case → optional detail → form), so clicking
	 * its crumb re-enters that selection step — re-open the case list with this
	 * form as the continue target — rather than re-navigating to the form the
	 * user is already on. Carries the form uuid the strip seeds as the target.
	 * Absent on a register form's crumb, which has no case step (it stays a
	 * plain terminal location).
	 */
	reselectCaseFor?: Uuid;
}

/**
 * Whether the ephemeral preview case target binds the form the user is
 * currently on.
 *
 * THE shared predicate: both the preview engine (`PreviewShell`, which grafts
 * the bound `caseId` onto the form screen) and the breadcrumb (which names the
 * bound case) gate on it, so the loaded case and the displayed case can never
 * disagree. A target left over from a different form — e.g. a follow-up form's
 * case still in session when the user opens a register form — does NOT bind,
 * so the register form both shows and loads no case.
 */
export function previewCaseTargetBindsLocation(
	loc: Location,
	target: PreviewCaseTarget | undefined,
): boolean {
	return loc.kind === "form" && target?.formUuid === loc.formUuid;
}

/** Inputs to `previewBreadcrumbTrail` — all plain data, no hooks, so the
 *  derivation is pure and directly testable. */
export interface PreviewTrailInput {
	loc: Location;
	/** The URL-derived trail (home + module + …) from `useBreadcrumbs`. Only
	 *  its home and module crumbs are reused; the rest is rebuilt to follow the
	 *  running app. */
	baseBreadcrumbs: BreadcrumbItem[];
	/** The current module's uuid, or `undefined` off a module screen. */
	moduleUuid: Uuid | undefined;
	/** The current module's forms, in order. */
	moduleForms: readonly PreviewTrailForm[];
	/** The case-loading form the case list feeds + the case picked for it. */
	previewCaseTarget: PreviewCaseTarget | undefined;
	/** The case open in the running-app case list's detail/confirm. */
	previewSelectedCase: PreviewSelectedCase | undefined;
}

/**
 * Build the preview-mode breadcrumb trail. Returns `baseBreadcrumbs`
 * unchanged when there's no module context (home) — there's nothing
 * running-app-specific to rewrite. Callers invoke this only while previewing;
 * edit mode renders `baseBreadcrumbs` directly.
 */
export function previewBreadcrumbTrail(
	input: PreviewTrailInput,
): PreviewBreadcrumbItem[] {
	const {
		loc,
		baseBreadcrumbs,
		moduleUuid,
		moduleForms,
		previewCaseTarget,
		previewSelectedCase,
	} = input;

	if (!moduleUuid) return baseBreadcrumbs;

	const homeAndModule = baseBreadcrumbs.filter(
		(b) => b.location.kind === "home" || b.location.kind === "module",
	);

	if (loc.kind === "form") {
		const form = moduleForms.find((f) => f.uuid === loc.formUuid);
		const isCaseLoading =
			form !== undefined && CASE_LOADING_FORM_TYPES.has(form.type);
		const items: PreviewBreadcrumbItem[] = [
			...homeAndModule,
			{
				key: `f:${loc.formUuid}`,
				label: form?.name ?? "Form",
				location: { kind: "form", moduleUuid, formUuid: loc.formUuid },
				...(isCaseLoading ? { reselectCaseFor: loc.formUuid } : {}),
			},
		];
		/* Name the bound case ONLY when the session target binds THIS form —
		 * the same predicate PreviewShell grafts the caseId on, so the crumb
		 * and the loaded case never disagree. A target carried over from
		 * another form (e.g. a follow-up's case when a register form opens) is
		 * not this form's, so no case crumb appears. */
		if (
			previewCaseTargetBindsLocation(loc, previewCaseTarget) &&
			previewCaseTarget?.caseName
		) {
			items.push({
				key: `case:${previewCaseTarget.caseId ?? previewCaseTarget.caseName}`,
				label: previewCaseTarget.caseName,
				location: { kind: "form", moduleUuid, formUuid: loc.formUuid },
			});
		}
		return items;
	}

	if (
		loc.kind === "cases" ||
		loc.kind === "search-config" ||
		loc.kind === "detail-config" ||
		// Preview shows the running case list for the set-aside review's
		// URL (like the config kinds), so its trail follows the same
		// running-app rewrite.
		loc.kind === "set-aside"
	) {
		const items: PreviewBreadcrumbItem[] = [...homeAndModule];
		/* Name the case-loading form this list feeds: the form tapped to get
		 * here, else the module's sole case-loading form. With several unchosen
		 * (a case-first module's form menu), there's no single form yet, so the
		 * crumb is omitted until one is picked. */
		const caseLoading = moduleForms.filter((f) =>
			CASE_LOADING_FORM_TYPES.has(f.type),
		);
		const seeded = previewCaseTarget?.formUuid
			? caseLoading.find((f) => f.uuid === previewCaseTarget.formUuid)
			: undefined;
		const targetForm =
			seeded ?? (caseLoading.length === 1 ? caseLoading[0] : undefined);
		if (targetForm) {
			items.push({
				key: `pf:${targetForm.uuid}`,
				label: targetForm.name,
				location: { kind: "cases", moduleUuid },
			});
		}
		if (previewSelectedCase?.caseName) {
			items.push({
				key: `case:${previewSelectedCase.caseId}`,
				label: previewSelectedCase.caseName,
				location: { kind: "cases", moduleUuid },
			});
		}
		return items;
	}

	return baseBreadcrumbs;
}
