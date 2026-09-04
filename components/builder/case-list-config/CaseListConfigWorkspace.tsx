// components/builder/case-list-config/CaseListConfigWorkspace.tsx
//
// The unified case-list authoring workspace: three focused config tabs
// (Search / Results / Details). Each canvas is a direct composition surface:
// drag the visible rows where workers will see them, add information
// in place, and compose the default case ordering as a readable sentence.
// Selecting one item opens its data source and formatting in the right rail.
// The tab IS the URL (`/search`, `/results`, `/details`), so tab switches are ordinary
// history navigation and deep links land on the right canvas. The
// run-through lives behind the chrome's global Preview toggle:
// this surface carries no preview affordance of its own.
//
// Selection is workspace-local state (case-list entities have no
// standalone URLs the way fields do), keyed by module so navigating
// to a different module's case list never carries a stale selection.
// The inspector mounts via `InspectorSurface`, which claims the right
// rail and releases it automatically when this screen hides (Activity
// destroys effects) or the selection clears (Esc, the rail's close
// affordances, tab switches).
//
// Content edits flow through the doc store's gated mutations. Search-surface
// birth/death and filter-only shutdown use granular semantic batches so a
// stale autosave cannot overwrite a peer's newer search settings.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerEyeOff from "@iconify-icons/tabler/eye-off";
import tablerId from "@iconify-icons/tabler/id";
import tablerListDetails from "@iconify-icons/tabler/list-details";
import tablerSearch from "@iconify-icons/tabler/search";
import dynamic from "next/dynamic";
import {
	Activity,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { ModuleSettingsButton } from "@/components/builder/detail/moduleSettings/ModuleSettingsButton";
import { RemoveRow } from "@/components/builder/inspector/inspectorChrome";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import {
	columnSnapshotBatchMutations,
	columnSnapshotMutations,
} from "@/lib/doc/caseListColumnMutations";
import {
	cleanupCaseSearchAfterFinalInputMutation,
	enableCaseSearchMutation,
	setOwnerOnlyCaseSearchMutation,
} from "@/lib/doc/caseSearchConfigMutations";
import {
	caseSearchConfigPatchMutations,
	clearCaseSearchConfigSettingsMutations,
} from "@/lib/doc/caseSearchConfigPatchMutations";
import {
	type CaseSelectionTransition,
	type CaseSelectionTransitionBlocker,
	planCaseSelectionTransition,
} from "@/lib/doc/caseSelectionMutations";
import { deepEqual } from "@/lib/doc/deepEqual";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	type StructuredCommitFinding,
	useBlueprintMutations,
} from "@/lib/doc/hooks/useBlueprintMutations";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useCaseWorkspaceBoundaryVerdicts } from "@/lib/doc/hooks/useCaseWorkspaceVerdicts";
import { useModule } from "@/lib/doc/hooks/useEntity";
import {
	useIsBareCaseListModule,
	useIsCaseFirstModule,
} from "@/lib/doc/hooks/useModuleIds";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import { useUserProperties } from "@/lib/doc/hooks/useUserCollections";
import { searchInputUpdateMutation } from "@/lib/doc/searchInputMutations";
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import {
	type CaseListConfig,
	type CaseProperty,
	type CaseSearchConfig,
	type CaseSelection,
	type CaseTileGrouping,
	type Column,
	caseSearchConfigAfterFinalInputRemoval,
	DEFAULT_CASE_SEARCH_TITLE,
	effectiveCaseSearchConfig,
	emptyCaseListConfig,
	type Field,
	humanizeId,
	isCaptureField,
	isOwnerOnlyCaseSearchConfig,
	type OrdinaryCaseSearchConfig,
	type SearchInputDef,
	type TileCell,
	uuidSchema,
} from "@/lib/domain";
import {
	effectiveFilterForEmission,
	type Predicate,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { useNavigate } from "@/lib/routing/hooks";
import { useAppId, useCanEdit, usePreviewing } from "@/lib/session/hooks";
import { selectableSegmentCls } from "@/lib/styles";
import { useIsBreakpoint } from "@/lib/ui/hooks/useIsBreakpoint";
import { useKeyboardShortcuts } from "@/lib/ui/hooks/useKeyboardShortcuts";
import {
	type CaseListWorkspaceControllerBridgeProps,
	type CaseListWorkspaceTab,
	type CaseListWorkspaceTarget,
	useCaseListWorkspace,
} from "./CaseListWorkspaceProvider";
import {
	type CaseSelectionAttachmentAnswer,
	type CaseSelectionReviewBlocker,
	CaseSelectionReviewDialog,
	type CaseSelectionStartingAnswer,
} from "./CaseSelectionReviewDialog";
import { ColumnEditor } from "./ColumnEditor";
import {
	CaseListCanvas,
	type CaseListCanvasProps,
} from "./canvas/CaseListCanvas";
import { DetailCanvas } from "./canvas/DetailCanvas";
import { SearchCanvas } from "./canvas/SearchCanvas";
import { SearchConditionCanvas } from "./canvas/SearchConditionCanvas";
import {
	type CaseListConfigErrorAreas,
	caseListConfigVerdicts,
} from "./configValidity";
import { SearchInputEditor } from "./inspector/SearchInputEditor";
import type { SearchPanelInspectorBodyProps } from "./inspector/SearchPanelInspectorBody";
import { withPreservedIdentity } from "./preserveIdentity";
import {
	searchInputConditionAt,
	withSearchInputCondition,
} from "./searchInputConditions";
import {
	type SearchInputRemovalDependency,
	searchInputDependencyUses,
	searchInputFormFieldDependencies,
	searchInputRemovalDependencies,
} from "./searchInputRemovalDependencies";
import { searchInputDecls } from "./searchInputResolution";
import {
	labelFromProperty,
	seedCalculatedColumn,
	seedColumnForProperty,
	seededColumnAddMutation,
	seedHiddenSearchInput,
	seedSearchInputForProperty,
} from "./seeds";
import { TileCellInspector } from "./tile/TileCellInspector";
import type { CaseListArrangement } from "./tile/TileLayoutToggle";
import {
	nextFreeTilePlacement,
	placementForJoiningTile,
	tileMembership,
} from "./tile/tileModel";
import {
	planTileGrouping,
	planTileLayoutDisable,
	planTileLayoutEnable,
	planTilePersistOnForms,
	planTilePlaceField,
	planTilePreset,
	tileCellMutations,
} from "./tile/tileMutationPlan";
import { TILE_PRESETS, type TilePresetId } from "./tile/tilePresets";
import {
	type CaseDisplaySurface,
	projectCaseWorkspaceColumns,
	pruneStoppedSortOrphans,
	removeColumnFromDisplay,
	showColumnOnDisplay,
} from "./workspaceProjection";
import {
	type SearchConditionSlot,
	searchConditionSlotOf,
	type WorkspaceSelection,
} from "./workspaceSelection";

const CASE_SELECTION_REVIEW_REFRESHED =
	"The workflow changed while this review was open. I refreshed the details below for another look before you confirm.";

const SearchPanelInspectorBody = dynamic<SearchPanelInspectorBodyProps>(
	() =>
		import("./inspector/SearchPanelInspectorBody").then(
			(module) => module.SearchPanelInspectorBody,
		),
	{
		loading: () => (
			<div className="py-4 text-sm text-nova-text-muted" role="status">
				Opening search properties
			</div>
		),
	},
);

// ── Public types ──────────────────────────────────────────────────

type SearchInputRemovalReviewSession =
	| {
			readonly phase: "dependencies";
			readonly inputUuid: SearchInputDef["uuid"];
			readonly inputLabel: string;
			readonly token: number;
	  }
	| {
			readonly phase: "target";
			readonly inputUuid: SearchInputDef["uuid"];
			readonly inputLabel: string;
			readonly token: number;
			readonly dependency: SearchInputRemovalDependency;
	  };

interface CaseSelectionReviewSession {
	readonly sourceModuleUuid: Uuid;
	readonly current: CaseSelection | undefined;
	readonly requested: CaseSelection | undefined;
	readonly confirmedModuleUuids: readonly Uuid[];
	readonly transitions: readonly CaseSelectionTransition[];
	readonly startingAnswers: readonly CaseSelectionStartingAnswer[];
	readonly attachmentAnswers: readonly CaseSelectionAttachmentAnswer[];
	readonly blockers: readonly CaseSelectionReviewBlocker[];
	readonly refreshNotice?: string;
}

function fieldsUnder(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	visited = new Set<Uuid>(),
): Field[] {
	const fields: Field[] = [];
	for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
		if (visited.has(fieldUuid)) continue;
		visited.add(fieldUuid);
		const field = doc.fields[fieldUuid];
		if (field === undefined) continue;
		fields.push(field);
		fields.push(...fieldsUnder(doc, fieldUuid, visited));
	}
	return fields;
}

function consequencesForSelection(
	doc: BlueprintDoc,
	transitions: readonly CaseSelectionTransition[],
	projectProse: ReturnType<typeof useProseProjection>,
): {
	readonly startingAnswers: readonly CaseSelectionStartingAnswer[];
	readonly attachmentAnswers: readonly CaseSelectionAttachmentAnswer[];
} {
	const answers: CaseSelectionStartingAnswer[] = [];
	const attachmentAnswers: CaseSelectionAttachmentAnswer[] = [];
	for (const transition of transitions) {
		if (transition.selection?.kind !== "multiple") continue;
		const module = doc.modules[transition.moduleUuid];
		if (module?.caseType === undefined) continue;
		for (const formUuid of doc.formOrder[module.uuid] ?? []) {
			const form = doc.forms[formUuid];
			if (
				form === undefined ||
				(form.type !== "followup" && form.type !== "close")
			) {
				continue;
			}
			for (const field of fieldsUnder(doc, form.uuid)) {
				if (
					!("caseWrite" in field) ||
					field.caseWrite?.caseType !== module.caseType
				) {
					continue;
				}
				const projectedLabel =
					"label" in field && field.label !== undefined
						? projectProse(field.label).trim()
						: "";
				const fieldName = projectedLabel || humanizeId(field.id) || "Question";
				if (isCaptureField(field)) {
					attachmentAnswers.push({
						key: `${form.uuid}:${field.uuid}`,
						fieldName,
						formName: form.name,
						mode: field.caseWrite.mode,
					});
				}
				if (
					(!("default_value" in field) || field.default_value === undefined) &&
					(!("calculate" in field) || field.calculate === undefined)
				) {
					continue;
				}
				answers.push({
					key: `${form.uuid}:${field.uuid}`,
					fieldName,
					formName: form.name,
				});
			}
		}
	}
	return { startingAnswers: answers, attachmentAnswers };
}

const INSPECTOR_RETURN_FOCUS_ATTRIBUTE = "data-inspector-return-focus";

function findCanvasControl(
	root: HTMLElement,
	attribute: string,
	value?: string,
): HTMLElement | null {
	for (const candidate of root.querySelectorAll<HTMLElement>(
		`[${attribute}]`,
	)) {
		if (value === undefined || candidate.getAttribute(attribute) === value) {
			return candidate;
		}
	}
	return null;
}

/** Resolve the stable canvas control that opened a properties selection. The
 * active tab scopes shared column definitions to the row the author actually
 * used; recovery selections that have no row yet fall back to that canvas's
 * Add information control. */
function canvasOriginForSelection(
	selection: WorkspaceSelection,
	activeTab: CaseListWorkspaceTab,
): HTMLElement | null {
	const canvas = document.querySelector<HTMLElement>(
		`[data-case-workspace-scroll-body="${activeTab}"]`,
	);
	if (canvas === null) return null;

	switch (selection.type) {
		case "column": {
			const row = findCanvasControl(
				canvas,
				"data-case-column-select",
				selection.uuid,
			);
			if (row !== null) return row;
			const surface =
				activeTab === "list" || activeTab === "detail" ? activeTab : null;
			return surface === null
				? null
				: canvas.querySelector<HTMLElement>(`[data-case-add="${surface}"]`);
		}
		case "input":
			return (
				findCanvasControl(canvas, "data-case-search-field", selection.uuid) ??
				canvas.querySelector<HTMLElement>("[data-case-add-search-field]")
			);
		case "search-panel":
			return canvas.querySelector<HTMLElement>("[data-case-search-panel]");
		case "search-condition":
			return null;
	}
}

function inspectorOriginSelection(
	selection: WorkspaceSelection,
): WorkspaceSelection {
	if (selection.type !== "search-condition") return selection;
	return selection.target.kind === "input"
		? { type: "input", uuid: selection.target.uuid }
		: { type: "search-panel" };
}

function clearInspectorReturnFocusMarkers(): void {
	for (const previous of document.querySelectorAll<HTMLElement>(
		`[${INSPECTOR_RETURN_FOCUS_ATTRIBUTE}]`,
	)) {
		previous.removeAttribute(INSPECTOR_RETURN_FOCUS_ATTRIBUTE);
	}
}

function markInspectorReturnFocus(target: HTMLElement): void {
	clearInspectorReturnFocusMarkers();
	target.setAttribute(INSPECTOR_RETURN_FOCUS_ATTRIBUTE, "");
}

/**
 * Hover hint surfaced on disabled add affordances whose seed depends
 * on a case-property reference.
 */
const PROPERTYLESS_HINT = "Add case information before adding fields";

/** Stable empty config for modules whose `caseListConfig` slot is
 *  still absent: first edit persists the seeded shape. */
const EMPTY_CONFIG: CaseListConfig = emptyCaseListConfig();

/** Stable empty tile-issue list: a fresh array per render would defeat
 *  the inspector body's memoization. */
const NO_TILE_ISSUES: readonly string[] = [];

/** Stable no-case-type verdicts: a fresh object per render would
 *  defeat the canvases' memoization. */
const EMPTY_VERDICTS = {
	errorAreas: { search: false, list: false, detail: false },
	brokenColumns: new Set<string>(),
	filterBroken: false,
	searchButtonConditionBroken: false,
	excludedOwnerIdsBroken: false,
	tileIssues: new Map<Uuid, readonly string[]>(),
} as const;

type SearchScreenSettingKey = "searchScreenTitle" | "searchScreenSubtitle";

type SearchActionSettingKey =
	| "searchButtonLabel"
	| "searchButtonDisplayCondition";

const SEARCH_SCREEN_SETTING_LABELS: Readonly<
	Record<SearchScreenSettingKey, string>
> = {
	searchScreenTitle: "custom title",
	searchScreenSubtitle: "subtitle",
};

const SEARCH_ACTION_SETTING_LABELS: Readonly<
	Record<SearchActionSettingKey, string>
> = {
	searchButtonLabel: "custom Search action label",
	searchButtonDisplayCondition: "Search availability condition",
};

function authoredSearchScreenSettings(
	config: CaseSearchConfig | undefined,
): readonly string[] {
	if (config === undefined || isOwnerOnlyCaseSearchConfig(config)) return [];
	return (Object.keys(SEARCH_SCREEN_SETTING_LABELS) as SearchScreenSettingKey[])
		.filter((key) => config[key] !== undefined)
		.map((key) => SEARCH_SCREEN_SETTING_LABELS[key]);
}

function authoredSearchActionSettings(
	config: CaseSearchConfig | undefined,
): readonly string[] {
	if (config === undefined || isOwnerOnlyCaseSearchConfig(config)) return [];
	return (Object.keys(SEARCH_ACTION_SETTING_LABELS) as SearchActionSettingKey[])
		.filter((key) => config[key] !== undefined)
		.map((key) => SEARCH_ACTION_SETTING_LABELS[key]);
}

/** The friendly name used when a display field moves on or off a surface. */
function columnDisplayLabel(column: Column): string {
	return (
		column.header ||
		(column.kind === "calculated"
			? "Information"
			: labelFromProperty(column.field) || "Information")
	);
}

function surfaceDisplayName(
	surface: CaseDisplaySurface,
): "Results" | "Details" {
	return surface === "list" ? "Results" : "Details";
}

// ── Controller ────────────────────────────────────────────────────
//
// The workspace controller runs ONCE, mounted above the builder row by
// `CaseListWorkspaceProvider` (wired in `BuilderProvider`). The center canvas
// (`CaseListWorkspaceCanvas`, in the preview shell) and the right-rail inspector
// are two CONSUMERS of this one controller, so the inspector body lives in the
// always-mounted rail and rides it off-screen during a preview flip without
// unmounting (the scroll-survives-for-free guarantee chat and the app tree
// already have). Selection is retained per module across navigation because the
// controller never unmounts; it resets when the module identity changes.

function requireRetainedModuleUuid(moduleUuid: Uuid | undefined): Uuid {
	if (moduleUuid === undefined) {
		throw new Error(
			"Case-list workspace action requires a retained module identity",
		);
	}
	return moduleUuid;
}

function useController(target: CaseListWorkspaceTarget | null) {
	/* Retain the last case-list module + tab so navigating away and back keeps
	 * the selection (this controller never unmounts). Sticky `tab` also keeps the
	 * tab-change deselect below from firing on a mere navigation away. */
	const stickyModuleRef = useRef<Uuid | undefined>(target?.moduleUuid);
	if (target) stickyModuleRef.current = target.moduleUuid;
	const moduleUuid = stickyModuleRef.current;
	const stickyTabRef = useRef<CaseListWorkspaceTab>(target?.tab ?? "list");
	if (target) stickyTabRef.current = target.tab;
	const tab = stickyTabRef.current;

	const mod = useModule(moduleUuid);
	const isBareCaseList = useIsBareCaseListModule(moduleUuid);
	const isCaseFirst = useIsCaseFirstModule(moduleUuid);
	/* The EFFECTIVE view: the same property admission set + types the
	 * commit gate validates against (see the hook doc). */
	const caseTypes = useEffectiveCaseTypes();
	const userProperties = useUserProperties();
	const projectProse = useProseProjection();
	const navigate = useNavigate();
	const docApi = useBlueprintDocApi();
	const { moveColumnOnSurface, moveSearchInputToIndex, commitMany, inline } =
		useBlueprintMutations();
	/* This controller lives ABOVE the preview boundary, so entering preview does
	 * not navigate: `target` stays a case-list URL and the retained selection
	 * survives, invisibly, behind the running app. Gate the Escape shortcut below
	 * on this so it stands down in preview (Escape must exit preview, not clear a
	 * hidden selection). */
	const previewing = usePreviewing();
	const active =
		target !== null && mod !== undefined && mod.caseType !== undefined;

	const caseType = mod?.caseType;
	const config = mod?.caseListConfig ?? EMPTY_CONFIG;
	const searchConfig = mod?.caseSearchConfig;
	const effectiveSearchConfig = mod
		? effectiveCaseSearchConfig(mod)
		: undefined;
	const boundaryVerdicts = useCaseWorkspaceBoundaryVerdicts(moduleUuid);
	const opensResultsAutomatically =
		effectiveSearchConfig !== undefined &&
		config.searchInputs.length === 0 &&
		effectiveFilterForEmission(config.filter) !== undefined;

	// ── Selection ──
	const [sel, setSel] = useState<WorkspaceSelection | null>(null);
	const [workspaceAnnouncement, setWorkspaceAnnouncement] = useState("");
	const pendingCanvasFocusRef = useRef<CaseDisplaySurface | null>(null);
	const pendingSearchFocusRef = useRef<SearchInputDef["uuid"] | "add" | null>(
		null,
	);
	const [inputRemovalReview, setInputRemovalReview] =
		useState<SearchInputRemovalReviewSession | null>(null);
	const [caseSelectionReview, setCaseSelectionReview] =
		useState<CaseSelectionReviewSession | null>(null);
	const caseSelectionOriginRef = useRef<HTMLElement | null>(null);
	const navigatingCaseSelectionReviewRef = useRef(false);
	const inputRemovalReviewTokenRef = useRef(0);
	const searchConditionFocusTokenRef = useRef(0);
	const [
		searchButtonConditionFocusRequest,
		setSearchButtonConditionFocusRequest,
	] = useState<{
		readonly token: number;
		readonly path: readonly [];
		readonly focusTarget: "first-control";
	}>();
	const pendingInspectorFocusRef = useRef<WorkspaceSelection | null>(null);
	const searchOverviewScrollRef = useRef<number | null>(null);
	const pendingSearchOverviewScrollRef = useRef<number | null>(null);
	const searchConditionReturnFrameRef = useRef<number | null>(null);
	/* The controller never unmounts, so a module change must drop ALL of this
	 * module-scoped transient state by hand or it leaks into the next module:
	 * retained selection, an open removal review, pending focus intents, and the
	 * search-overview scroll offsets (a stale offset would jump the next module's
	 * search list to the wrong place). The async-invalidation tokens are
	 * monotonic and deliberately NOT reset. */
	const prevModuleRef = useRef(moduleUuid);
	if (prevModuleRef.current !== moduleUuid) {
		prevModuleRef.current = moduleUuid;
		if (sel !== null) setSel(null);
		if (inputRemovalReview !== null) setInputRemovalReview(null);
		if (caseSelectionReview !== null) setCaseSelectionReview(null);
		if (searchButtonConditionFocusRequest !== undefined) {
			setSearchButtonConditionFocusRequest(undefined);
		}
		if (workspaceAnnouncement !== "") setWorkspaceAnnouncement("");
		pendingCanvasFocusRef.current = null;
		pendingSearchFocusRef.current = null;
		pendingInspectorFocusRef.current = null;
		caseSelectionOriginRef.current = null;
		navigatingCaseSelectionReviewRef.current = false;
		searchOverviewScrollRef.current = null;
		pendingSearchOverviewScrollRef.current = null;
		if (searchConditionReturnFrameRef.current !== null) {
			cancelAnimationFrame(searchConditionReturnFrameRef.current);
			searchConditionReturnFrameRef.current = null;
		}
	}
	const openSearchCondition = useCallback(
		(
			target: Extract<
				WorkspaceSelection,
				{ type: "search-condition" }
			>["target"],
		) => {
			const scroller = document.querySelector<HTMLElement>(
				'[data-case-workspace-scroll-body="search"]',
			);
			if (searchOverviewScrollRef.current === null) {
				searchOverviewScrollRef.current = scroller?.scrollTop ?? 0;
			}
			if (scroller !== null) scroller.scrollTop = 0;
			setSel({ type: "search-condition", target });
		},
		[],
	);
	const leaveSearchCondition = useCallback(
		(next: WorkspaceSelection | null) => {
			const savedScroll = searchOverviewScrollRef.current;
			if (savedScroll !== null) {
				// Restore only after React replaces the shorter condition canvas with
				// the overview. Restoring against the outgoing canvas lets the browser
				// clamp a deep offset and silently loses the author's place.
				pendingSearchOverviewScrollRef.current = savedScroll;
				searchOverviewScrollRef.current = null;
			}
			setSel(next);
		},
		[],
	);
	useEffect(() => {
		if (
			sel?.type === "search-condition" ||
			pendingSearchOverviewScrollRef.current === null
		) {
			return;
		}
		const scrollTop = pendingSearchOverviewScrollRef.current;
		const frame = requestAnimationFrame(() => {
			const scroller = document.querySelector<HTMLElement>(
				'[data-case-workspace-scroll-body="search"]',
			);
			if (scroller === null) return;
			scroller.scrollTop = scrollTop;
			pendingSearchOverviewScrollRef.current = null;
		});
		return () => cancelAnimationFrame(frame);
	}, [sel]);
	const returnFromSearchCondition = useCallback(
		(next: WorkspaceSelection) => {
			leaveSearchCondition(next);
			if (searchConditionReturnFrameRef.current !== null) {
				cancelAnimationFrame(searchConditionReturnFrameRef.current);
			}
			searchConditionReturnFrameRef.current = requestAnimationFrame(() => {
				searchConditionReturnFrameRef.current = null;
				const inspector = document.querySelector<HTMLElement>(
					'[data-builder-secondary-header="inspector"]',
				)?.parentElement;
				inspector
					?.querySelector<HTMLButtonElement>("[data-condition-origin]")
					?.focus();
			});
		},
		[leaveSearchCondition],
	);
	useEffect(
		() => () => {
			if (searchConditionReturnFrameRef.current !== null) {
				cancelAnimationFrame(searchConditionReturnFrameRef.current);
				searchConditionReturnFrameRef.current = null;
			}
		},
		[],
	);
	const deselect = useCallback(
		() => leaveSearchCondition(null),
		[leaveSearchCondition],
	);
	const closeSelectionAndRestoreFocus = useCallback(() => {
		if (sel === null) return;
		const origin = inspectorOriginSelection(sel);
		pendingInspectorFocusRef.current = origin;
		const target = canvasOriginForSelection(origin, tab);
		if (target !== null) markInspectorReturnFocus(target);
		leaveSearchCondition(null);
	}, [leaveSearchCondition, sel, tab]);
	/* Tab switches deselect: covers in-app tab clicks AND browser
	 * back/forward, since both arrive as a `tab` prop change. */
	const prevTabRef = useRef(tab);
	useEffect(() => {
		if (prevTabRef.current === tab) return;
		prevTabRef.current = tab;
		setSearchButtonConditionFocusRequest(undefined);
		leaveSearchCondition(null);
	}, [tab, leaveSearchCondition]);

	/* A dependency review is a short navigation session, not inspector-local
	 * state. Returning from Results must survive the tab transition, restore the
	 * original field, and reopen its freshly recomputed list of uses. */
	useEffect(() => {
		if (tab !== "search" || inputRemovalReview?.phase !== "dependencies") {
			return;
		}
		const inputStillExists = config.searchInputs.some(
			(input) => input.uuid === inputRemovalReview.inputUuid,
		);
		if (!inputStillExists) {
			setInputRemovalReview(null);
			setWorkspaceAnnouncement(
				`${inputRemovalReview.inputLabel} was already removed`,
			);
			return;
		}
		setSel((current) =>
			current?.type === "input" && current.uuid === inputRemovalReview.inputUuid
				? current
				: { type: "input", uuid: inputRemovalReview.inputUuid },
		);
	}, [config.searchInputs, inputRemovalReview, tab]);

	/* If another editor removes the selected condition while this workspace is
	 * open, return to its owning Search settings instead of leaving a blank
	 * center surface. */
	useEffect(() => {
		if (sel?.type !== "search-condition") return;
		if (sel.target.kind === "input") {
			const inputUuid = sel.target.uuid;
			const input = config.searchInputs.find(
				(candidate) => candidate.uuid === inputUuid,
			);
			if (
				input !== undefined &&
				searchInputConditionAt(input, searchConditionSlotOf(sel.target)) !==
					undefined
			) {
				return;
			}
			leaveSearchCondition(
				input === undefined ? null : { type: "input", uuid: input.uuid },
			);
			return;
		}
		if (
			searchConfig === undefined ||
			isOwnerOnlyCaseSearchConfig(searchConfig) ||
			searchConfig.searchButtonDisplayCondition === undefined
		) {
			setSearchButtonConditionFocusRequest(undefined);
			leaveSearchCondition({ type: "search-panel" });
		}
	}, [config.searchInputs, leaveSearchCondition, searchConfig, sel]);

	/* Hiding is initiated from the inspector, so its focused button unmounts.
	 * Return focus to the active canvas's Add information control after React
	 * commits the hidden state, and announce the reversible result. */
	useEffect(() => {
		const surface = pendingCanvasFocusRef.current;
		if (surface === null || sel !== null) return;
		const frame = requestAnimationFrame(() => {
			document
				.querySelector<HTMLButtonElement>(`[data-case-add="${surface}"]`)
				?.focus();
			pendingCanvasFocusRef.current = null;
		});
		return () => cancelAnimationFrame(frame);
	}, [sel]);

	/* Removing a Search field starts in the inspector, so its focused action
	 * disappears with the selection. Hand focus to the next field in display
	 * order, or to Add search field when the screen is now empty. The stable
	 * canvas targets avoid guessing from translated labels or DOM position. */
	useEffect(() => {
		const target = pendingSearchFocusRef.current;
		if (target === null || sel !== null) return;
		const frame = requestAnimationFrame(() => {
			const element =
				target === "add"
					? document.querySelector<HTMLButtonElement>(
							"[data-case-add-search-field]",
						)
					: document.querySelector<HTMLButtonElement>(
							`[data-case-search-field="${target}"]`,
						);
			element?.focus();
			pendingSearchFocusRef.current = null;
		});
		return () => cancelAnimationFrame(frame);
	}, [sel]);

	/* Close and Escape return to the exact canvas control that opened the
	 * properties surface. Desktop can focus it as soon as the selection commit
	 * lands. A narrow modal drawer keeps the marker until Base UI requests its
	 * final focus, because the underlying canvas is inert while the drawer is
	 * still closing. */
	useLayoutEffect(() => {
		const origin = pendingInspectorFocusRef.current;
		if (origin === null || sel !== null) return;
		pendingInspectorFocusRef.current = null;
		const target = canvasOriginForSelection(origin, tab);
		if (target === null) {
			clearInspectorReturnFocusMarkers();
			return;
		}
		markInspectorReturnFocus(target);
		target.focus({ preventScroll: true });
		if (
			target.closest(
				'[data-builder-layout="narrow"], [data-builder-layout="handset"]',
			) === null
		) {
			target.removeAttribute(INSPECTOR_RETURN_FOCUS_ATTRIBUTE);
		}
	}, [sel, tab]);

	/* A later canvas selection supersedes any retained narrow-drawer marker. */
	useEffect(() => {
		if (
			sel !== null &&
			sel.type !== "search-condition" &&
			pendingInspectorFocusRef.current === null
		) {
			clearInspectorReturnFocusMarkers();
		}
	}, [sel]);

	/* Escape closes the inspector. Routed through the shared keyboard
	 * manager (not a raw listener: the manager preventDefaults every
	 * matched key, and later registrations win) so it layers over the
	 * builder-layout shortcuts and stays quiet while an input or
	 * CodeMirror editor has focus. Registered only while something is
	 * selected AND the workspace is actually on-screen (not behind a
	 * preview flip) so a bare Escape reaches the layout-level handler and,
	 * in preview, exits preview instead of clearing a hidden selection. */
	useKeyboardShortcuts(
		"case-list-workspace",
		useMemo(
			() =>
				active && !previewing && sel !== null
					? [{ key: "Escape", handler: closeSelectionAndRestoreFocus }]
					: [],
			[active, previewing, sel, closeSelectionAndRestoreFocus],
		),
	);

	// One whole-config walk answers the tab dots and the findable marks in the
	// active canvas. Real case data belongs to the global Preview; authoring
	// stays focused on composing the screen instead of sampling one arbitrary row.
	const {
		errorAreas,
		brokenColumns,
		filterBroken,
		searchButtonConditionBroken,
		excludedOwnerIdsBroken,
		tileIssues,
	} = useMemo(
		() =>
			caseType !== undefined
				? caseListConfigVerdicts(config, caseTypes, caseType, projectProse, {
						caseSearchEnabled: effectiveSearchConfig !== undefined,
						boundary: boundaryVerdicts,
					})
				: EMPTY_VERDICTS,
		[
			boundaryVerdicts,
			config,
			caseTypes,
			caseType,
			effectiveSearchConfig,
			projectProse,
		],
	);

	// ── Mutators ──

	const updateSearchConfig = useCallback(
		(next: CaseSearchConfig) => {
			// Reaching Search settings is explicit action authoring. Clear the
			// owner-only provenance bit while preserving every real setting.
			const enabled: OrdinaryCaseSearchConfig = isOwnerOnlyCaseSearchConfig(
				next,
			)
				? { excludedOwnerIds: next.excludedOwnerIds }
				: next;
			commitMany(
				caseSearchConfigPatchMutations(
					requireRetainedModuleUuid(moduleUuid),
					searchConfig,
					enabled,
				),
			);
		},
		[commitMany, moduleUuid, searchConfig],
	);
	const updateExcludedOwnerIds = useCallback(
		(next: ValueExpression | undefined) => {
			if (next !== undefined) {
				if (
					searchConfig === undefined ||
					isOwnerOnlyCaseSearchConfig(searchConfig)
				) {
					commitMany([
						setOwnerOnlyCaseSearchMutation(
							requireRetainedModuleUuid(moduleUuid),
							{
								searchActionEnabled: false,
								excludedOwnerIds: next,
							},
						),
					]);
					return;
				}
				commitMany(
					caseSearchConfigPatchMutations(
						requireRetainedModuleUuid(moduleUuid),
						searchConfig,
						{
							...searchConfig,
							excludedOwnerIds: next,
						},
					),
				);
				return;
			}
			if (searchConfig === undefined) return;
			if (isOwnerOnlyCaseSearchConfig(searchConfig)) {
				commitMany(
					clearCaseSearchConfigSettingsMutations(
						requireRetainedModuleUuid(moduleUuid),
						searchConfig,
					),
				);
				return;
			}
			const { excludedOwnerIds: _previous, ...rest } = searchConfig;
			commitMany(
				caseSearchConfigPatchMutations(
					requireRetainedModuleUuid(moduleUuid),
					searchConfig,
					rest,
				),
			);
		},
		[commitMany, moduleUuid, searchConfig],
	);
	const configureSearchAction = useCallback(() => {
		const outcome = commitMany([
			enableCaseSearchMutation(
				requireRetainedModuleUuid(moduleUuid),
				searchConfig,
			),
		]);
		if (outcome.ok) setSel({ type: "search-panel" });
	}, [commitMany, moduleUuid, searchConfig]);
	const editSearchButtonCondition = useCallback(
		(focusNewCondition = false) => {
			if (focusNewCondition) {
				searchConditionFocusTokenRef.current += 1;
				setSearchButtonConditionFocusRequest({
					token: searchConditionFocusTokenRef.current,
					path: [],
					focusTarget: "first-control",
				});
			} else {
				setSearchButtonConditionFocusRequest(undefined);
			}
			openSearchCondition({ kind: "search-button" });
		},
		[openSearchCondition],
	);

	const ct = caseTypes.find((c) => c.name === caseType);
	const addDisabledReason =
		(ct?.properties.length ?? 0) === 0 ? PROPERTYLESS_HINT : undefined;

	/* Joining Results while the case list is a tile means taking a place on
	 * it: an unplaced field the tile shows is a commit-gate rejection, so
	 * every add and reveal carries its placement in the same batch. A SAVED
	 * cell is re-adjudicated rather than trusted: a hidden column leaves the
	 * tile's membership, so its square is free for anything else to take,
	 * and handing that cell back unchecked would refuse the author's own
	 * reveal with an overlap they cannot repair from the panel the refusal
	 * opens. */
	const TILE_FULL_REASON =
		"The tile has no room left. Make a field smaller before adding more information.";
	const tileHasRoom =
		config.tile === undefined ||
		nextFreeTilePlacement(
			tileMembership(config).placed.map((entry) => entry.cell),
		) !== null;
	const addResultsDisabledReason =
		addDisabledReason ?? (tileHasRoom ? undefined : TILE_FULL_REASON);

	/** Give a column the place it needs to join Results, or `null` when the
	 *  tile has no room for it. Returns the column untouched when Results is
	 *  showing rows. */
	const placedForResults = (column: Column): Column | null => {
		if (config.tile === undefined) return column;
		const place = placementForJoiningTile(config, column);
		return place === null ? null : ({ ...column, tile: place } as Column);
	};

	const replaceColumn = (uuid: string, next: Column) => {
		// Carry identity and tile placement forward; display sequence lives in
		// the two config arrays.
		const current = config.columns.find((column) => column.uuid === uuid);
		if (current === undefined) return;
		const replacement = withPreservedIdentity(current, next);
		commitMany(
			columnSnapshotMutations(
				requireRetainedModuleUuid(moduleUuid),
				current,
				replacement,
			),
		);
	};
	const addSeededColumn = (surface: CaseDisplaySurface, seedColumn: Column) => {
		const seed = surface === "list" ? placedForResults(seedColumn) : seedColumn;
		if (seed === null) {
			setWorkspaceAnnouncement(TILE_FULL_REASON);
			return;
		}
		const mutation = seededColumnAddMutation(
			requireRetainedModuleUuid(moduleUuid),
			config,
			surface,
			seed,
		);
		const outcome = commitMany([mutation]);
		if (outcome.ok) {
			setWorkspaceAnnouncement(
				`${columnDisplayLabel(seed)} added to ${surfaceDisplayName(surface)}`,
			);
			setSel({ type: "column", uuid: seed.uuid });
		}
	};
	const addColumn = (surface: CaseDisplaySurface, property: CaseProperty) => {
		// The center-canvas chooser owns the property decision. Creation only
		// turns that explicit choice into a working display definition; it never
		// advances through system properties behind the author's back.
		addSeededColumn(
			surface,
			seedColumnForProperty(
				property,
				projectProse,
				surface === "list"
					? { visibleInDetail: false }
					: { visibleInList: false },
			),
		);
	};
	const addCalculatedColumn = (surface: CaseDisplaySurface) => {
		addSeededColumn(
			surface,
			seedCalculatedColumn(
				surface === "list"
					? { visibleInDetail: false }
					: { visibleInList: false },
			),
		);
	};
	const moveColumn = (
		surface: CaseDisplaySurface,
		uuid: Column["uuid"],
		toIndex: number,
	) =>
		moveColumnOnSurface(
			requireRetainedModuleUuid(moduleUuid),
			uuid,
			surface,
			toIndex,
		);
	const updateColumns = (next: readonly Column[]) => {
		commitMany(
			columnSnapshotBatchMutations(
				requireRetainedModuleUuid(moduleUuid),
				config.columns,
				pruneStoppedSortOrphans(config.columns, next),
			),
		);
	};
	const hideColumnFromSurface = (
		surface: CaseDisplaySurface,
		column: Column,
	) => {
		const visible = projectCaseWorkspaceColumns(config);
		if (surface === "list" && visible.listVisible.length <= 1) return;
		const label = columnDisplayLabel(column);
		const hidden = removeColumnFromDisplay(
			config.columns,
			column.uuid,
			surface,
		).find((candidate) => candidate.uuid === column.uuid);
		if (hidden === undefined) return;
		const outcome = commitMany(
			columnSnapshotMutations(
				requireRetainedModuleUuid(moduleUuid),
				column,
				hidden,
			),
		);
		if (!outcome.ok) return;
		pendingCanvasFocusRef.current = surface;
		setWorkspaceAnnouncement(
			`${label} hidden from ${surfaceDisplayName(surface)}. You can add it again from Add information.`,
		);
		deselect();
	};
	const deleteColumn = (surface: CaseDisplaySurface, column: Column) => {
		const displayedOn = [
			...(column.visibleInList !== false ? ["Results"] : []),
			...(column.visibleInDetail !== false ? ["Details"] : []),
		];
		const outcome = commitMany([
			{
				kind: "removeColumn",
				moduleUuid: requireRetainedModuleUuid(moduleUuid),
				uuid: column.uuid,
			},
		]);
		if (!outcome.ok) return;
		pendingCanvasFocusRef.current = surface;
		setWorkspaceAnnouncement(
			`${columnDisplayLabel(column)} removed${displayedOn.length === 0 ? "" : ` from ${displayedOn.join(" and ")}`}. Saved case data wasn't deleted.`,
		);
		deselect();
	};
	const showColumn = (surface: CaseDisplaySurface, column: Column) => {
		const shown = showColumnOnDisplay(
			config.columns,
			column.uuid,
			surface,
		).find((candidate) => candidate.uuid === column.uuid);
		if (shown === undefined) return;
		const target = surface === "list" ? placedForResults(shown) : shown;
		/* A full tile is stated where the gesture happened; the only fix is
		 * elsewhere on the grid. */
		if (target === null) {
			setWorkspaceAnnouncement(TILE_FULL_REASON);
			return;
		}
		/* The saved definition is already fully valid. The same gate still
		 * adjudicates the visibility/placement batch, so a malformed external
		 * snapshot can never be revealed. */
		const outcome = inline.commitMany(
			columnSnapshotMutations(
				requireRetainedModuleUuid(moduleUuid),
				column,
				target,
			),
		);
		if (!outcome.ok) {
			setWorkspaceAnnouncement(
				`${columnDisplayLabel(column)} could not be added to ${surfaceDisplayName(surface)}`,
			);
			return;
		}
		setWorkspaceAnnouncement(
			`${columnDisplayLabel(column)} added to ${surfaceDisplayName(surface)}`,
		);
		setSel({ type: "column", uuid: column.uuid });
	};

	const replaceInput = (uuid: string, next: SearchInputDef) => {
		// Carry the existing identity; array position already owns display order.
		const current = config.searchInputs.find((input) => input.uuid === uuid);
		if (current === undefined) return;
		commitMany([
			searchInputUpdateMutation(
				requireRetainedModuleUuid(moduleUuid),
				current,
				withPreservedIdentity(current, next),
			),
		]);
	};
	const removeInput = (uuid: SearchInputDef["uuid"]) => {
		const orderedInputs = [...config.searchInputs];
		const removedIndex = orderedInputs.findIndex(
			(input) => input.uuid === uuid,
		);
		const remainingInputs = config.searchInputs.filter((s) => s.uuid !== uuid);
		const orderedRemainingInputs = orderedInputs.filter(
			(input) => input.uuid !== uuid,
		);
		const removesVisibleSearchScreen = remainingInputs.length === 0;
		const hasCasesAvailableCondition =
			effectiveFilterForEmission(config.filter) !== undefined;
		const nextSearchConfig = removesVisibleSearchScreen
			? caseSearchConfigAfterFinalInputRemoval(
					searchConfig,
					hasCasesAvailableCondition,
				)
			: searchConfig;
		const mutations: Mutation[] = [
			{
				kind: "removeSearchInput",
				moduleUuid: requireRetainedModuleUuid(moduleUuid),
				uuid,
			},
		];
		if (removesVisibleSearchScreen && searchConfig !== undefined) {
			mutations.push(
				cleanupCaseSearchAfterFinalInputMutation({
					uuid: requireRetainedModuleUuid(moduleUuid),
					config: searchConfig,
					hasCasesAvailableCondition,
				}),
			);
		}
		const outcome = commitMany(mutations);
		if (!outcome.ok) return;
		setInputRemovalReview(null);

		const nextInput =
			orderedRemainingInputs[
				Math.min(Math.max(removedIndex, 0), orderedRemainingInputs.length - 1)
			];
		pendingSearchFocusRef.current = nextInput?.uuid ?? "add";
		const removedLabel =
			orderedInputs.find((input) => input.uuid === uuid)?.label ||
			"Search field";
		setWorkspaceAnnouncement(
			removesVisibleSearchScreen
				? nextSearchConfig !== undefined &&
					!isOwnerOnlyCaseSearchConfig(nextSearchConfig)
					? "Search screen removed. Cases available, the Search action, and the Results layout are unchanged."
					: nextSearchConfig?.excludedOwnerIds !== undefined
						? "Search screen removed. Assigned cases and the Results layout are unchanged."
						: "Search screen removed. The case list no longer asks for search information."
				: `${removedLabel} removed from Search`,
		);
		deselect();
	};
	const startInputRemovalReview = useCallback((input: SearchInputDef) => {
		inputRemovalReviewTokenRef.current += 1;
		setInputRemovalReview({
			phase: "dependencies",
			inputUuid: input.uuid,
			inputLabel: input.label.trim() || input.name.trim() || "Search field",
			token: inputRemovalReviewTokenRef.current,
		});
	}, []);
	const cancelInputRemovalReview = useCallback(() => {
		setInputRemovalReview(null);
	}, []);
	const completeInputRemovalReview = useCallback((inputLabel: string) => {
		setInputRemovalReview(null);
		setWorkspaceAnnouncement(
			`No rules use ${inputLabel} now. You can remove the field.`,
		);
	}, []);
	const reviewInputRemovalDependency = useCallback(
		(dependency: SearchInputRemovalDependency) => {
			if (inputRemovalReview?.phase !== "dependencies") return;
			inputRemovalReviewTokenRef.current += 1;
			const nextReview: SearchInputRemovalReviewSession = {
				phase: "target",
				inputUuid: inputRemovalReview.inputUuid,
				inputLabel: inputRemovalReview.inputLabel,
				token: inputRemovalReviewTokenRef.current,
				dependency,
			};
			setInputRemovalReview(nextReview);
			setWorkspaceAnnouncement(
				`Reviewing ${dependency.label}. It uses the ${inputRemovalReview.inputLabel} answer.`,
			);
			if (dependency.kind === "search-field-condition") {
				openSearchCondition({
					kind: "input",
					uuid: dependency.inputUuid,
					slot: dependency.slot,
				});
				return;
			}
			if (dependency.kind === "search-field-default") {
				// The starting value lives in the sibling field's inspector on
				// the Search tab (where the review dialog already is).
				setSel({ type: "input", uuid: dependency.inputUuid });
				return;
			}
			if (dependency.kind === "search-button-visibility") {
				openSearchCondition({ kind: "search-button" });
				return;
			}
			if (dependency.kind === "calculated-column") {
				setSel({ type: "column", uuid: dependency.columnUuid });
				return;
			}
			if (dependency.kind === "form-field") {
				/* The field is on another screen; the review ends here and the
				 * person presses Remove again once the field no longer reads the
				 * answer (the dialog recomputes on each open). */
				setInputRemovalReview(null);
				navigate.openForm(
					dependency.moduleUuid,
					dependency.formUuid,
					dependency.fieldUuid,
				);
				return;
			}
			deselect();
			navigate.openCaseList(requireRetainedModuleUuid(moduleUuid));
		},
		[deselect, inputRemovalReview, moduleUuid, navigate, openSearchCondition],
	);
	const returnToInputRemovalReview = useCallback(() => {
		if (inputRemovalReview?.phase !== "target") return;
		/* The config half reads the rendered module, the same snapshot the
		 * dialog's rows come from; the form fields reading the answer live on
		 * other screens, so they come from the document. */
		const remaining =
			searchInputRemovalDependencies(
				config,
				searchConfig,
				inputRemovalReview.inputUuid,
			).length +
			searchInputFormFieldDependencies(
				docApi.getState(),
				requireRetainedModuleUuid(moduleUuid),
				inputRemovalReview.inputUuid,
			).length;
		inputRemovalReviewTokenRef.current += 1;
		setInputRemovalReview({
			phase: "dependencies",
			inputUuid: inputRemovalReview.inputUuid,
			inputLabel: inputRemovalReview.inputLabel,
			token: inputRemovalReviewTokenRef.current,
		});
		setWorkspaceAnnouncement(
			remaining === 0
				? `No rules use ${inputRemovalReview.inputLabel} now. You can remove the field.`
				: `${remaining} ${remaining === 1 ? "rule still uses" : "rules still use"} ${inputRemovalReview.inputLabel}`,
		);
		if (tab === "search") {
			leaveSearchCondition({
				type: "input",
				uuid: inputRemovalReview.inputUuid,
			});
		} else {
			navigate.openSearchConfig(requireRetainedModuleUuid(moduleUuid));
		}
	}, [
		config,
		docApi,
		inputRemovalReview,
		leaveSearchCondition,
		moduleUuid,
		navigate,
		searchConfig,
		tab,
	]);
	const addInput = (property: CaseProperty) => {
		// The canvas owns the meaningful choice. This layer carries it into a
		// working input with a unique internal name, a matching widget, and the
		// established per-type match default.
		const seed = seedSearchInputForProperty(config, property, projectProse);
		const retainedModuleUuid = requireRetainedModuleUuid(moduleUuid);
		const outcome = commitMany([
			enableCaseSearchMutation(retainedModuleUuid, searchConfig),
			{
				kind: "addSearchInput",
				moduleUuid: retainedModuleUuid,
				searchInput: seed,
			},
		]);
		// Never select an identity the gate refused to create. The gate can still
		// reject a concurrent structural edit even though the seed was valid when
		// this interaction began.
		if (outcome.ok) setSel({ type: "input", uuid: seed.uuid });
	};
	const addHiddenInput = () => {
		// A hidden value names no case information, so there is nothing to
		// choose first: the seed is the search time, and the inspector opens on
		// its expression.
		const seed = seedHiddenSearchInput(config);
		const retainedModuleUuid = requireRetainedModuleUuid(moduleUuid);
		const outcome = commitMany([
			enableCaseSearchMutation(retainedModuleUuid, searchConfig),
			{
				kind: "addSearchInput",
				moduleUuid: retainedModuleUuid,
				searchInput: seed,
			},
		]);
		if (outcome.ok) setSel({ type: "input", uuid: seed.uuid });
	};
	const moveInput = (uuid: SearchInputDef["uuid"], toIndex: number) =>
		moveSearchInputToIndex(
			requireRetainedModuleUuid(moduleUuid),
			uuid,
			toIndex,
		);
	const clearFilter = useCallback(
		(nextFilter: Predicate | undefined) => {
			const mutations: Mutation[] = [
				{
					kind: "setCaseListMeta",
					uuid: requireRetainedModuleUuid(moduleUuid),
					patch: { filter: nextFilter ?? null },
				},
			];
			// Cases available and Search intent are independent. `{}` is a real
			// zero-input manual Search action, so "Show all cases" never removes it.
			return commitMany(mutations);
		},
		[commitMany, moduleUuid],
	);
	const updateFilter = useCallback(
		(nextFilter: Predicate | undefined) =>
			commitMany([
				{
					kind: "setCaseListMeta",
					uuid: requireRetainedModuleUuid(moduleUuid),
					patch: { filter: nextFilter ?? null },
				},
			]),
		[commitMany, moduleUuid],
	);

	// ── Tile arrangement ──
	//
	// Turning the tile on lands its placements in the SAME gated batch as
	// the switch, so the grid an author arrives at already works. Turning
	// it off touches only the layout slot, so every cell survives and the
	// drawing comes back intact.
	const tileDisabledReason = useMemo(() => {
		if (config.tile !== undefined || moduleUuid === undefined) return undefined;
		const plan = planTileLayoutEnable({ moduleUuid, config });
		return plan.ok ? undefined : plan.reason;
	}, [config, moduleUuid]);

	const setArrangement = useCallback(
		(next: CaseListArrangement) => {
			if (next === "tile") {
				if (config.tile !== undefined) return;
				const plan = planTileLayoutEnable({
					moduleUuid: requireRetainedModuleUuid(moduleUuid),
					config,
				});
				if (!plan.ok) {
					setWorkspaceAnnouncement(plan.reason);
					return;
				}
				if (commitMany([...plan.mutations]).ok) {
					setWorkspaceAnnouncement(
						"Results now shows a tile. Every field has a place on the grid.",
					);
				}
				return;
			}
			const persisted = config.tile?.persistOnForms === true;
			if (config.tile === undefined) return;
			if (
				commitMany([
					...planTileLayoutDisable(requireRetainedModuleUuid(moduleUuid)),
				]).ok
			) {
				// Every cell survives, but the tile's own setting cannot: with no
				// tile there is nothing to keep on screen. Say so rather than
				// letting it disappear quietly.
				setWorkspaceAnnouncement(
					persisted
						? "Results now shows rows. The tile arrangement is kept, and the tile no longer stays on screen during forms."
						: "Results now shows rows. The tile arrangement is kept.",
				);
			}
		},
		[commitMany, config.columns, config.tile, moduleUuid, config],
	);

	const closeSelectionReviewForNavigation = useCallback(() => {
		navigatingCaseSelectionReviewRef.current = true;
		setCaseSelectionReview(null);
	}, []);

	const plannerReviewBlocker = useCallback(
		(blocker: CaseSelectionTransitionBlocker): CaseSelectionReviewBlocker => {
			if (blocker.kind === "form-link") {
				const target =
					blocker.targetFormName ??
					blocker.targetModuleName ??
					"its destination";
				const message =
					blocker.reason === "authored-datums"
						? `“${blocker.sourceFormName}” customizes the case information sent straight to “${target}”. A several-case selection cannot use that one-case handoff. Open the link and send people to the destination's Results screen instead.`
						: blocker.reason === "different-case-type"
							? `“${blocker.sourceFormName}” opens “${target}” with a different kind of case. That direct handoff can carry one case, not a several-case selection. Open the link and send people to the destination's Results screen instead.`
							: `“${blocker.sourceFormName}” cannot carry this selection straight to “${target}”. Open its after-submit link and choose a destination that starts with Results.`;
				return {
					key: `form-link:${blocker.linkUuid}`,
					message,
					actionLabel: `Open ${blocker.sourceFormName}'s link`,
					onOpen: () => {
						closeSelectionReviewForNavigation();
						navigate.openFormLinks(
							blocker.sourceModuleUuid,
							blocker.sourceFormUuid,
							blocker.linkUuid,
						);
					},
				};
			}
			if (blocker.kind === "module") {
				return {
					key: `module:${blocker.moduleUuid}`,
					message: `“${blocker.moduleName}” has no Results list that can share this case selection. Add or restore its case list, then try again.`,
					actionLabel: `Open ${blocker.moduleName}`,
					onOpen: () => {
						closeSelectionReviewForNavigation();
						navigate.openModule(blocker.moduleUuid);
					},
				};
			}
			return {
				key: `structural:${blocker.parentModuleUuid}`,
				message: `“${blocker.parentModuleName}” needs a follow-up or close form that can use every selected case. Add that form in a compatible child workflow, then try again.`,
				actionLabel: `Open ${blocker.parentModuleName}`,
				onOpen: () => {
					closeSelectionReviewForNavigation();
					navigate.openModule(blocker.parentModuleUuid);
				},
			};
		},
		[closeSelectionReviewForNavigation, navigate],
	);

	const commitReviewBlocker = useCallback(
		(
			message: string,
			finding: StructuredCommitFinding | undefined,
			index: number,
		): CaseSelectionReviewBlocker => {
			if (finding === undefined) {
				return { key: `candidate:${index}`, message };
			}
			const { location, details } = finding;
			const parsedOperationUuid = uuidSchema.safeParse(details?.operationUuid);
			const operationUuid = parsedOperationUuid.success
				? parsedOperationUuid.data
				: undefined;
			const parsedLinkUuid = uuidSchema.safeParse(details?.linkUuid);
			const linkUuid = parsedLinkUuid.success ? parsedLinkUuid.data : undefined;
			const surface = details?.surface;
			const { moduleUuid: findingModuleUuid, formUuid: findingFormUuid } =
				location;
			const targetName =
				location.fieldId ??
				location.formName ??
				location.moduleName ??
				"this item";
			let onOpen: (() => void) | undefined;
			if (findingModuleUuid !== undefined && findingFormUuid !== undefined) {
				if (operationUuid !== undefined) {
					onOpen = () =>
						navigate.openFormOperations(
							findingModuleUuid,
							findingFormUuid,
							operationUuid,
						);
				} else if (
					linkUuid !== undefined ||
					finding.code.startsWith("FORM_LINK_") ||
					surface === "form_link_condition" ||
					surface === "form_link_datum_xpath"
				) {
					onOpen = () =>
						navigate.openFormLinks(
							findingModuleUuid,
							findingFormUuid,
							linkUuid,
						);
				} else if (
					finding.code.includes("FORM_DISPLAY_CONDITION") ||
					surface === "form_display_condition"
				) {
					onOpen = () =>
						navigate.openFormCondition(findingModuleUuid, findingFormUuid);
				} else {
					onOpen = () =>
						navigate.openForm(
							findingModuleUuid,
							findingFormUuid,
							location.fieldUuid,
						);
				}
			} else if (findingModuleUuid !== undefined) {
				onOpen = () => navigate.openModule(findingModuleUuid);
			}
			return {
				key: `${finding.code}:${index}`,
				message,
				...(onOpen !== undefined && {
					actionLabel: `Open ${targetName}`,
					onOpen: () => {
						closeSelectionReviewForNavigation();
						onOpen();
					},
				}),
			};
		},
		[closeSelectionReviewForNavigation, navigate],
	);

	const prepareCaseSelectionReview = useCallback(
		(
			next: CaseListConfig["selection"],
			captureOrigin: boolean,
			origin?: HTMLElement,
			refreshed: boolean = false,
		) => {
			if (moduleUuid === undefined) return;
			if (captureOrigin) {
				caseSelectionOriginRef.current =
					origin ??
					(document.activeElement instanceof HTMLElement
						? document.activeElement
						: null);
			}
			const doc = docApi.getState();
			const source = doc.modules[moduleUuid];
			if (source?.caseListConfig === undefined) return;
			const current = source.caseListConfig.selection;
			let confirmedModuleUuids: readonly Uuid[] = [];
			let plan = planCaseSelectionTransition(doc, {
				sourceModuleUuid: moduleUuid,
				selection: next,
			});
			if (plan.kind === "needs-coordination") {
				confirmedModuleUuids = plan.transitions.map(
					(transition) => transition.moduleUuid,
				);
				plan = planCaseSelectionTransition(doc, {
					sourceModuleUuid: moduleUuid,
					selection: next,
					confirmedModuleUuids,
				});
			}
			if (plan.kind === "blocked") {
				setCaseSelectionReview({
					sourceModuleUuid: moduleUuid,
					current,
					requested: next,
					confirmedModuleUuids,
					transitions: [],
					startingAnswers: [],
					attachmentAnswers: [],
					blockers: plan.blockers.map(plannerReviewBlocker),
					...(refreshed && {
						refreshNotice: CASE_SELECTION_REVIEW_REFRESHED,
					}),
				});
				return;
			}
			if (plan.kind !== "ready") {
				setWorkspaceAnnouncement(
					"This Case selection changed elsewhere. Review the latest workflow and try again.",
				);
				setCaseSelectionReview(null);
				return;
			}
			if (plan.mutations.length === 0) {
				setCaseSelectionReview(null);
				return;
			}
			const reviewed = inline.reviewMany([...plan.mutations]);
			if (!reviewed.ok) {
				setCaseSelectionReview({
					sourceModuleUuid: moduleUuid,
					current,
					requested: next,
					confirmedModuleUuids,
					transitions: plan.transitions,
					startingAnswers: [],
					attachmentAnswers: [],
					blockers: reviewed.messages.map((message, index) =>
						commitReviewBlocker(message, reviewed.findings?.[index], index),
					),
					...(refreshed && {
						refreshNotice: CASE_SELECTION_REVIEW_REFRESHED,
					}),
				});
				return;
			}

			const changesMode = (current === undefined) !== (next === undefined);
			const coordinatesAnotherModule = plan.transitions.some(
				(transition) => transition.moduleUuid !== moduleUuid,
			);
			if (!changesMode && !coordinatesAnotherModule) {
				if (inline.commitMany([...plan.mutations]).ok) {
					setWorkspaceAnnouncement(
						next === undefined
							? "People choose one case at a time."
							: `People can now choose up to ${next.maximum} ${next.maximum === 1 ? "case" : "cases"} and complete the form once for all of them.`,
					);
				}
				return;
			}

			const consequences = consequencesForSelection(
				doc,
				plan.transitions,
				projectProse,
			);
			setCaseSelectionReview({
				sourceModuleUuid: moduleUuid,
				current,
				requested: next,
				confirmedModuleUuids,
				transitions: plan.transitions,
				startingAnswers: consequences.startingAnswers,
				attachmentAnswers: consequences.attachmentAnswers,
				blockers: [],
				...(refreshed && {
					refreshNotice: CASE_SELECTION_REVIEW_REFRESHED,
				}),
			});
		},
		[
			commitReviewBlocker,
			docApi,
			inline,
			moduleUuid,
			plannerReviewBlocker,
			projectProse,
		],
	);

	const confirmCaseSelection = useCallback(() => {
		const review = caseSelectionReview;
		if (review === null || review.blockers.length > 0) return;
		const doc = docApi.getState();
		const plan = planCaseSelectionTransition(doc, {
			sourceModuleUuid: review.sourceModuleUuid,
			selection: review.requested,
			confirmedModuleUuids: review.confirmedModuleUuids,
		});
		if (plan.kind !== "ready") {
			prepareCaseSelectionReview(review.requested, false, undefined, true);
			return;
		}
		const sourceSelection =
			doc.modules[review.sourceModuleUuid]?.caseListConfig?.selection;
		const consequences = consequencesForSelection(
			doc,
			plan.transitions,
			projectProse,
		);
		if (
			!deepEqual(sourceSelection, review.current) ||
			!deepEqual(plan.transitions, review.transitions) ||
			!deepEqual(consequences.startingAnswers, review.startingAnswers) ||
			!deepEqual(consequences.attachmentAnswers, review.attachmentAnswers)
		) {
			prepareCaseSelectionReview(review.requested, false, undefined, true);
			return;
		}
		const checked = inline.reviewMany([...plan.mutations]);
		if (!checked.ok) {
			prepareCaseSelectionReview(review.requested, false, undefined, true);
			return;
		}
		if (!inline.commitMany([...plan.mutations]).ok) {
			prepareCaseSelectionReview(review.requested, false, undefined, true);
			return;
		}
		setCaseSelectionReview(null);
		setWorkspaceAnnouncement(
			review.requested === undefined
				? "People now choose one case at a time."
				: `People can now choose up to ${review.requested.maximum} ${review.requested.maximum === 1 ? "case" : "cases"} and complete the form once for all of them.`,
		);
	}, [
		caseSelectionReview,
		docApi,
		inline,
		prepareCaseSelectionReview,
		projectProse,
	]);

	const caseSelectionFinalFocus = useCallback(() => {
		if (navigatingCaseSelectionReviewRef.current) {
			navigatingCaseSelectionReviewRef.current = false;
			return null;
		}
		return caseSelectionOriginRef.current;
	}, []);

	const placeTileCell = useCallback(
		(uuid: Column["uuid"], cell: TileCell) => {
			const column = config.columns.find(
				(candidate) => candidate.uuid === uuid,
			);
			if (column === undefined) return;
			commitMany([
				...tileCellMutations(
					requireRetainedModuleUuid(moduleUuid),
					column,
					cell,
				),
			]);
		},
		[commitMany, config.columns, moduleUuid],
	);

	const clearTileCell = useCallback(
		(uuid: Column["uuid"]) => {
			const column = config.columns.find(
				(candidate) => candidate.uuid === uuid,
			);
			if (column === undefined) return;
			if (
				commitMany([
					...tileCellMutations(
						requireRetainedModuleUuid(moduleUuid),
						column,
						undefined,
					),
				]).ok
			) {
				setWorkspaceAnnouncement(
					`${columnDisplayLabel(column)} no longer has a saved tile place`,
				);
			}
		},
		[commitMany, config.columns, moduleUuid],
	);

	const putColumnOnTile = useCallback(
		(uuid: Column["uuid"]) => {
			const plan = planTilePlaceField({
				moduleUuid: requireRetainedModuleUuid(moduleUuid),
				config,
				uuid,
			});
			if (!plan.ok) {
				setWorkspaceAnnouncement(plan.reason);
				return;
			}
			if (commitMany([...plan.mutations]).ok) {
				const column = config.columns.find(
					(candidate) => candidate.uuid === uuid,
				);
				setWorkspaceAnnouncement(
					`${column === undefined ? "The field" : columnDisplayLabel(column)} is now on the tile`,
				);
				setSel({ type: "column", uuid });
			}
		},
		[commitMany, config.columns, moduleUuid, config],
	);

	const applyTilePreset = useCallback(
		(presetId: TilePresetId) => {
			const preset = TILE_PRESETS.find(
				(candidate) => candidate.id === presetId,
			);
			if (preset === undefined) return;
			const plan = planTilePreset({
				moduleUuid: requireRetainedModuleUuid(moduleUuid),
				config,
				preset,
			});
			if (!plan.ok) {
				setWorkspaceAnnouncement(plan.reason);
				return;
			}
			if (commitMany([...plan.mutations]).ok) {
				setWorkspaceAnnouncement(`Tile rearranged as ${preset.label}`);
			}
		},
		[commitMany, config.columns, moduleUuid, config],
	);

	const setTilePersistOnForms = useCallback(
		(persist: boolean) => {
			commitMany([
				...planTilePersistOnForms(
					requireRetainedModuleUuid(moduleUuid),
					persist,
					config.tile,
				),
			]);
		},
		[commitMany, config.tile, moduleUuid],
	);

	const setTileGrouping = useCallback(
		(next: CaseTileGrouping | undefined) => {
			commitMany([
				...planTileGrouping(
					requireRetainedModuleUuid(moduleUuid),
					next,
					config.tile,
				),
			]);
		},
		[commitMany, config.tile, moduleUuid],
	);

	// ── Inspector resolution ──
	//
	// Computed only while the workspace is actually on-screen (`active`). When
	// it isn't: the module has no case type, or the URL moved on while the
	// controller is retained: there is nothing to inspect and the rail shows
	// chat. `caseType` is re-narrowed here (a bare `active` boolean can't do it).
	let inspector: { kicker: string; title: string; body: ReactNode } | null =
		null;
	let searchConditionSurface: ReactNode = null;
	let resultsDependencyReview: CaseListCanvasProps["dependencyReview"];
	if (active && mod !== undefined && caseType !== undefined) {
		inspector = resolveInspector({
			sel,
			activeTab: tab,
			moduleUuid,
			docApi,
			config,
			searchConfig,
			searchIsEffective: effectiveSearchConfig !== undefined,
			caseTypes,
			userProperties,
			caseType,
			onSearchConfigChange: updateSearchConfig,
			replaceColumn,
			replaceInput,
			onEditInputCondition: (uuid, slot) =>
				openSearchCondition({ kind: "input", uuid, slot }),
			onEditSearchButtonCondition: editSearchButtonCondition,
			searchSettingsHasError: searchButtonConditionBroken,
			canOpenOnSearch: isCaseFirst || isBareCaseList,
			onHideColumn: hideColumnFromSurface,
			onDeleteColumn: deleteColumn,
			onRemoveInput: removeInput,
			inputRemovalReview,
			onStartInputRemovalReview: startInputRemovalReview,
			onCancelInputRemovalReview: cancelInputRemovalReview,
			onCompleteInputRemovalReview: completeInputRemovalReview,
			onReviewInputRemovalDependency: reviewInputRemovalDependency,
			tileOn: config.tile !== undefined,
			tileIssues,
			onPlaceTileCell: placeTileCell,
			onClearTileCell: clearTileCell,
			onPutColumnOnTile: putColumnOnTile,
		});

		if (sel?.type === "search-condition") {
			if (sel.target.kind === "input") {
				const inputUuid = sel.target.uuid;
				const input = config.searchInputs.find(
					(candidate) => candidate.uuid === inputUuid,
				);
				const slot = searchConditionSlotOf(sel.target);
				const condition =
					input === undefined ? undefined : searchInputConditionAt(input, slot);
				if (input !== undefined && condition !== undefined) {
					const dependencyReview =
						inputRemovalReview?.phase === "target" &&
						inputRemovalReview.dependency.kind === "search-field-condition" &&
						inputRemovalReview.dependency.inputUuid === input.uuid &&
						inputRemovalReview.dependency.slot === slot
							? {
									token: inputRemovalReview.token,
									path: inputRemovalReview.dependency.paths[0],
									inputLabel: inputRemovalReview.inputLabel,
								}
							: undefined;
					searchConditionSurface = (
						<SearchConditionCanvas
							context={{
								kind: "input",
								slot,
								label:
									input.label ||
									labelFromProperty(input.name) ||
									"this search field",
							}}
							value={condition}
							onChange={(predicate) =>
								replaceInput(
									input.uuid,
									withSearchInputCondition(input, slot, predicate),
								)
							}
							onBack={
								dependencyReview === undefined
									? () =>
											returnFromSearchCondition({
												type: "input",
												uuid: input.uuid,
											})
									: returnToInputRemovalReview
							}
							caseTypes={caseTypes}
							userProperties={userProperties}
							currentCaseType={caseType}
							knownInputs={searchInputDecls(config.searchInputs)}
							dependencyReview={dependencyReview}
						/>
					);
				}
			} else if (
				searchConfig !== undefined &&
				!isOwnerOnlyCaseSearchConfig(searchConfig) &&
				searchConfig.searchButtonDisplayCondition !== undefined
			) {
				searchConditionSurface = (
					<SearchConditionCanvas
						context={{ kind: "search-button" }}
						value={searchConfig.searchButtonDisplayCondition}
						onChange={(searchButtonDisplayCondition) =>
							updateSearchConfig({
								...searchConfig,
								searchButtonDisplayCondition,
							})
						}
						onBack={() => {
							setSearchButtonConditionFocusRequest(undefined);
							returnFromSearchCondition({ type: "search-panel" });
						}}
						caseTypes={caseTypes}
						userProperties={userProperties}
						currentCaseType={caseType}
						focusRequest={searchButtonConditionFocusRequest}
					/>
				);
			}
		}
		if (
			inputRemovalReview?.phase === "target" &&
			inputRemovalReview.dependency.kind === "cases-available"
		) {
			resultsDependencyReview = {
				kind: "cases-available",
				token: inputRemovalReview.token,
				path: inputRemovalReview.dependency.paths[0],
				inputLabel: inputRemovalReview.inputLabel,
			};
		} else if (
			inputRemovalReview?.phase === "target" &&
			inputRemovalReview.dependency.kind === "assigned-cases"
		) {
			resultsDependencyReview = {
				kind: "assigned-cases",
				token: inputRemovalReview.token,
				inputLabel: inputRemovalReview.inputLabel,
			};
		}
	}

	return {
		active,
		moduleUuid,
		tab,
		announcement: workspaceAnnouncement,
		isBareCaseList,
		inspector,
		onClose: closeSelectionAndRestoreFocus,
		config,
		searchConfig,
		effectiveSearchConfig,
		caseTypes,
		userProperties,
		caseType: caseType ?? "",
		ct,
		sel,
		setSel,
		brokenColumns,
		errorAreas,
		filterBroken,
		excludedOwnerIdsBroken,
		searchButtonConditionBroken,
		tileIssues,
		tileDisabledReason,
		setArrangement,
		setCaseSelection: (
			next: CaseListConfig["selection"],
			origin?: HTMLElement,
		) => prepareCaseSelectionReview(next, true, origin),
		caseSelectionReview,
		cancelCaseSelectionReview: () => setCaseSelectionReview(null),
		confirmCaseSelection,
		caseSelectionFinalFocus,
		placeTileCell,
		putColumnOnTile,
		applyTilePreset,
		setTilePersistOnForms,
		setTileGrouping,
		addDisabledReason,
		addResultsDisabledReason,
		opensResultsAutomatically,
		searchConditionSurface,
		resultsDependencyReview,
		configureSearchAction,
		addInput,
		addHiddenInput,
		moveInput,
		addColumn,
		addCalculatedColumn,
		moveColumn,
		updateColumns,
		showColumn,
		updateFilter,
		clearFilter,
		updateExcludedOwnerIds,
		returnToInputRemovalReview,
	};
}

// ── Context + provider ────────────────────────────────────────────

export type CaseListWorkspace = ReturnType<typeof useController>;

/** Publish the heavy controller through the lightweight, stable provider
 * boundary. This component itself is loaded only after a case-list visit. */
export function CaseListWorkspaceControllerBridge({
	target,
	workspaceStore,
	inspectorStore,
}: CaseListWorkspaceControllerBridgeProps) {
	const value = useController(target);
	const { inspector, onClose } = value;
	const inspectorSlice = useMemo(
		() => ({ inspector, onClose }),
		[inspector, onClose],
	);
	useLayoutEffect(() => {
		workspaceStore.publish(value);
	}, [value, workspaceStore]);
	useLayoutEffect(() => {
		inspectorStore.publish(inspectorSlice);
	}, [inspectorSlice, inspectorStore]);
	useLayoutEffect(
		() => () => {
			workspaceStore.publish(null);
			inspectorStore.publish(null);
		},
		[inspectorStore, workspaceStore],
	);
	return null;
}

// ── Canvas (center) ───────────────────────────────────────────────
//
// The composition surface for the active workspace: a consumer of the shared
// controller, mounted by `PreviewShell` (which Activity-hides it during a
// preview flip, when the running CaseListScreen takes over). The inspector body
// is NOT rendered here; the rail renders it from `controller.inspector`.

export function CaseListWorkspaceCanvas() {
	const ws = useCaseListWorkspace();
	const navigate = useNavigate();
	const appId = useAppId() ?? "";
	const compactHeight = useIsBreakpoint("max", 360, "height");
	/* Bridge each tab body's scroll across Activity hide/reveal and module
	 * unmount/remount. The shared controller above this canvas owns the durable
	 * authoring state. */
	const scrollPositions = useRef(new Map<string, number>());
	const frozenScrollKeysRef = useRef(new Set<string>());
	const moduleUuid = ws?.moduleUuid;
	const scrollBodyRefs = useMemo(() => {
		const bind =
			(kind: CaseListWorkspaceTab) => (node: HTMLDivElement | null) => {
				if (node === null || moduleUuid === undefined) return;
				const key = `${moduleUuid}:${kind}`;
				const remembered = scrollPositions.current.get(key);
				let frame: number | null = null;
				if (remembered !== undefined) {
					frozenScrollKeysRef.current.add(key);
					/*
					 * Activity can reconnect the ref while its host is still
					 * display:none. Wait for the body to participate in layout,
					 * then reassert the exact authored offset across the reveal's
					 * settled frame. First mounts have no saved value and are
					 * deliberately left alone.
					 */
					node.scrollTop = remembered;
					const restoreAfterReveal = () => {
						if (!node.isConnected) {
							frame = null;
							return;
						}
						if (getComputedStyle(node).display === "none") {
							frame = requestAnimationFrame(restoreAfterReveal);
							return;
						}
						node.scrollTop = remembered;
						frame = requestAnimationFrame(() => {
							node.scrollTop = remembered;
							frozenScrollKeysRef.current.delete(key);
							frame = null;
						});
					};
					frame = requestAnimationFrame(restoreAfterReveal);
				}
				return () => {
					if (frame !== null) cancelAnimationFrame(frame);
				};
			};
		return {
			search: bind("search"),
			list: bind("list"),
			detail: bind("detail"),
		};
	}, [moduleUuid]);
	const rememberScroll = useCallback(
		(kind: CaseListWorkspaceTab, scrollTop: number) => {
			if (moduleUuid === undefined) return;
			const key = `${moduleUuid}:${kind}`;
			if (frozenScrollKeysRef.current.has(key)) return;
			scrollPositions.current.set(key, scrollTop);
		},
		[moduleUuid],
	);
	const captureScroll = useCallback(
		(kind: CaseListWorkspaceTab) => {
			if (moduleUuid === undefined) return;
			const node = document.querySelector<HTMLElement>(
				`[data-case-workspace-scroll-body="${kind}"]`,
			);
			if (node !== null) {
				const key = `${moduleUuid}:${kind}`;
				scrollPositions.current.set(key, node.scrollTop);
				/*
				 * Activity can emit delayed clamp/reveal scrolls after more than
				 * one subsequent tab transition. Freeze this exact module/tab
				 * snapshot until that tab has visibly restored it.
				 */
				frozenScrollKeysRef.current.add(key);
			}
		},
		[moduleUuid],
	);
	const visibleTab = ws?.tab;
	/*
	 * Activity intentionally keeps each workbench mounted and may therefore
	 * preserve its ref across a hide/reveal. The ref bridge alone cannot observe
	 * that transition, so the URL-owned tab change performs the same
	 * layout-ready correction explicitly.
	 */
	useLayoutEffect(() => {
		if (moduleUuid === undefined || visibleTab === undefined) return;
		const remembered = scrollPositions.current.get(
			`${moduleUuid}:${visibleTab}`,
		);
		if (remembered === undefined) return;
		const key = `${moduleUuid}:${visibleTab}`;
		frozenScrollKeysRef.current.add(key);
		let frame: number | null = null;
		const restoreAfterReveal = () => {
			const node = document.querySelector<HTMLElement>(
				`[data-case-workspace-scroll-body="${visibleTab}"]`,
			);
			if (node === null || !node.isConnected) {
				frame = null;
				return;
			}
			if (getComputedStyle(node).display === "none") {
				frame = requestAnimationFrame(restoreAfterReveal);
				return;
			}
			node.scrollTop = remembered;
			frame = requestAnimationFrame(() => {
				node.scrollTop = remembered;
				frozenScrollKeysRef.current.delete(key);
				frame = null;
			});
		};
		frame = requestAnimationFrame(restoreAfterReveal);
		return () => {
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [moduleUuid, visibleTab]);

	// Guard both the never-visited state and the deletion-in-flight window: a
	// peer may clear the case type on the retained module before
	// LocationRecoveryEffect degrades the URL. Render nothing rather than stand
	// EMPTY_CONFIG up with live mutation controls and no real module identity.
	// Deliberately NOT gated on `active` (which also goes false on navigate-away):
	// after the first visit the sticky module keeps rendering while
	// Activity-hidden so its scroll survives.
	if (ws === null || ws.moduleUuid === undefined || ws.caseType === "") {
		return null;
	}
	const workspaceModuleUuid = ws.moduleUuid;
	const {
		tab,
		errorAreas,
		isBareCaseList,
		announcement,
		searchConditionSurface,
		config,
		searchConfig,
		effectiveSearchConfig,
		caseTypes,
		userProperties,
		caseType,
		ct,
		sel,
		setSel,
		brokenColumns,
		filterBroken,
		excludedOwnerIdsBroken,
		searchButtonConditionBroken,
		tileIssues,
		tileDisabledReason,
		setArrangement,
		setCaseSelection,
		caseSelectionReview,
		cancelCaseSelectionReview,
		confirmCaseSelection,
		caseSelectionFinalFocus,
		placeTileCell,
		putColumnOnTile,
		applyTilePreset,
		setTilePersistOnForms,
		setTileGrouping,
		addDisabledReason,
		addResultsDisabledReason,
		opensResultsAutomatically,
		resultsDependencyReview,
		configureSearchAction,
		addInput,
		addHiddenInput,
		moveInput,
		addColumn,
		addCalculatedColumn,
		moveColumn,
		updateColumns,
		showColumn,
		updateFilter,
		clearFilter,
		updateExcludedOwnerIds,
		returnToInputRemovalReview,
	} = ws;

	return (
		<div className="case-list-workspace @container flex h-full min-h-0 flex-col overflow-hidden">
			<p
				className="sr-only"
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				{announcement}
			</p>
			<WorkspaceTabs
				moduleSettings={
					isBareCaseList ? (
						<ModuleSettingsButton moduleUuid={workspaceModuleUuid} />
					) : null
				}
				compactHeight={compactHeight}
				tab={tab}
				errorAreas={errorAreas}
				onSelectTab={(next) => {
					/* Tabs are no-ops when already active. */
					if (next === tab) return;
					/*
					 * Capture in the click boundary, before React tears down the
					 * outgoing tab. Cleanup-time reads happen after descendant
					 * effects and Chromium can already be one line away from the
					 * author's visible position.
					 */
					captureScroll(tab);
					if (next === "search") navigate.openSearchConfig(workspaceModuleUuid);
					else if (next === "list") navigate.openCaseList(workspaceModuleUuid);
					else navigate.openDetailConfig(workspaceModuleUuid);
				}}
			/>

			{/* Each tab keeps its own body mounted through Activity. The explicit
			 * snapshot/restore bridge corrects Chromium's reveal-time reclamp
			 * without sacrificing the workbench's local state. The strip is a
			 * fixed flex sibling, so it cannot drift before "sticking". Do not use
			 * data-preview-scroll-container here: that selector belongs to the
			 * builder's form flipbook contract. */}
			<div className="relative min-h-0 flex-1 overflow-hidden">
				<Activity mode={tab === "search" ? "visible" : "hidden"}>
					<div
						ref={scrollBodyRefs.search}
						data-case-workspace-scroll-body="search"
						onScroll={(event) =>
							rememberScroll("search", event.currentTarget.scrollTop)
						}
						className="h-full overflow-y-auto overflow-x-hidden overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
					>
						{searchConditionSurface ?? (
							<SearchCanvas
								searchInputs={config.searchInputs}
								searchConfig={searchConfig}
								caseTypes={caseTypes}
								currentCaseType={caseType}
								selection={sel}
								onSelect={setSel}
								onConfigureSearchAction={configureSearchAction}
								onAddInput={addInput}
								onAddHiddenInput={addHiddenInput}
								addInputDisabledReason={addDisabledReason}
								hasSearchSurface={config.searchInputs.length > 0}
								hasSearchAction={effectiveSearchConfig !== undefined}
								opensResultsAutomatically={opensResultsAutomatically}
								searchFirst={effectiveSearchConfig?.searchFirst === true}
								onMoveInput={moveInput}
								searchSettingsHasError={searchButtonConditionBroken}
								{...(moduleUuid === undefined ? {} : { moduleUuid })}
							/>
						)}
					</div>
				</Activity>
				<Activity mode={tab === "list" ? "visible" : "hidden"}>
					<div
						ref={scrollBodyRefs.list}
						data-case-workspace-scroll-body="list"
						onScroll={(event) =>
							rememberScroll("list", event.currentTarget.scrollTop)
						}
						className="h-full overflow-y-auto overflow-x-hidden overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
					>
						<CaseListCanvas
							config={config}
							caseType={ct}
							caseTypes={caseTypes}
							userProperties={userProperties}
							brokenColumns={brokenColumns}
							selection={sel}
							onSelect={setSel}
							onTileGroupingChange={setTileGrouping}
							onAddColumn={(property) => addColumn("list", property)}
							onAddCalculated={() => addCalculatedColumn("list")}
							addColumnDisabledReason={addResultsDisabledReason}
							onMoveColumn={(uuid, toIndex) =>
								moveColumn("list", uuid, toIndex)
							}
							onColumnsChange={updateColumns}
							onShowColumn={(column) => showColumn("list", column)}
							filterBroken={filterBroken}
							excludedOwnerIdsBroken={excludedOwnerIdsBroken}
							onFilterChange={updateFilter}
							onClearFilter={clearFilter}
							searchConfig={searchConfig}
							caseSearchEnabled={effectiveSearchConfig !== undefined}
							onExcludedOwnerIdsChange={updateExcludedOwnerIds}
							appId={appId}
							dependencyReview={resultsDependencyReview}
							onReturnToSearchField={returnToInputRemovalReview}
							tileIssues={tileIssues}
							tileDisabledReason={tileDisabledReason}
							onArrangementChange={setArrangement}
							onPlaceTileCell={placeTileCell}
							onPutColumnOnTile={putColumnOnTile}
							onApplyTilePreset={applyTilePreset}
							onTilePersistOnFormsChange={setTilePersistOnForms}
							onCaseSelectionChange={setCaseSelection}
						/>
					</div>
				</Activity>
				<Activity mode={tab === "detail" ? "visible" : "hidden"}>
					<div
						ref={scrollBodyRefs.detail}
						data-case-workspace-scroll-body="detail"
						onScroll={(event) =>
							rememberScroll("detail", event.currentTarget.scrollTop)
						}
						className="h-full overflow-y-auto overflow-x-hidden overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
					>
						<DetailCanvas
							config={config}
							caseType={ct}
							brokenColumns={brokenColumns}
							selection={sel}
							onSelect={setSel}
							onAddDetailField={(property) => addColumn("detail", property)}
							onAddCalculated={() => addCalculatedColumn("detail")}
							addDisabledReason={addDisabledReason}
							onMoveColumn={(uuid, toIndex) =>
								moveColumn("detail", uuid, toIndex)
							}
							onShowColumn={(column) => showColumn("detail", column)}
						/>
					</div>
				</Activity>
			</div>
			{caseSelectionReview !== null && (
				<CaseSelectionReviewDialog
					sourceModuleUuid={caseSelectionReview.sourceModuleUuid}
					current={caseSelectionReview.current}
					requested={caseSelectionReview.requested}
					transitions={caseSelectionReview.transitions}
					startingAnswers={caseSelectionReview.startingAnswers}
					attachmentAnswers={caseSelectionReview.attachmentAnswers}
					blockers={caseSelectionReview.blockers}
					refreshNotice={caseSelectionReview.refreshNotice}
					finalFocus={caseSelectionFinalFocus}
					onCancel={cancelCaseSelectionReview}
					onConfirm={confirmCaseSelection}
				/>
			)}
		</div>
	);
}

// ── Inspector resolution ──────────────────────────────────────────

interface ResolveInspectorArgs {
	readonly sel: WorkspaceSelection | null;
	readonly activeTab: CaseListWorkspaceTab;
	/** The module whose config this is, once the URL has resolved it. */
	readonly moduleUuid: Uuid | undefined;
	/** The document, read imperatively for dependents outside this config. */
	readonly docApi: ReturnType<typeof useBlueprintDocApi>;
	readonly config: CaseListConfig;
	readonly searchConfig: CaseSearchConfig | undefined;
	readonly searchIsEffective: boolean;
	readonly caseTypes: ReturnType<typeof useEffectiveCaseTypes>;
	readonly userProperties: ReturnType<typeof useUserProperties>;
	readonly caseType: string;
	readonly onSearchConfigChange: (next: CaseSearchConfig) => void;
	readonly replaceColumn: (uuid: string, next: Column) => void;
	readonly replaceInput: (uuid: string, next: SearchInputDef) => void;
	readonly onEditInputCondition: (
		uuid: SearchInputDef["uuid"],
		slot: SearchConditionSlot,
	) => void;
	readonly onEditSearchButtonCondition: (focusNewCondition?: boolean) => void;
	readonly searchSettingsHasError: boolean;
	/** The module's first screen selects a case, so it may open on Search. */
	readonly canOpenOnSearch: boolean;
	readonly onHideColumn: (surface: CaseDisplaySurface, column: Column) => void;
	readonly onDeleteColumn: (
		surface: CaseDisplaySurface,
		column: Column,
	) => void;
	readonly onRemoveInput: (uuid: SearchInputDef["uuid"]) => void;
	readonly inputRemovalReview: SearchInputRemovalReviewSession | null;
	readonly onStartInputRemovalReview: (input: SearchInputDef) => void;
	readonly onCancelInputRemovalReview: () => void;
	readonly onCompleteInputRemovalReview: (inputLabel: string) => void;
	readonly onReviewInputRemovalDependency: (
		dependency: SearchInputRemovalDependency,
	) => void;
	readonly tileOn: boolean;
	readonly tileIssues: ReadonlyMap<string, readonly string[]>;
	readonly onPlaceTileCell: (uuid: Column["uuid"], cell: TileCell) => void;
	readonly onClearTileCell: (uuid: Column["uuid"]) => void;
	readonly onPutColumnOnTile: (uuid: Column["uuid"]) => void;
}

/**
 * Selection → inspector chrome + body. Returns `null` when nothing is
 * selected OR the selected entity no longer exists (e.g. the agent
 * removed it mid-session): a dangling selection renders no inspector
 * rather than a broken one.
 */
function resolveInspector(args: ResolveInspectorArgs): {
	kicker: string;
	title: string;
	body: React.ReactNode;
} | null {
	const { sel, config } = args;
	if (sel === null) return null;

	switch (sel.type) {
		case "column": {
			const sortedCols = [...config.columns];
			const column = sortedCols.find((c) => c.uuid === sel.uuid);
			if (column === undefined) return null;
			const projection = projectCaseWorkspaceColumns(config);
			const surface =
				args.activeTab === "list"
					? "list"
					: args.activeTab === "detail"
						? "detail"
						: null;
			const title =
				column.kind === "calculated"
					? column.header || "Calculated value"
					: column.header ||
						labelFromProperty(column.field) ||
						"Untitled field";
			return {
				kicker: "Information",
				title,
				body:
					surface === null ? null : (
						<ColumnInspectorBody
							key={column.uuid}
							column={column}
							config={config}
							surface={surface}
							visibleCount={
								surface === "list"
									? projection.listVisible.length
									: projection.detailVisible.length
							}
							listVisibleCount={projection.listVisible.length}
							caseTypes={args.caseTypes}
							userProperties={args.userProperties}
							currentCaseType={args.caseType}
							searchIsEffective={args.searchIsEffective}
							tileOn={args.tileOn}
							tileIssues={args.tileIssues.get(column.uuid) ?? NO_TILE_ISSUES}
							onChange={(next) => args.replaceColumn(column.uuid, next)}
							onPlaceTileCell={(cell) =>
								args.onPlaceTileCell(column.uuid, cell)
							}
							onClearTileCell={() => args.onClearTileCell(column.uuid)}
							onPutOnTile={() => args.onPutColumnOnTile(column.uuid)}
							onHide={() => args.onHideColumn(surface, column)}
							onDelete={() => args.onDeleteColumn(surface, column)}
						/>
					),
			};
		}
		case "input": {
			// Array position is the display sequence.
			const sortedInputs = [...config.searchInputs];
			const index = sortedInputs.findIndex((s) => s.uuid === sel.uuid);
			const input = sortedInputs[index];
			if (input === undefined) return null;
			/* The config half reads this config; the form fields reading the
			 * answer live on other screens, so they are read imperatively from
			 * the document (this inspector re-resolves whenever the selection
			 * or the config changes). */
			const removalDependencies = [
				...searchInputRemovalDependencies(
					config,
					args.searchConfig,
					input.uuid,
				),
				...(args.moduleUuid === undefined
					? []
					: searchInputFormFieldDependencies(
							args.docApi.getState(),
							args.moduleUuid,
							input.uuid,
						)),
			];
			return {
				kicker: "Search field",
				title: input.label || labelFromProperty(input.name) || "Untitled field",
				body: (
					<SearchInputInspectorBody
						input={input}
						index={index}
						siblings={sortedInputs}
						caseTypes={args.caseTypes}
						userProperties={args.userProperties}
						currentCaseType={args.caseType}
						onChange={(next) => args.replaceInput(input.uuid, next)}
						onEditCondition={(slot) =>
							args.onEditInputCondition(input.uuid, slot)
						}
						searchScreenSettingsRemoved={
							sortedInputs.length === 1
								? authoredSearchScreenSettings(args.searchConfig)
								: []
						}
						searchActionSettingsPreserved={
							sortedInputs.length === 1
								? authoredSearchActionSettings(args.searchConfig)
								: []
						}
						opensResultsAutomatically={
							sortedInputs.length === 1 &&
							args.searchConfig !== undefined &&
							effectiveFilterForEmission(config.filter) !== undefined
						}
						preservesAssignedCaseRule={
							sortedInputs.length === 1 &&
							args.searchConfig?.excludedOwnerIds !== undefined
						}
						removalDependencies={removalDependencies}
						removalReviewOpen={
							args.inputRemovalReview?.phase === "dependencies" &&
							args.inputRemovalReview.inputUuid === input.uuid
						}
						onStartRemovalReview={() => args.onStartInputRemovalReview(input)}
						onCancelRemovalReview={args.onCancelInputRemovalReview}
						onCompleteRemovalReview={() =>
							args.onCompleteInputRemovalReview(
								input.label.trim() || input.name.trim() || "Search field",
							)
						}
						onReviewRemovalDependency={args.onReviewInputRemovalDependency}
						onRemove={() => args.onRemoveInput(input.uuid)}
					/>
				),
			};
		}
		case "search-panel": {
			const hasVisibleSearchScreen = config.searchInputs.length > 0;
			const effectiveSearch = effectiveCaseSearchConfig({
				caseListConfig: config,
				caseSearchConfig: args.searchConfig,
			});
			const opensResultsAutomatically =
				effectiveSearch !== undefined &&
				!hasVisibleSearchScreen &&
				effectiveFilterForEmission(config.filter) !== undefined;
			return {
				kicker: hasVisibleSearchScreen ? "Search screen" : "More settings",
				title: hasVisibleSearchScreen
					? (effectiveSearch?.searchScreenTitle ?? DEFAULT_CASE_SEARCH_TITLE)
					: "Search action",
				body: (
					<SearchPanelInspectorBody
						value={effectiveSearch}
						onChange={args.onSearchConfigChange}
						caseTypes={args.caseTypes}
						currentCaseType={args.caseType}
						knownInputs={config.searchInputs}
						hasVisibleSearchScreen={hasVisibleSearchScreen}
						hasSearchAction={effectiveSearch !== undefined}
						opensResultsAutomatically={opensResultsAutomatically}
						onEditDisplayCondition={args.onEditSearchButtonCondition}
						searchSettingsHasError={args.searchSettingsHasError}
						canOpenOnSearch={args.canOpenOnSearch}
					/>
				),
			};
		}
		case "search-condition":
			// The center workbench is the single editing surface for this setting.
			return null;
	}
}

function ColumnInspectorBody({
	column,
	config,
	surface,
	visibleCount,
	listVisibleCount,
	caseTypes,
	userProperties,
	currentCaseType,
	searchIsEffective,
	tileOn,
	tileIssues,
	onChange,
	onPlaceTileCell,
	onClearTileCell,
	onPutOnTile,
	onHide,
	onDelete,
}: {
	readonly column: Column;
	readonly config: CaseListConfig;
	/** The whole case list: a tile placement is adjudicated against the
	 * other fields on the tile, so the rail needs more than one column. */
	readonly surface: CaseDisplaySurface;
	readonly visibleCount: number;
	readonly listVisibleCount: number;
	readonly caseTypes: ReturnType<typeof useEffectiveCaseTypes>;
	readonly userProperties: ReturnType<typeof useUserProperties>;
	readonly currentCaseType: string;
	readonly searchIsEffective: boolean;
	readonly tileOn: boolean;
	readonly tileIssues: readonly string[];
	readonly onChange: (next: Column) => void;
	readonly onPlaceTileCell: (cell: TileCell) => void;
	readonly onClearTileCell: () => void;
	readonly onPutOnTile: () => void;
	readonly onHide: () => void;
	readonly onDelete: () => void;
}) {
	const canEdit = useCanEdit();
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	/* Focus lands here when the tile section removes itself, its own button
	 * goes with it, and an unmounted action never drops focus on the page. */
	const hideRef = useRef<HTMLButtonElement>(null);
	const screenName = surfaceDisplayName(surface);
	const keepLastResult = surface === "list" && visibleCount <= 1;
	const deleteWouldRemoveLastResult =
		column.visibleInList !== false && listVisibleCount <= 1;
	const displayedOn = [
		...(column.visibleInList !== false ? ["Results"] : []),
		...(column.visibleInDetail !== false ? ["Details"] : []),
	];
	const deleteDescription = `${
		displayedOn.length === 0
			? "This deletes its saved label and formatting"
			: `This removes it from ${displayedOn.join(" and ")}`
	}. Saved case data won't change${
		column.sort !== undefined
			? ". It will also be removed from the default order."
			: "."
	}`;
	return (
		<>
			<ColumnEditor
				key={column.uuid}
				value={column}
				onChange={onChange}
				caseTypes={caseTypes}
				userProperties={userProperties}
				currentCaseType={currentCaseType}
				searchIsEffective={searchIsEffective}
			/>
			<TileCellInspector
				column={column}
				config={config}
				tileOn={tileOn}
				issues={tileIssues}
				canEdit={canEdit}
				onPlace={onPlaceTileCell}
				onClearPlace={() => {
					onClearTileCell();
					// The section unmounts with its own button, so hand focus to
					// the next thing in the body rather than dropping it on the page.
					requestAnimationFrame(() => hideRef.current?.focus());
				}}
				onPutOnTile={onPutOnTile}
			/>
			<div className="border-t border-nova-border pt-3">
				<Button
					ref={hideRef}
					type="button"
					onClick={onHide}
					disabled={keepLastResult}
					aria-disabled={keepLastResult}
					variant="outline"
					/* The disabled branch only restated what `disabled` already
					 * does: one 0.6 opacity, hover gated off. */
					className="w-full"
				>
					<Icon icon={tablerEyeOff} width="15" height="15" />
					Hide from {screenName}
				</Button>
				<p className="mt-2 text-[12px] leading-relaxed text-nova-text-muted">
					{keepLastResult
						? "People need at least one piece of information to choose a case. Add another before hiding this one."
						: `You can add it back from Add information in ${screenName}`}
				</p>
			</div>
			<RemoveRow
				label="Delete information"
				onClick={() => setConfirmingDelete(true)}
				disabledReason={
					deleteWouldRemoveLastResult
						? "People need at least one piece of information to choose a case. Add another before deleting this one."
						: undefined
				}
			/>
			{!deleteWouldRemoveLastResult && (
				<p className="-mt-1 text-[12px] leading-relaxed text-nova-text-muted">
					Deleting this information won't delete saved case data
				</p>
			)}
			<AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
				<AlertDialogContent className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display tracking-tighter">
							Delete {columnDisplayLabel(column)}?
						</AlertDialogTitle>
						<AlertDialogDescription>{deleteDescription}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={onDelete}>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

function SearchInputInspectorBody({
	input,
	index,
	siblings,
	caseTypes,
	userProperties,
	currentCaseType,
	onChange,
	onEditCondition,
	searchScreenSettingsRemoved,
	searchActionSettingsPreserved,
	opensResultsAutomatically,
	preservesAssignedCaseRule,
	removalDependencies,
	removalReviewOpen,
	onStartRemovalReview,
	onCancelRemovalReview,
	onCompleteRemovalReview,
	onReviewRemovalDependency,
	onRemove,
}: {
	readonly input: SearchInputDef;
	readonly index: number;
	readonly siblings: readonly SearchInputDef[];
	readonly caseTypes: ReturnType<typeof useEffectiveCaseTypes>;
	readonly userProperties: ReturnType<typeof useUserProperties>;
	readonly currentCaseType: string;
	readonly onChange: (next: SearchInputDef) => void;
	readonly onEditCondition: (slot: SearchConditionSlot) => void;
	readonly searchScreenSettingsRemoved: readonly string[];
	readonly searchActionSettingsPreserved: readonly string[];
	readonly opensResultsAutomatically: boolean;
	readonly preservesAssignedCaseRule: boolean;
	readonly removalDependencies: readonly SearchInputRemovalDependency[];
	readonly removalReviewOpen: boolean;
	readonly onStartRemovalReview: () => void;
	readonly onCancelRemovalReview: () => void;
	readonly onCompleteRemovalReview: () => void;
	readonly onReviewRemovalDependency: (
		dependency: SearchInputRemovalDependency,
	) => void;
	readonly onRemove: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const removeTriggerRef = useRef<HTMLElement | null>(null);
	const removeRegionRef = useRef<HTMLDivElement>(null);
	const navigatingReviewRef = useRef(false);
	const completedReviewRef = useRef(false);
	const removesSearchScreen = siblings.length === 1;
	const remove = () => {
		removeTriggerRef.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		if (removalDependencies.length > 0) {
			onStartRemovalReview();
			return;
		}
		if (removesSearchScreen) {
			setConfirming(true);
		} else onRemove();
	};
	const inputLabel = input.label.trim() || input.name.trim() || "this field";
	useEffect(() => {
		if (!removalReviewOpen || removalDependencies.length > 0) {
			completedReviewRef.current = false;
			return;
		}
		if (completedReviewRef.current) return;
		const frame = requestAnimationFrame(() => {
			completedReviewRef.current = true;
			removeRegionRef.current
				?.querySelector<HTMLButtonElement>("button")
				?.focus({ preventScroll: true });
			onCompleteRemovalReview();
		});
		return () => cancelAnimationFrame(frame);
	}, [onCompleteRemovalReview, removalDependencies.length, removalReviewOpen]);
	const settingsList = new Intl.ListFormat("en", {
		style: "long",
		type: "conjunction",
	}).format(searchScreenSettingsRemoved);
	const actionSettingsList = new Intl.ListFormat("en", {
		style: "long",
		type: "conjunction",
	}).format(searchActionSettingsPreserved);
	const lastSearchFieldRemovalDescription = [
		"The Search screen will be removed.",
		opensResultsAutomatically
			? "People will go straight to Results, using Cases available."
			: "People can browse Results without searching first.",
		searchScreenSettingsRemoved.length > 0
			? `The ${settingsList} will also be removed.`
			: undefined,
		searchActionSettingsPreserved.length > 0
			? `Your ${actionSettingsList} will stay in More settings.`
			: undefined,
		"Cases available and the Results layout won't change.",
		preservesAssignedCaseRule
			? "The assigned cases setting won't change."
			: undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" ");
	return (
		<>
			<SearchInputEditor
				value={input}
				index={index}
				siblings={siblings}
				caseTypes={caseTypes}
				userProperties={userProperties}
				currentCaseType={currentCaseType}
				onChange={onChange}
				onEditCondition={onEditCondition}
			/>
			<div ref={removeRegionRef}>
				<RemoveRow label="Remove search field" onClick={remove} />
			</div>
			<AlertDialog
				open={removalReviewOpen && removalDependencies.length > 0}
				onOpenChange={(open) => {
					if (!open && !navigatingReviewRef.current) {
						onCancelRemovalReview();
					}
				}}
			>
				<AlertDialogContent
					finalFocus={() => {
						if (navigatingReviewRef.current) {
							navigatingReviewRef.current = false;
							return false;
						}
						return removeTriggerRef.current;
					}}
					className="text-left"
				>
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display tracking-tighter">
							This field is used in other rules
						</AlertDialogTitle>
						<AlertDialogDescription>
							Open each rule or form field and remove or replace {inputLabel}'s
							answer. Then you can remove the field.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogBody>
						<ul aria-label={`Rules using ${inputLabel}`} className="grid gap-2">
							{removalDependencies.map((dependency) => (
								<li
									key={`${dependency.kind}:${
										dependency.kind === "search-field-condition"
											? `${dependency.inputUuid}:${dependency.slot}`
											: dependency.kind === "form-field"
												? dependency.fieldUuid
												: "results"
									}:${
										dependency.kind === "form-field"
											? dependency.uses
											: JSON.stringify(dependency.paths)
									}`}
								>
									<Button
										type="button"
										variant="outline"
										onClick={() => {
											navigatingReviewRef.current = true;
											onReviewRemovalDependency(dependency);
										}}
										className="h-auto min-h-11 w-full justify-between gap-3 border-white/[0.08] bg-white/[0.025] px-3 py-2.5 text-left text-[14px]"
									>
										<span className="min-w-0 flex-1 break-words font-medium text-nova-text">
											<span className="block">{dependency.label}</span>
											<span className="mt-0.5 block text-[12px] font-normal text-nova-text-muted">
												{searchInputDependencyUses(dependency) === 1
													? "Uses this answer once"
													: `Uses this answer in ${searchInputDependencyUses(dependency)} places`}
											</span>
										</span>
										<span className="shrink-0 font-medium text-nova-violet-bright">
											Review
										</span>
									</Button>
								</li>
							))}
						</ul>
					</AlertDialogBody>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={onCancelRemovalReview}>
							Keep field
						</AlertDialogCancel>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<AlertDialog open={confirming} onOpenChange={setConfirming}>
				<AlertDialogContent
					finalFocus={() => removeTriggerRef.current}
					className="text-left"
				>
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display tracking-tighter">
							Remove the last Search field?
						</AlertDialogTitle>
						<AlertDialogDescription>
							{lastSearchFieldRemovalDescription}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={onRemove}>
							Remove field
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

// ── Tabs ──────────────────────────────────────────────────────────

interface WorkspaceTabsProps {
	readonly tab: CaseListWorkspaceTab;
	readonly errorAreas: CaseListConfigErrorAreas;
	readonly onSelectTab: (next: CaseListWorkspaceTab) => void;
	/** Bare case-list modules have no separate module screen. Their one settings
	 *  action shares the existing tab row instead of creating another header. */
	readonly moduleSettings?: ReactNode;
	/** Compact fixed chrome for unusually short windows. The body remains the
	 *  only scroller and receives real height instead of collapsing to zero. */
	readonly compactHeight?: boolean;
}

const TAB_DEFS: ReadonlyArray<{
	id: CaseListWorkspaceTab;
	icon: IconifyIcon;
	/** Concise visible label: the workspace is commonly only ~560px wide. */
	label: string;
	/** Full accessible name + tooltip copy. */
	accessibleLabel: string;
}> = [
	{
		id: "search",
		icon: tablerSearch,
		label: "Search",
		accessibleLabel: "Search",
	},
	{
		id: "list",
		icon: tablerListDetails,
		label: "Results",
		accessibleLabel: "Results",
	},
	{
		id: "detail",
		icon: tablerId,
		label: "Details",
		accessibleLabel: "Details",
	},
];

/**
 * Peer config tabs: no numbering, no implied order. The run-through
 * lives behind the chrome's global Preview toggle, so the strip is
 * pure workbench navigation.
 */
export function WorkspaceTabs({
	tab,
	errorAreas,
	onSelectTab,
	moduleSettings,
	compactHeight = false,
}: WorkspaceTabsProps) {
	const canEdit = useCanEdit();
	/* The canvas narrows when the inspector docks (and again with both
	 * sidebars open), so the concise Search / Results / Details labels must
	 * remain visible. Below the `sm` container boundary, spacing tightens and
	 * the decorative icons step away; the text stays intact and the buttons keep
	 * their full accessible names. The
	 * bar spans the column; its contents use the same `3xl`
	 * frame as the composition canvases so navigation and content share a
	 * calm, consistent width when either sidebar collapses. */
	return (
		<div
			data-case-workspace-tabs
			data-compact-height={compactHeight || undefined}
			className={`relative z-raised shrink-0 border-b border-nova-border bg-pv-bg ${
				compactHeight ? "py-1" : "py-2.5"
			}`}
		>
			<ContentFrame width="3xl" className="px-3 @sm:px-6">
				<div className="flex min-w-0 items-center gap-2">
					<nav
						aria-label="Case workspace screens"
						className="flex min-w-0 flex-1 items-center gap-1 @sm:gap-1.5 @2xl:gap-2"
					>
						{TAB_DEFS.map(({ id, icon, label, accessibleLabel }) => {
							const active = tab === id;
							const hasErrors = errorAreas[id];
							const accessibleName = `${accessibleLabel}${
								hasErrors ? ", needs attention" : ""
							}`;
							return (
								<SimpleTooltip
									key={id}
									content={
										hasErrors
											? canEdit
												? `Open ${accessibleLabel} to fix it`
												: `${accessibleLabel} needs attention`
											: accessibleLabel
									}
									side="bottom"
								>
									{/* A tab holds a state rather than performing an action, so
									 *  it wears the shared selected treatment the App setup strip
									 *  and the sidebar destinations wear: one skin, three
									 *  geometries. Drawn as a ghost Button it inherited ghost's
									 *  neutral hover, which REPLACES a selected tab's violet wash
									 *  with a flat grey, so pointing at the tab you are already on
									 *  read as dimming it. */}
									<button
										type="button"
										aria-label={accessibleName}
										aria-current={active ? "page" : undefined}
										onClick={() => onSelectTab(id)}
										className={`relative flex-1 gap-1 @sm:gap-2 ${selectableSegmentCls(active)}`}
									>
										{hasErrors && (
											<span
												className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-nova-rose"
												aria-hidden="true"
											/>
										)}
										<Icon
											icon={icon}
											width="17"
											height="17"
											className={`hidden shrink-0 @sm:block ${
												active ? "" : "text-nova-text-muted"
											}`}
										/>
										{/* Grid stacks the visible label over an invisible bold
										 *  ghost, so the slot is always as wide as the selected
										 *  form: choosing a tab must never nudge its neighbors. */}
										<span className="grid min-w-0 leading-tight">
											<span className="col-start-1 row-start-1 truncate">
												{label}
											</span>
											<span
												aria-hidden="true"
												className="invisible col-start-1 row-start-1 font-medium"
											>
												{label}
											</span>
										</span>
									</button>
								</SimpleTooltip>
							);
						})}
					</nav>
					{moduleSettings}
				</div>
			</ContentFrame>
		</div>
	);
}
