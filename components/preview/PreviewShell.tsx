/**
 * PreviewShell: renders the correct screen (home, module, case list, form)
 * based on the URL-driven location.
 *
 * ## Architecture
 *
 * Uses React 19's `<Activity>` component for screen retention: previously
 * visited screens stay mounted but hidden (`display: none`, effects cleaned
 * up, state preserved). Return visits are instant: Activity reveals the
 * preserved DOM and re-creates effects without remounting 800+ components.
 *
 * `useDeferredValue` wraps the derived PreviewScreen so first-visit
 * mounts are concurrent. When the URL changes, React schedules a deferred
 * re-render at lower priority for the Activity mode flip: the old screen
 * stays visible while the new screen prepares in the background. Return
 * visits (Activity reveal of an already-mounted tree) are near-instant.
 *
 * ## Location→PreviewScreen adapter
 *
 * The interact-mode preview pipeline uses stable blueprint UUIDs. This
 * boundary validates URL identities against the document before turning a
 * `Location` into a `PreviewScreen`.
 *
 * ## Screen identity ownership
 *
 * PreviewShell owns the "last screen of each type" state via refs. Each
 * screen component receives its coordinates (moduleUuid / formUuid /
 * caseId) as props rather than reading the global screen.
 *
 * This matches Activity's semantics: when Activity hides FormScreen, the
 * current screen has moved on (e.g., to "module"), but FormScreen's own
 * identity hasn't changed: it's still form X in module Y. Passing that
 * identity as a prop keeps FormScreen's component tree rendering correctly
 * while hidden.
 */
"use client";
import dynamic from "next/dynamic";
import { Activity, useDeferredValue, useEffect, useMemo, useRef } from "react";
import type { CaseListWorkspaceTab } from "@/components/builder/case-list-config/CaseListWorkspaceProvider";
import type { DisplayConditionTarget } from "@/components/builder/conditions/useDisplayConditionCarrier";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { Button } from "@/components/shadcn/button";
import { PortaledContentDirectionProvider } from "@/components/shadcn/portaled-content-direction";
import { Spinner } from "@/components/shadcn/spinner";
import type { Uuid } from "@/lib/doc/types";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { type PreviewScreen, screenKey } from "@/lib/preview/engine/types";
import { useEntryPointLaunchLifecycle } from "@/lib/preview/hooks/useEntryPointLaunch";
import { usePreviewScreenForLocation } from "@/lib/preview/hooks/usePreviewScreenForLocation";
import { useSelectedPreviewIdentityState } from "@/lib/preview/hooks/useSelectedPreviewIdentity";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { previewCaseTargetBindsLocation } from "@/lib/routing/previewBreadcrumbs";
import type { AppSetupSection } from "@/lib/routing/types";
import {
	useEditMode,
	usePreviewCaseTarget,
	usePreviewParentCaseRequest,
	useProjectScopeEpoch,
	useSetPreviewing,
	useSetPreviewParentCaseRequest,
	useSetPreviewPersonaUuid,
} from "@/lib/session/hooks";
import { HomeScreen } from "./screens/HomeScreen";

function BuilderSurfaceLoading() {
	return (
		<div
			className="flex min-h-48 items-center justify-center text-nova-text-muted"
			role="status"
			aria-label="Opening this workspace"
		>
			<Spinner className="size-5" />
		</div>
	);
}

const FormScreen = dynamic(
	() => import("./screens/FormScreen").then((module) => module.FormScreen),
	{ loading: BuilderSurfaceLoading },
);
const ModuleScreen = dynamic(
	() => import("./screens/ModuleScreen").then((module) => module.ModuleScreen),
	{ loading: BuilderSurfaceLoading },
);

/* These screens are mutually exclusive route destinations. Keeping them out
 * of the Builder's initial graph lets the common home/module/form shell become
 * interactive before uncommon configuration and running-case-list code is
 * fetched and parsed. Once visited, the Activity boundary below retains each
 * loaded surface exactly as before. */
const AppSetupWorkspace = dynamic(
	() =>
		import("@/components/builder/app-setup/AppSetupWorkspace").then(
			(module) => module.AppSetupWorkspace,
		),
	{ loading: BuilderSurfaceLoading },
);
const CaseOperationDetailCanvas = dynamic(
	() =>
		import(
			"@/components/builder/case-operations/CaseOperationDetailCanvas"
		).then((module) => module.CaseOperationDetailCanvas),
	{ loading: BuilderSurfaceLoading },
);
const CaseOperationsCanvas = dynamic(
	() =>
		import("@/components/builder/case-operations/CaseOperationsCanvas").then(
			(module) => module.CaseOperationsCanvas,
		),
	{ loading: BuilderSurfaceLoading },
);
const DisplayConditionCanvas = dynamic(
	() =>
		import("@/components/builder/conditions/DisplayConditionCanvas").then(
			(module) => module.DisplayConditionCanvas,
		),
	{ loading: BuilderSurfaceLoading },
);
const DataReviewScreen = dynamic(
	() =>
		import("@/components/builder/data-review/DataReviewScreen").then(
			(module) => module.DataReviewScreen,
		),
	{ loading: BuilderSurfaceLoading },
);
const FormLinkDetailCanvas = dynamic(
	() =>
		import("@/components/builder/form-links/FormLinkDetailCanvas").then(
			(module) => module.FormLinkDetailCanvas,
		),
	{ loading: BuilderSurfaceLoading },
);
const FormLinksCanvas = dynamic(
	() =>
		import("@/components/builder/form-links/FormLinksCanvas").then(
			(module) => module.FormLinksCanvas,
		),
	{ loading: BuilderSurfaceLoading },
);
const ProjectDataWorkspace = dynamic(
	() =>
		import("@/components/builder/project-data/ProjectDataWorkspace").then(
			(module) => module.ProjectDataWorkspace,
		),
	{ loading: BuilderSurfaceLoading },
);
const CaseListWorkspaceCanvas = dynamic(
	() =>
		import(
			"@/components/builder/case-list-config/CaseListConfigWorkspace"
		).then((module) => module.CaseListWorkspaceCanvas),
	{ loading: BuilderSurfaceLoading },
);
const CaseListScreen = dynamic(
	() =>
		import("./screens/CaseListScreen").then((module) => module.CaseListScreen),
	{ loading: BuilderSurfaceLoading },
);

export function PreviewShell() {
	useEntryPointLaunchLifecycle();
	const { direction } = useBuilderLanguage();
	/* ── Location → PreviewScreen adapter ─────────────────────────────
	 * Read the URL location and translate to the legacy index-based screen
	 * shape so the Activity boundaries and interact-mode pipeline keep working. */
	const loc = useLocation();
	const navigate = useNavigate();
	const scopeEpoch = useProjectScopeEpoch();
	const previousScopeEpochRef = useRef(scopeEpoch);
	const mode = useEditMode();
	const previewCaseTarget = usePreviewCaseTarget();
	const previewParentCaseRequest = usePreviewParentCaseRequest();
	const setPreviewParentCaseRequest = useSetPreviewParentCaseRequest();
	const identityState = useSelectedPreviewIdentityState();
	const atCaseRecord = loc.kind === "cases" && loc.caseId !== undefined;
	const projectedScreen = usePreviewScreenForLocation(loc);

	/* Every intermediate selector URL is replace-driven. Browser Back therefore
	 * means "leave this selection flow", not "re-open the selector". Clear the
	 * ephemeral request on popstate, and also heal a request whose URL no longer
	 * names its active selector (for example after a breadcrumb or tree jump). */
	useEffect(() => {
		if (previewParentCaseRequest === undefined) return;
		const cancelOnBrowserHistory = () => setPreviewParentCaseRequest(undefined);
		window.addEventListener("popstate", cancelOnBrowserHistory);
		return () => window.removeEventListener("popstate", cancelOnBrowserHistory);
	}, [previewParentCaseRequest, setPreviewParentCaseRequest]);
	useEffect(() => {
		if (previewParentCaseRequest === undefined) return;
		const atActiveSelector =
			(loc.kind === "module" || loc.kind === "cases") &&
			loc.moduleUuid === previewParentCaseRequest.selectingModuleUuid;
		if (!atActiveSelector) setPreviewParentCaseRequest(undefined);
	}, [loc, previewParentCaseRequest, setPreviewParentCaseRequest]);

	const handleBack = navigate.back;

	/* The case the running-app case list passed into a case-loading form.
	 * The URL tracks which form; this ephemeral target carries the selected
	 * cases (running-app state, like the search inputs and filter, it never
	 * goes in the URL). We graft its ordered collection onto the form screen when
	 * it names the form we're showing, so `FormScreen` preloads the case. */
	/* The screen AND "is this a condition-authoring URL" both derive from
	 * the location, so they must travel together through the deferred
	 * value. Splitting them would let one flip a render before the other:
	 * leaving a module's condition would briefly satisfy
	 * `screen.type === "home"` with authoring already off, flashing the
	 * running home screen on the way to the module screen. */
	const zustandView = useMemo(() => {
		const screen = projectedScreen;
		const atCondition =
			loc.kind === "module-condition" || loc.kind === "form-condition";
		/* A form's case-operations URL maps onto its RUNNING form screen:
		 * Preview from a configuration URL runs the thing it configures, so
		 * the URL, not the screen, is what says "authoring" rather than
		 * "running". Same shape as `atCondition`, and it travels through the
		 * same deferred value so one can never flip a render before the
		 * other. */
		const atOperations = loc.kind === "form-operations";
		/* And the after-submit links URL, for the same reason. */
		const atLinks = loc.kind === "form-links";
		/* Graft the bound case onto the form ONLY when the target binds THIS
		 * form: `previewCaseTargetBindsLocation` is the same predicate the
		 * breadcrumb gates its case crumb on, so the loaded case and the named
		 * case can never disagree (a target carried over from another form is
		 * ignored, so e.g. a register form loads no case). */
		if (
			screen.type === "form" &&
			previewCaseTarget?.cases !== undefined &&
			previewCaseTargetBindsLocation(loc, previewCaseTarget)
		) {
			return {
				screen: { ...screen, cases: previewCaseTarget.cases },
				atCondition,
				atOperations,
				atLinks,
			};
		}
		return { screen, atCondition, atOperations, atLinks };
	}, [loc, previewCaseTarget, projectedScreen]);
	const zustandScreen: PreviewScreen = zustandView.screen;

	/* ── Concurrent screen transition ──────────────────────────────────
	 * `zustandScreen` updates immediately on URL change. `screen` is the
	 * deferred value: React schedules the Activity mode flip at lower
	 * priority, keeping the old screen visible while the new screen mounts
	 * in the background. Return visits are near-instant. */
	const view = useDeferredValue(zustandView);
	const screen = view.screen;

	const setPreviewPersonaUuid = useSetPreviewPersonaUuid();
	/* `/cases/{caseId}` is the running record deep link, not the Results
	 * authoring tab. It must remain a record screen after a reload even though
	 * preview mode itself is ephemeral session state. */
	const setPreviewing = useSetPreviewing();
	useEffect(() => {
		if (atCaseRecord && mode !== "preview") setPreviewing(true);
	}, [atCaseRecord, mode, setPreviewing]);
	useEffect(() => {
		if (previousScopeEpochRef.current === scopeEpoch) return;
		previousScopeEpochRef.current = scopeEpoch;
		/* A case id is Project-scoped navigation state. A same-app Project
		 * move must return to Results rather than trying that source id in the
		 * destination Project. The row hook is epoch-keyed as well, so the
		 * render before this effect already shows loading rather than old data. */
		if (loc.kind === "cases" && loc.caseId !== undefined) {
			navigate.replace({ kind: "cases", moduleUuid: loc.moduleUuid });
		}
	}, [loc, navigate, scopeEpoch]);

	/* ── Per-type screen identity ──────────────────────────────────────
	 * Track the last screen data for each type so Activity boundaries can
	 * be mounted before the screen has ever been visited, and screen
	 * components can receive their coordinates as props rather than
	 * reading the (possibly-changed) global screen from the store.
	 *
	 * Ref mutation during render is safe here: writes are idempotent per
	 * render (the same zustandScreen produces the same ref contents), and
	 * React's concurrent mode tolerates this pattern for externally-sourced
	 * state. Uses `zustandScreen` (the immediate value), not `screen` (the
	 * deferred value), so boundaries are created eagerly on navigation:
	 * the deferred value then controls when they become visible. */
	const moduleScreenRef =
		useRef<Extract<PreviewScreen, { type: "module" }>>(undefined);
	const caseListScreenRef =
		useRef<Extract<PreviewScreen, { type: "caseList" }>>(undefined);
	const formScreenRef =
		useRef<Extract<PreviewScreen, { type: "form" }>>(undefined);
	/** The most-recent moduleUuid + tab that landed on any of the
	 *  three case-list workspace URLs (`results` / `search` / `details`).
	 *  Tracked separately from `caseListScreenRef`
	 *  because the workspace mounts on an edit-mode URL location (uuid-shaped)
	 *  while the running `CaseListScreen` mounts on the UUID-based
	 *  `PreviewScreen` shape. The ref stays populated once any case-list
	 *  authoring screen has been visited, so the workspace's Activity
	 *  boundary survives subsequent navigation away and back. */
	const caseListWorkspaceRef = useRef<{
		moduleUuid: Uuid;
		tab: CaseListWorkspaceTab;
	}>(undefined);
	if (loc.kind === "cases" && mode === "edit" && !atCaseRecord) {
		caseListWorkspaceRef.current = { moduleUuid: loc.moduleUuid, tab: "list" };
	} else if (loc.kind === "search-config" && mode === "edit") {
		caseListWorkspaceRef.current = {
			moduleUuid: loc.moduleUuid,
			tab: "search",
		};
	} else if (loc.kind === "detail-config" && mode === "edit") {
		caseListWorkspaceRef.current = {
			moduleUuid: loc.moduleUuid,
			tab: "detail",
		};
	}
	/** The data review screen's identity: uuid-shaped like the workspace ref
	 * above, for the same reason. Builder-only refs are first populated while
	 * editing so a direct Preview load never fetches hidden authoring code. */
	const dataReviewRef = useRef<{ moduleUuid: Uuid }>(undefined);
	if (loc.kind === "data-review" && mode === "edit") {
		dataReviewRef.current = { moduleUuid: loc.moduleUuid };
	}
	/** The display-condition editor's identity. Also uuid-shaped, and
	 *  gated on the immediate edit-mode `loc` rather than the deferred `screen`
	 *  for the same
	 *  reason `atCaseRecord` is: the condition URLs map onto the RUNNING
	 *  module/form screens, so the URL is what distinguishes "authoring
	 *  the condition" from "running the thing it governs". */
	const displayConditionRef = useRef<DisplayConditionTarget>(undefined);
	if (loc.kind === "module-condition" && mode === "edit") {
		displayConditionRef.current = {
			kind: "module",
			moduleUuid: loc.moduleUuid,
		};
	} else if (loc.kind === "form-condition" && mode === "edit") {
		displayConditionRef.current = {
			kind: "form",
			moduleUuid: loc.moduleUuid,
			formUuid: loc.formUuid,
		};
	}
	/** The App setup workspace's identity: uuid-free, since it names no
	 *  blueprint entity. Same visited-ref shape as the two refs above so the
	 *  boundary survives navigating away and back. */
	const appSetupRef = useRef<{ section: AppSetupSection }>(undefined);
	if (loc.kind === "app-setup" && mode === "edit") {
		appSetupRef.current = { section: loc.section };
	}
	/** The Project data workspace's identity: uuid-free for a stronger
	 *  reason: a lookup table id is Project state, not a blueprint entity.
	 *  Same visited-ref shape, so the boundary survives navigating away and
	 *  back with the open table intact. */
	const projectDataRef = useRef<{ tableId?: LookupTableId }>(undefined);
	if (loc.kind === "project-data" && mode === "edit") {
		projectDataRef.current = { tableId: loc.tableId };
	}
	/** The case-operations screen's identity: the form, plus which change
	 *  is selected. Held in a ref for the same reason the two above are:
	 *  the boundary must survive navigating away and back, and carrying
	 *  the selection so the detail canvas keeps showing its change while
	 *  hidden. */
	const caseOperationsRef = useRef<{
		moduleUuid: Uuid;
		formUuid: Uuid;
		operationUuid: Uuid | undefined;
	}>(undefined);
	if (loc.kind === "form-operations" && mode === "edit") {
		caseOperationsRef.current = {
			moduleUuid: loc.moduleUuid,
			formUuid: loc.formUuid,
			operationUuid: loc.operationUuid,
		};
	}
	/** The after-submit screen's identity: the form, plus which link is
	 *  selected. Same shape and same reasons as the case-operations ref. */
	const formLinksRef = useRef<{
		moduleUuid: Uuid;
		formUuid: Uuid;
		linkUuid: Uuid | undefined;
	}>(undefined);
	if (loc.kind === "form-links" && mode === "edit") {
		formLinksRef.current = {
			moduleUuid: loc.moduleUuid,
			formUuid: loc.formUuid,
			linkUuid: loc.linkUuid,
		};
	}
	/* `mode` stays immediate: the Preview toggle must never lag, while
	 * the location half rides the deferred pair above. */
	const editingDisplayCondition = mode === "edit" && view.atCondition;
	const editingCaseOperations = mode === "edit" && view.atOperations;
	const editingFormLinks = mode === "edit" && view.atLinks;
	/** Any centre-canvas form-configuration surface is up, so every
	 *  running screen hides. They are mutually exclusive (one URL kind). */
	const editingFormConfig =
		editingDisplayCondition || editingCaseOperations || editingFormLinks;
	/** Whether the home screen has been visited at least once. Home carries
	 *  no per-screen identity, so a boolean flag suffices. */
	const homeVisitedRef = useRef(false);

	switch (zustandScreen.type) {
		case "home":
			homeVisitedRef.current = true;
			break;
		case "projectData":
			/* No preview-pipeline identity to synthesize: Project data has no
			 * running-app counterpart, and Preview navigates away from it rather
			 * than rendering one (see `usePreviewModeTransition`). */
			break;
		case "module":
			moduleScreenRef.current = zustandScreen;
			break;
		case "caseList":
			caseListScreenRef.current = zustandScreen;
			break;
		case "searchConfig":
		case "detailConfig":
		case "dataReview":
			/* In preview mode these case-workspace URLs render the same
			 * running-app `CaseListScreen` (the composed search +
			 * list experience), so the sibling kinds synthesize the
			 * UUID-based caseList identity. */
			caseListScreenRef.current = {
				type: "caseList",
				moduleUuid: zustandScreen.moduleUuid,
			};
			break;
		case "appSetup":
			/* No preview-pipeline identity to synthesize: App setup has no
			 * running-app counterpart, and Preview navigates away from it
			 * rather than rendering one (see `usePreviewModeTransition`). */
			break;
		case "form":
			formScreenRef.current = zustandScreen;
			break;
	}

	/* ── Per-screen scroll position save/restore ───────────────────────
	 * All Activity-wrapped screens share a single scroll container. Save
	 * the scroll position when leaving a screen and restore it on return
	 * so navigating back to a scrolled form doesn't land at the top.
	 *
	 * Keyed by `screenKey()` (encodes type + UUIDs) rather than just
	 * `screen.type`: otherwise navigating Form A → Module → Form B would
	 * incorrectly restore Form A's scroll position for Form B. */
	const scrollPositions = useRef(new Map<string, number>());
	const scrollContainerRef = useRef<HTMLElement>(null);
	const prevScreenKeyRef = useRef(screenKey(screen));

	useEffect(() => {
		const container = scrollContainerRef.current;
		if (!container) return;

		const currentKey = screenKey(screen);
		if (prevScreenKeyRef.current !== currentKey) {
			/* Save position of the screen we're leaving */
			scrollPositions.current.set(
				prevScreenKeyRef.current,
				container.scrollTop,
			);
			/* Restore position of the screen we're entering */
			container.scrollTop = scrollPositions.current.get(currentKey) ?? 0;
			prevScreenKeyRef.current = currentKey;
		}
	}, [screen]);

	if (mode === "preview" && identityState.kind === "persona-unavailable") {
		return (
			<div className="preview-theme h-full flex flex-col">
				<main
					ref={scrollContainerRef}
					data-preview-scroll-container
					className="flex flex-1 items-center justify-center overflow-y-auto bg-pv-bg px-6 py-10"
				>
					<div
						role="alert"
						className="flex max-w-md flex-col items-start gap-4 rounded-2xl border border-pv-input-border bg-pv-surface p-6 shadow-sm"
					>
						<div className="space-y-2">
							<h2 className="text-lg font-semibold text-foreground">
								Choose who is previewing
							</h2>
							<p className="text-sm leading-relaxed text-muted-foreground">
								The persona you selected is no longer in this app. Preview is
								paused so it cannot quietly switch to a different worker.
							</p>
						</div>
						<Button
							type="button"
							onClick={() => setPreviewPersonaUuid(undefined)}
							className=""
						>
							Preview as me
						</Button>
					</div>
				</main>
			</div>
		);
	}

	return (
		<div
			className={`preview-theme ${mode === "edit" ? "design-theme" : ""} h-full flex flex-col`}
		>
			{/* No header here: wayfinding (back/up + breadcrumb trail) is the
			 *  builder's own `BreadcrumbStrip`, mounted above the canvas column,
			 *  so the trail has a single source of truth. */}
			<main
				ref={scrollContainerRef}
				data-preview-scroll-container
				className="flex-1 overflow-y-auto overflow-x-hidden bg-pv-bg [overflow-anchor:none]"
			>
				{/* Each screen is wrapped in an Activity boundary that preserves
				 *  the component tree when hidden. Boundaries are only rendered
				 *  for screen types that have been visited (the ref is populated).
				 *  Activity `mode` uses the deferred `screen` value so the old
				 *  screen stays visible while the new screen mounts concurrently.
				 *  Screen components receive their identity as props: they never
				 *  read the global current screen, so Activity can hide them
				 *  without destroying their subtree. */}
				{homeVisitedRef.current && (
					<Activity
						mode={
							screen.type === "home" && !editingFormConfig
								? "visible"
								: "hidden"
						}
						name="HomeScreen"
					>
						<PortaledContentDirectionProvider direction={direction}>
							<div dir={direction} className="contents">
								<HomeScreen />
							</div>
						</PortaledContentDirectionProvider>
					</Activity>
				)}
				{moduleScreenRef.current && (
					<Activity
						mode={
							screen.type === "module" && !editingFormConfig
								? "visible"
								: "hidden"
						}
						name="ModuleScreen"
					>
						<PortaledContentDirectionProvider direction={direction}>
							<div dir={direction} className="contents">
								<ModuleScreen
									key={screenKey(moduleScreenRef.current)}
									screen={moduleScreenRef.current}
								/>
							</div>
						</PortaledContentDirectionProvider>
					</Activity>
				)}
				{projectDataRef.current && (
					<Activity
						mode={
							screen.type === "projectData" && mode === "edit"
								? "visible"
								: "hidden"
						}
						name="ProjectDataWorkspace"
					>
						<ProjectDataWorkspace tableId={projectDataRef.current.tableId} />
					</Activity>
				)}
				{/*
				 * Two parallel Activity boundaries cover the three case-list
				 * workspace URLs (`results` / `search` / `details`).
				 *
				 *   - Edit mode: the unified CaseListConfigWorkspace:
				 *     focused Search / Results / Details canvases whose selected
				 *     entity opens in the right-rail inspector. The tab IS the
				 *     URL kind. The
				 *     workspace is a builder surface, not a preview-pipeline
				 *     screen, so it bypasses the legacy `locationToScreen`
				 *     adapter and reads its identity from the URL-tracked
				 *     ref directly.
				 *
				 *   - Otherwise: the CaseListScreen running-app preview:
				 *     the composed search + list experience over
				 *     real case data. All three URLs share it: search and
				 *     detail are facets of the same case list, so interact
				 *     mode always shows the assembled artifact.
				 *
				 * Both boundaries stay mounted once visited (the visited
				 * refs gate the JSX), so toggling between edit and live
				 * mode preserves each surface's internal state including
				 * scroll position. Activity hides one and reveals the
				 * other in a single render pass.
				 */}
				{caseListWorkspaceRef.current && (
					<Activity
						mode={
							(screen.type === "caseList" ||
								screen.type === "searchConfig" ||
								screen.type === "detailConfig") &&
							mode === "edit" &&
							!atCaseRecord &&
							!editingFormConfig
								? "visible"
								: "hidden"
						}
						name="CaseListConfigWorkspace"
					>
						<CaseListWorkspaceCanvas />
					</Activity>
				)}
				{dataReviewRef.current && (
					<Activity
						mode={
							screen.type === "dataReview" &&
							mode === "edit" &&
							!editingFormConfig
								? "visible"
								: "hidden"
						}
						name="DataReviewScreen"
					>
						<DataReviewScreen moduleUuid={dataReviewRef.current.moduleUuid} />
					</Activity>
				)}
				{appSetupRef.current && (
					<Activity
						mode={
							screen.type === "appSetup" && mode === "edit"
								? "visible"
								: "hidden"
						}
						name="AppSetupWorkspace"
					>
						<AppSetupWorkspace section={appSetupRef.current.section} />
					</Activity>
				)}
				{caseListScreenRef.current && (
					<Activity
						mode={
							(screen.type === "caseList" ||
								screen.type === "searchConfig" ||
								screen.type === "detailConfig" ||
								screen.type === "dataReview") &&
							(mode !== "edit" || atCaseRecord)
								? "visible"
								: "hidden"
						}
						name="CaseListScreen"
					>
						<PortaledContentDirectionProvider direction={direction}>
							<div dir={direction} className="contents">
								<CaseListScreen
									key={screenKey(caseListScreenRef.current)}
									screen={caseListScreenRef.current}
								/>
							</div>
						</PortaledContentDirectionProvider>
					</Activity>
				)}
				{formScreenRef.current && (
					<Activity
						mode={
							screen.type === "form" && !editingFormConfig
								? "visible"
								: "hidden"
						}
						name="FormScreen"
					>
						<PortaledContentDirectionProvider direction={direction}>
							<div dir={direction} className="contents">
								<FormScreen
									key={screenKey(formScreenRef.current)}
									screen={formScreenRef.current}
									onBack={handleBack}
								/>
							</div>
						</PortaledContentDirectionProvider>
					</Activity>
				)}
				{caseOperationsRef.current && (
					<Activity
						mode={editingCaseOperations ? "visible" : "hidden"}
						name="CaseOperationsCanvas"
					>
						{/* The list and one change's detail are two screens on one
						 *  URL, and the selection is what distinguishes them. Keying
						 *  the detail by its uuid re-announces the heading and drops
						 *  the previous change's open pickers when the author walks
						 *  Previous / Next through a long sequence. */}
						{caseOperationsRef.current.operationUuid === undefined ? (
							// Keyed by the owning form for the same reason the detail
							// is keyed by its operation: the list holds a refusal
							// alert in local state, and without a key React reuses the
							// instance across forms, rendering one form's refusal over
							// another form's changes.
							<CaseOperationsCanvas
								key={caseOperationsRef.current.formUuid}
								moduleUuid={caseOperationsRef.current.moduleUuid}
								formUuid={caseOperationsRef.current.formUuid}
							/>
						) : (
							<CaseOperationDetailCanvas
								key={caseOperationsRef.current.operationUuid}
								moduleUuid={caseOperationsRef.current.moduleUuid}
								formUuid={caseOperationsRef.current.formUuid}
								operationUuid={caseOperationsRef.current.operationUuid}
							/>
						)}
					</Activity>
				)}
				{formLinksRef.current && (
					<Activity
						mode={editingFormLinks ? "visible" : "hidden"}
						name="FormLinksCanvas"
					>
						{/* The list and one link's detail are two screens on one URL,
						 *  keyed the same way the case-operations pair is: the list
						 *  holds a refusal alert per form, the detail per link. */}
						{formLinksRef.current.linkUuid === undefined ? (
							<FormLinksCanvas
								key={formLinksRef.current.formUuid}
								moduleUuid={formLinksRef.current.moduleUuid}
								formUuid={formLinksRef.current.formUuid}
							/>
						) : (
							<FormLinkDetailCanvas
								key={formLinksRef.current.linkUuid}
								moduleUuid={formLinksRef.current.moduleUuid}
								formUuid={formLinksRef.current.formUuid}
								linkUuid={formLinksRef.current.linkUuid}
							/>
						)}
					</Activity>
				)}
				{displayConditionRef.current && (
					<Activity
						mode={editingDisplayCondition ? "visible" : "hidden"}
						name="DisplayConditionCanvas"
					>
						{/* Keyed by the item: one canvas serves both condition URLs,
						 *  and module → form changes the evaluation scope, the copy,
						 *  and the rule being edited. A fresh mount re-announces the
						 *  heading and drops the previous rule's open pickers. */}
						<DisplayConditionCanvas
							key={
								displayConditionRef.current.kind === "module"
									? displayConditionRef.current.moduleUuid
									: displayConditionRef.current.formUuid
							}
							target={displayConditionRef.current}
						/>
					</Activity>
				)}
			</main>
		</div>
	);
}
