/**
 * BreadcrumbStrip — back/up navigation + the breadcrumb trail, docked
 * at the top of the canvas column (between the sidebars, not in the
 * full-width header). The sidebars bound its width, so a long trail
 * collapses through `CollapsibleBreadcrumb` instead of growing toward
 * the header's centered Preview toggle — wayfinding and the mode
 * toggle can never collide.
 *
 * Self-sufficient: navigation state from `useLocation` / `useNavigate`
 * / `useBreadcrumbs` (URL-driven), names from the doc store. In preview
 * the trail is rebuilt to follow the running app — a case-list URL names
 * the case-loading FORM it feeds (plus the picked case), not the editor's
 * "Case List" tab.
 *
 * The row is a ContentFrame sharing the one content frame every screen
 * uses (`5xl` / `px-6`), so the trail's left edge never shifts between
 * screens and glides with the content through the mode flip (see
 * ContentFrame.tsx).
 */
"use client";
import { useMemo } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import type { BreadcrumbPart } from "@/components/builder/SubheaderToolbar";
import { CollapsibleBreadcrumb } from "@/components/builder/SubheaderToolbar";
import { ScreenNavButtons } from "@/components/preview/ScreenNavButtons";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import { useOrderedForms } from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/doc/types";
import { CASE_LOADING_FORM_TYPES } from "@/lib/domain";
import {
	type BreadcrumbItem,
	useBreadcrumbs,
	useLocation,
	useNavigate,
} from "@/lib/routing/hooks";
import {
	usePreviewCaseTarget,
	usePreviewing,
	usePreviewSelectedCase,
} from "@/lib/session/hooks";

/** Stable no-op handler for breadcrumb items that don't navigate. */
const noop = () => {};

export function BreadcrumbStrip() {
	const hasData = useDocHasData();

	const loc = useLocation();
	const navigate = useNavigate();
	const canGoBack = loc.kind !== "home";
	const canGoUp = loc.kind !== "home";

	/* Every preview/edit surface shares ONE content frame — `5xl` wide with
	 * a `px-6` inset — so navigating between screens never swaps width OR
	 * shifts the left edge; the strip matches it exactly. */

	/* Breadcrumbs derived from URL + doc entity names. */
	const breadcrumbs = useBreadcrumbs();
	const appName = useAppName();

	/* In preview the trail follows the RUNNING APP, not the editor. A
	 * case-list URL is the case-selection step for a case-loading form, so
	 * the trailing crumb names that FORM (never "Case List"/"Search"/"Case
	 * Detail"), and the picked case appends after it. Home + module crumbs
	 * are unchanged; edit mode keeps the URL-derived trail as-is. */
	const previewing = usePreviewing();
	const previewCaseTarget = usePreviewCaseTarget();
	const previewSelectedCase = usePreviewSelectedCase();
	const moduleUuid =
		loc.kind === "module" ||
		loc.kind === "cases" ||
		loc.kind === "search-config" ||
		loc.kind === "detail-config" ||
		loc.kind === "form"
			? loc.moduleUuid
			: undefined;
	const moduleForms = useOrderedForms((moduleUuid ?? "") as Uuid);

	const effectiveBreadcrumbs: BreadcrumbItem[] = useMemo(() => {
		if (!previewing || !moduleUuid) return breadcrumbs;

		const homeAndModule = breadcrumbs.filter(
			(b) => b.location.kind === "home" || b.location.kind === "module",
		);

		if (loc.kind === "form") {
			const form = moduleForms.find((f) => f.uuid === loc.formUuid);
			const items: BreadcrumbItem[] = [
				...homeAndModule,
				{
					key: `f:${loc.formUuid}`,
					label: form?.name ?? "Form",
					location: { kind: "form", moduleUuid, formUuid: loc.formUuid },
				},
			];
			if (previewCaseTarget?.caseName) {
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
			loc.kind === "detail-config"
		) {
			const items = [...homeAndModule];
			/* Name the case-loading form this list feeds: the form tapped to
			 * get here, else the module's sole case-loading form. With several
			 * unchosen (a case-first module's form menu), there's no single
			 * form yet, so the crumb is omitted until one is picked. */
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

		return breadcrumbs;
	}, [
		previewing,
		moduleUuid,
		loc,
		breadcrumbs,
		moduleForms,
		previewCaseTarget,
		previewSelectedCase,
	]);

	/* Breadcrumb click handlers — navigate to each breadcrumb's location.
	 * Memoized on navigation structure so CollapsibleBreadcrumb's memo()
	 * skips re-renders when nothing changed. */
	const breadcrumbHandlers = useMemo(
		() =>
			effectiveBreadcrumbs.map((item) => () => navigate.push(item.location)),
		[effectiveBreadcrumbs, navigate],
	);

	/* Assemble breadcrumb parts — memoized so CollapsibleBreadcrumb's memo
	 * boundary actually works. Without useMemo, every render creates a new
	 * array reference, defeating the child's memo check. */
	const breadcrumbParts: BreadcrumbPart[] = useMemo(() => {
		if (!hasData) {
			return appName ? [{ key: "home", label: appName, onClick: noop }] : [];
		}
		return effectiveBreadcrumbs.map((item, i) => ({
			key: item.key,
			label: item.label,
			onClick: breadcrumbHandlers[i] ?? noop,
		}));
	}, [hasData, appName, effectiveBreadcrumbs, breadcrumbHandlers]);

	return (
		<div className="shrink-0 h-12 border-b border-nova-border bg-pv-bg">
			<ContentFrame
				width="5xl"
				className="flex items-center gap-2 min-w-0 h-full px-6"
			>
				{hasData && (
					<ScreenNavButtons
						canGoBack={canGoBack}
						canGoUp={canGoUp}
						onBack={() => navigate.back()}
						onUp={() => navigate.up()}
					/>
				)}
				<CollapsibleBreadcrumb parts={breadcrumbParts} />
			</ContentFrame>
		</div>
	);
}
