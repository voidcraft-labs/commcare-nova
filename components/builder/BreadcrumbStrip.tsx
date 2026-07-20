/**
 * BreadcrumbStrip — history navigation + the breadcrumb trail, docked
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
 * "Results" tab.
 *
 * The row is a ContentFrame sharing the one content frame every screen
 * uses (`5xl` / `px-6`), so the trail's left edge never shifts between
 * screens and glides with the content through the mode flip (see
 * ContentFrame.tsx).
 */
"use client";
import { useMemo } from "react";
import { CaseDataManager } from "@/components/builder/CaseDataManager";
import { ContentFrame } from "@/components/builder/ContentFrame";
import type { BreadcrumbPart } from "@/components/builder/SubheaderToolbar";
import { CollapsibleBreadcrumb } from "@/components/builder/SubheaderToolbar";
import { ScreenNavButtons } from "@/components/preview/ScreenNavButtons";
import { useMaterializableCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { useOrderedForms } from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/doc/types";
import { useBreadcrumbs, useLocation, useNavigate } from "@/lib/routing/hooks";
import {
	type PreviewBreadcrumbItem,
	previewBreadcrumbTrail,
} from "@/lib/routing/previewBreadcrumbs";
import {
	useAppId,
	useCanEdit,
	usePreviewCaseTarget,
	usePreviewing,
	usePreviewSelectedCase,
	useSetPreviewCaseTarget,
} from "@/lib/session/hooks";
import { useIsBreakpoint } from "@/lib/ui/hooks/useIsBreakpoint";

/** Stable no-op handler for breadcrumb items that don't navigate. */
const noop = () => {};

/** The complete page-navigation landmark shared by every builder screen. */
export function BuilderPageNavigation({
	hasData,
	canGoBack,
	onBack,
	parts,
	compactWorkspaceBreadcrumb = false,
}: {
	readonly hasData: boolean;
	readonly canGoBack: boolean;
	readonly onBack: () => void;
	readonly parts: BreadcrumbPart[];
	readonly compactWorkspaceBreadcrumb?: boolean;
}) {
	return (
		<nav
			aria-label="Page navigation"
			className="flex min-w-0 flex-1 items-center gap-2"
		>
			{hasData && <ScreenNavButtons canGoBack={canGoBack} onBack={onBack} />}
			<CollapsibleBreadcrumb
				parts={parts}
				compactWorkspace={compactWorkspaceBreadcrumb}
			/>
		</nav>
	);
}

export function BreadcrumbStrip() {
	const hasData = useDocHasData();
	const compactHeight = useIsBreakpoint("max", 360, "height");
	const handsetLayout = useIsBreakpoint("max", 560);

	const loc = useLocation();
	const navigate = useNavigate();
	const canGoBack = loc.kind !== "home";

	/* Every preview/edit surface shares ONE content frame — `5xl` wide with
	 * a `px-6` inset — so navigating between screens never swaps width OR
	 * shifts the left edge; the strip matches it exactly. */

	/* Breadcrumbs derived from URL + doc entity names. */
	const breadcrumbs = useBreadcrumbs();

	/* In preview the trail follows the RUNNING APP, not the editor (the
	 * rewrite lives in the pure, tested `previewBreadcrumbTrail`). Home +
	 * module crumbs are unchanged; edit mode keeps the URL-derived trail. */
	const previewing = usePreviewing();
	const compactWorkspaceBreadcrumb =
		handsetLayout &&
		!previewing &&
		((loc.kind === "cases" && loc.caseId === undefined) ||
			loc.kind === "search-config" ||
			loc.kind === "detail-config");
	const previewCaseTarget = usePreviewCaseTarget();
	const previewSelectedCase = usePreviewSelectedCase();
	const setPreviewCaseTarget = useSetPreviewCaseTarget();
	const moduleUuid =
		loc.kind === "module" ||
		loc.kind === "cases" ||
		loc.kind === "search-config" ||
		loc.kind === "detail-config" ||
		loc.kind === "form"
			? loc.moduleUuid
			: undefined;
	const appId = useAppId();
	const canEdit = useCanEdit();
	const currentModule = useModule(moduleUuid);
	const materializableCaseTypes = useMaterializableCaseTypes();
	const caseType = materializableCaseTypes.find(
		(candidate) => candidate.name === currentModule?.caseType,
	);
	const hasLinkedChildren = materializableCaseTypes.some(
		(candidate) => candidate.parent_type === caseType?.name,
	);
	const moduleForms = useOrderedForms((moduleUuid ?? "") as Uuid);

	const effectiveBreadcrumbs: PreviewBreadcrumbItem[] = useMemo(() => {
		if (!previewing) return breadcrumbs;
		return previewBreadcrumbTrail({
			loc,
			baseBreadcrumbs: breadcrumbs,
			moduleUuid,
			moduleForms,
			previewCaseTarget,
			previewSelectedCase,
		});
	}, [
		previewing,
		moduleUuid,
		loc,
		breadcrumbs,
		moduleForms,
		previewCaseTarget,
		previewSelectedCase,
	]);

	/* Breadcrumb click handlers, memoized on navigation structure so
	 * CollapsibleBreadcrumb's memo() skips re-renders when nothing changed.
	 * A case-loading form's crumb (`reselectCaseFor`) re-enters its
	 * case-selection step — re-open the case list seeded with this form as
	 * the continue target — instead of re-navigating to the form the user is
	 * already on; every other crumb pushes its location. */
	const breadcrumbHandlers = useMemo(
		() =>
			effectiveBreadcrumbs.map((item) => {
				const reselectFor = item.reselectCaseFor;
				if (reselectFor && moduleUuid) {
					return () => {
						setPreviewCaseTarget({ formUuid: reselectFor });
						navigate.openCaseList(moduleUuid);
					};
				}
				return () => navigate.push(item.location);
			}),
		[effectiveBreadcrumbs, navigate, moduleUuid, setPreviewCaseTarget],
	);

	/* Assemble breadcrumb parts — memoized so CollapsibleBreadcrumb's memo
	 * boundary actually works. Without useMemo, every render creates a new
	 * array reference, defeating the child's memo check. Before the doc has
	 * data there is nothing to navigate, so the strip stays an empty bar. */
	const breadcrumbParts: BreadcrumbPart[] = useMemo(() => {
		if (!hasData) return [];
		return effectiveBreadcrumbs.map((item, i) => ({
			key: item.key,
			label: item.label,
			onClick: breadcrumbHandlers[i] ?? noop,
		}));
	}, [hasData, effectiveBreadcrumbs, breadcrumbHandlers]);

	return (
		<div
			className={`shrink-0 border-b border-nova-border bg-pv-bg ${
				compactHeight ? "h-[60px]" : "h-16"
			}`}
			data-builder-secondary-header="breadcrumb"
		>
			<ContentFrame
				width="5xl"
				className="flex items-center gap-2 min-w-0 h-full px-6"
			>
				<BuilderPageNavigation
					hasData={hasData}
					canGoBack={canGoBack}
					onBack={() => navigate.back()}
					parts={breadcrumbParts}
					compactWorkspaceBreadcrumb={compactWorkspaceBreadcrumb}
				/>
				{appId && caseType && moduleUuid && (
					<CaseDataManager
						key={`${appId}\u0000${caseType.name}`}
						appId={appId}
						moduleUuid={moduleUuid}
						caseType={caseType}
						canEdit={canEdit}
						hasLinkedChildren={hasLinkedChildren}
					/>
				)}
			</ContentFrame>
		</div>
	);
}
