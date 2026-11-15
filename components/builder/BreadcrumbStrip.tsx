/**
 * BreadcrumbStrip: history navigation + the breadcrumb trail, docked
 * at the top of the canvas column (between the sidebars, not in the
 * full-width header). The sidebars bound its width, so a long trail
 * collapses through `CollapsibleBreadcrumb` instead of growing toward
 * the header's centered Preview toggle: wayfinding and the mode
 * toggle can never collide.
 *
 * Self-sufficient: navigation state from `useLocation` / `useNavigate`
 * / `useBreadcrumbs` (URL-driven), names from the doc store. In preview
 * the trail is rebuilt to follow the running app: a case-list URL names
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
import { BuilderPageNavigation } from "@/components/builder/BuilderPageNavigation";
import { CaseDataManager } from "@/components/builder/CaseDataManager";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import type { BreadcrumbPart } from "@/components/builder/SubheaderToolbar";

export { BuilderPageNavigation } from "@/components/builder/BuilderPageNavigation";

import { useAppName } from "@/lib/doc/hooks/useAppName";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	useEffectiveCaseTypes,
	useMaterializableCaseTypes,
} from "@/lib/doc/hooks/useCaseTypes";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import { useModule } from "@/lib/doc/hooks/useEntity";
import {
	useOrderedForms,
	useOrderedModules,
} from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/doc/types";
import { moduleShowsFormsInMenuAbove } from "@/lib/domain";
import { usePreviewMenuSource } from "@/lib/preview/hooks/usePreviewMenuSource";
import { usePreviewScreenForLocation } from "@/lib/preview/hooks/usePreviewScreenForLocation";
import {
	previewCaseListReturn,
	previewMenuHeldSelections,
	previewMenuSelectionsLetGo,
	previewTargetAboveForm,
} from "@/lib/preview/menuProjection";
import { useBreadcrumbs, useLocation, useNavigate } from "@/lib/routing/hooks";
import {
	DEVICE_HOME_CRUMB_KEY,
	type PreviewBreadcrumbItem,
	previewBreadcrumbTrail,
} from "@/lib/routing/previewBreadcrumbs";
import {
	useAppId,
	useCanEdit,
	usePreviewAtDeviceHome,
	usePreviewCaseTarget,
	usePreviewing,
	usePreviewMenuCaseSelections,
	usePreviewPlatformRules,
	usePreviewSelectedCase,
	useSetPreviewAtDeviceHome,
	useSetPreviewCaseTarget,
	useSetPreviewMenuCaseSelection,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { useIsBreakpoint } from "@/lib/ui/hooks/useIsBreakpoint";

/** Stable no-op handler for breadcrumb items that don't navigate. */
const noop = () => {};

export function BreadcrumbStrip() {
	const hasData = useDocHasData();
	const compactHeight = useIsBreakpoint("max", 360, "height");
	const handsetLayout = useIsBreakpoint("max", 560);

	const loc = useLocation();
	const navigate = useNavigate();
	const previewing = usePreviewing();
	/* Android opens on the phone's home screen, so Back on its module list
	 * returns there. The strip renders in edit mode too, where Back stays off
	 * on the home screen. */
	const platformRules = usePreviewPlatformRules();
	const atDeviceHome = usePreviewAtDeviceHome();
	const setPreviewAtDeviceHome = useSetPreviewAtDeviceHome();
	const backToDeviceHome =
		previewing &&
		loc.kind === "home" &&
		platformRules.appHome === "device-home" &&
		!atDeviceHome;
	const canGoBack = loc.kind !== "home" || backToDeviceHome;

	/* Every preview/edit surface shares ONE content frame: `5xl` wide with
	 * a `px-6` inset, so navigating between screens never swaps width OR
	 * shifts the left edge; the strip matches it exactly. */

	/* Breadcrumbs derived from URL + doc entity names. */
	const breadcrumbs = useBreadcrumbs();

	/* In preview the trail follows the RUNNING APP, not the editor (the
	 * rewrite lives in the pure, tested `previewBreadcrumbTrail`). Home +
	 * module crumbs are unchanged; edit mode keeps the URL-derived trail. */
	/* Workspaces whose fixed tab strip already carries current-screen
	 * semantics (the case workspace's Search / Results / Details, App
	 * setup's section strip): on handsets the breadcrumb drops the
	 * redundant leaf and collapses its ancestors into one path menu. */
	const { language } = useBuilderLanguage();
	const appName = useAppName();
	const renderedPreviewScreen = usePreviewScreenForLocation(loc);
	const compactWorkspaceBreadcrumb =
		handsetLayout &&
		!previewing &&
		((loc.kind === "cases" && loc.caseId === undefined) ||
			loc.kind === "search-config" ||
			loc.kind === "detail-config" ||
			loc.kind === "app-setup");
	const previewCaseTarget = usePreviewCaseTarget();
	const previewSelectedCase = usePreviewSelectedCase();
	const setPreviewCaseTarget = useSetPreviewCaseTarget();
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
	const appId = useAppId();
	const canEdit = useCanEdit();
	const currentModule = useModule(moduleUuid);
	const materializableCaseTypes = useMaterializableCaseTypes();
	const effectiveCaseTypes = useEffectiveCaseTypes();
	const orderedModules = useOrderedModules();
	const moduleUuidByCaseType = useMemo(
		() =>
			orderedModules.reduce<Record<string, Uuid>>((byCaseType, module) => {
				if (
					module.caseType !== undefined &&
					byCaseType[module.caseType] === undefined
				) {
					byCaseType[module.caseType] = module.uuid;
				}
				return byCaseType;
			}, {}),
		[orderedModules],
	);
	const moduleForms = useOrderedForms(moduleUuid);
	const screenlessModuleUuids = useMemo(
		() =>
			new Set(
				orderedModules
					.filter((module) => moduleShowsFormsInMenuAbove(module))
					.map((module) => module.uuid),
			),
		[orderedModules],
	);

	/* The cases a running menu screen holds, each named in its trail. */
	const menuSource = usePreviewMenuSource();
	const menuCaseSelections = usePreviewMenuCaseSelections();
	const renderedMenuUuid =
		renderedPreviewScreen.type === "module"
			? renderedPreviewScreen.moduleUuid
			: undefined;
	const menuHeldCases = useMemo(
		() =>
			previewing && renderedMenuUuid !== undefined
				? previewMenuHeldSelections(
						menuSource,
						renderedMenuUuid,
						menuCaseSelections,
					)
				: [],
		[menuCaseSelections, menuSource, previewing, renderedMenuUuid],
	);

	const effectiveBreadcrumbs: PreviewBreadcrumbItem[] = useMemo(() => {
		if (!previewing) return breadcrumbs;
		return previewBreadcrumbTrail({
			language,
			loc,
			baseBreadcrumbs: breadcrumbs,
			moduleUuid,
			moduleForms,
			previewCaseTarget,
			previewSelectedCase,
			renderedScreen: renderedPreviewScreen,
			appHome: platformRules.appHome,
			atDeviceHome,
			appName,
			screenlessModuleUuids,
			menuHeldCases,
		});
	}, [
		menuHeldCases,
		appName,
		screenlessModuleUuids,
		atDeviceHome,
		platformRules.appHome,
		language,
		previewing,
		moduleUuid,
		loc,
		breadcrumbs,
		moduleForms,
		previewCaseTarget,
		previewSelectedCase,
		renderedPreviewScreen,
	]);

	/* Breadcrumb click handlers, memoized on navigation structure so
	 * CollapsibleBreadcrumb's memo() skips re-renders when nothing changed.
	 * In Preview a crumb ends the session's steps at the screen it names, as
	 * Web Apps' breadcrumb cuts its selections back to that step
	 * (`spliceSelections`): a case-loading form's crumb (`reselectCaseFor`)
	 * re-enters its case selection, a held case's crumb (`holdsCaseOn`)
	 * reaches the menu that holds it, and a menu's crumb lets go of every
	 * case chosen on it or past it. Each reads the session when it runs. */
	const sessionApi = useBuilderSessionApi();
	const docApi = useBlueprintDocApi();
	const setPreviewMenuCaseSelection = useSetPreviewMenuCaseSelection();
	const breadcrumbHandlers = useMemo(() => {
		const letGo = (screen: {
			moduleUuid: Uuid | undefined;
			through?: true;
		}) => {
			for (const uuid of previewMenuSelectionsLetGo(
				docApi.getState(),
				sessionApi.getState().previewMenuCaseSelections,
				screen,
			))
				setPreviewMenuCaseSelection(uuid, undefined);
		};
		return effectiveBreadcrumbs.map((item) => {
			const reselectFor = item.reselectCaseFor;
			const holder = item.holdsCaseOn;
			if (item.key === DEVICE_HOME_CRUMB_KEY)
				return () => setPreviewAtDeviceHome(true);
			if (!previewing) return () => navigate.push(item.location);
			if (reselectFor && moduleUuid) {
				/* Re-enter the case selection as a route back from the form
				 * does: the list that chose its case, holding the form only
				 * where the worker chose it before the case. */
				return () => {
					const back = previewCaseListReturn(
						sessionApi.getState().previewCaseTarget,
						{ moduleUuid, formUuid: reselectFor },
					);
					setPreviewCaseTarget(back.target);
					navigate.openCaseList(back.moduleUuid);
				};
			}
			if (holder !== undefined) {
				/* The menu that holds the case. A case list's own form menu, on
				 * the crumb of a form chosen there, holds the cases the crumb
				 * names on a history entry of its own, reached again by a step
				 * back where the form was opened from it
				 * (`navigate.reopenPreviewHeldMenu`). A menu screen holds the
				 * case in its selection, which stays with the selections above
				 * it, and lets a form's target go, whatever list chose it. */
				const caseListMenu = item.holdsCaseListMenu;
				return () => {
					letGo({ moduleUuid: holder, through: true });
					if (caseListMenu !== undefined && caseListMenu.length > 0) {
						navigate.reopenPreviewHeldMenu({
							moduleUuid: holder,
							cases: caseListMenu,
							session: sessionApi.getState().previewSessionId,
						});
						return;
					}
					setPreviewCaseTarget(
						previewTargetAboveForm(sessionApi.getState().previewCaseTarget),
					);
					navigate.push(item.location);
				};
			}
			if (item.key === "home" || item.key.startsWith("m:"))
				return () => {
					setPreviewCaseTarget(
						previewTargetAboveForm(sessionApi.getState().previewCaseTarget),
					);
					letGo({
						moduleUuid: item.key.startsWith("m:")
							? (item.key.slice(2) as Uuid)
							: undefined,
					});
					navigate.push(item.location);
				};
			return () => navigate.push(item.location);
		});
	}, [
		docApi,
		effectiveBreadcrumbs,
		navigate,
		moduleUuid,
		previewing,
		sessionApi,
		setPreviewAtDeviceHome,
		setPreviewCaseTarget,
		setPreviewMenuCaseSelection,
	]);

	/* Assemble breadcrumb parts: memoized so CollapsibleBreadcrumb's memo
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
					onBack={() =>
						backToDeviceHome ? setPreviewAtDeviceHome(true) : navigate.back()
					}
					parts={breadcrumbParts}
					workerLanguage={previewing ? language : undefined}
					compactWorkspaceBreadcrumb={compactWorkspaceBreadcrumb}
				/>
				{appId && materializableCaseTypes.length > 0 && (
					<CaseDataManager
						key={appId}
						appId={appId}
						caseTypes={materializableCaseTypes}
						effectiveCaseTypes={effectiveCaseTypes}
						moduleUuidByCaseType={moduleUuidByCaseType}
						initialCaseType={currentModule?.caseType}
						canEdit={canEdit}
					/>
				)}
			</ContentFrame>
		</div>
	);
}
