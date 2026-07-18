// components/builder/case-list-config/CaseListConfigWorkspace.tsx
//
// The unified case-list authoring workspace — three focused config tabs
// (Search / Results / Details). Each canvas is a direct composition surface:
// drag the visible rows where workers will see them, add information
// in place, and compose the default case ordering as a readable sentence.
// Selecting one item opens its data source and formatting in the right rail.
// The tab IS the URL (`/search`, `/results`, `/details`), so tab switches are ordinary
// history navigation and deep links land on the right canvas. The
// run-through lives behind the chrome's global Preview toggle —
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
import { EditableTitle } from "@/components/builder/EditableTitle";
import { InspectorSurface } from "@/components/builder/inspector/InspectorSurface";
import { RemoveRow } from "@/components/builder/inspector/inspectorChrome";
import {
	AlertDialog,
	AlertDialogAction,
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
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useCaseWorkspaceBoundaryVerdicts } from "@/lib/doc/hooks/useCaseWorkspaceVerdicts";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { appendOrderKey } from "@/lib/doc/order/append";
import type { ColumnSurface } from "@/lib/doc/order/columnSurface";
import { bySortKey } from "@/lib/doc/order/compare";
import { searchInputUpdateMutation } from "@/lib/doc/searchInputMutations";
import type { Mutation, Uuid } from "@/lib/doc/types";
import {
	type CaseListConfig,
	type CaseProperty,
	type CaseSearchConfig,
	type Column,
	type CommitOutcome,
	caseSearchConfigAfterFinalInputRemoval,
	DEFAULT_CASE_SEARCH_TITLE,
	effectiveCaseSearchConfig,
	isOwnerOnlyCaseSearchConfig,
	normalizeOwnerOnlyCaseSearchConfig,
	type SearchInputDef,
} from "@/lib/domain";
import {
	effectiveFilterForEmission,
	type Predicate,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { useNavigate } from "@/lib/routing/hooks";
import { useAppId, useCanEdit } from "@/lib/session/hooks";
import { useIsBreakpoint } from "@/lib/ui/hooks/useIsBreakpoint";
import { useKeyboardShortcuts } from "@/lib/ui/hooks/useKeyboardShortcuts";
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
import { SearchPanelInspectorBody } from "./inspector/SearchPanelInspectorBody";
import { withPreservedIdentity } from "./preserveIdentity";
import {
	type SearchInputRemovalDependency,
	searchInputRemovalDependencies,
} from "./searchInputRemovalDependencies";
import { searchInputDecls } from "./searchInputResolution";
import {
	labelFromProperty,
	seedCalculatedColumn,
	seedColumnForProperty,
	seededColumnAddMutation,
	seedSearchInputForProperty,
} from "./seeds";
import {
	projectCaseWorkspaceColumns,
	pruneStoppedSortOrphans,
	removeColumnFromDisplay,
	showColumnOnDisplay,
} from "./workspaceProjection";
import type { WorkspaceSelection } from "./workspaceSelection";

// ── Public types ──────────────────────────────────────────────────

/** Which canvas is showing — derived from the URL location kind. */
export type CaseListWorkspaceTab = "search" | "list" | "detail";

export interface CaseListConfigWorkspaceProps {
	/** The module whose case list is being authored. */
	readonly moduleUuid: Uuid;
	readonly tab: CaseListWorkspaceTab;
}

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
				selection.reveal?.surface ??
				(activeTab === "list" || activeTab === "detail" ? activeTab : null);
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
 *  still absent — first edit persists the seeded shape. */
const EMPTY_CONFIG: CaseListConfig = { columns: [], searchInputs: [] };

/** Stable no-case-type verdicts — a fresh object per render would
 *  defeat the canvases' memoization. */
const EMPTY_VERDICTS = {
	errorAreas: { search: false, list: false, detail: false },
	brokenColumns: new Set<string>(),
	filterBroken: false,
	searchButtonConditionBroken: false,
	excludedOwnerIdsBroken: false,
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
	if (config === undefined) return [];
	return (Object.keys(SEARCH_SCREEN_SETTING_LABELS) as SearchScreenSettingKey[])
		.filter((key) => config[key] !== undefined)
		.map((key) => SEARCH_SCREEN_SETTING_LABELS[key]);
}

function authoredSearchActionSettings(
	config: CaseSearchConfig | undefined,
): readonly string[] {
	if (config === undefined) return [];
	return (Object.keys(SEARCH_ACTION_SETTING_LABELS) as SearchActionSettingKey[])
		.filter((key) => config[key] !== undefined)
		.map((key) => SEARCH_ACTION_SETTING_LABELS[key]);
}

/**
 * Removing the final field removes the visible Search screen. Screen title and
 * subtitle no longer have a surface, but the action label/availability rule
 * still governs CommCare's zero-input Search action (including web auto-launch
 * when Cases available narrows the list), so those settings must survive.
 * Assigned-case behavior remains independent as well.
 */
export function caseSearchConfigAfterFinalFieldRemoval(
	config: CaseSearchConfig | undefined,
	hasCasesAvailableCondition: boolean,
): CaseSearchConfig | undefined {
	return caseSearchConfigAfterFinalInputRemoval(
		config,
		hasCasesAvailableCondition,
	);
}

/** Append to the active surface's resolved sequence, including legacy columns
 * that still use the shared `order` fallback. */
function appendSurfaceOrderKey(
	columns: readonly Column[],
	surface: ColumnSurface,
): string {
	const visible = columns.filter((column) =>
		surface === "list"
			? column.visibleInList !== false
			: column.visibleInDetail !== false,
	);
	return appendOrderKey(
		visible.map((column) => ({
			uuid: column.uuid,
			order:
				surface === "list"
					? (column.listOrder ?? column.order)
					: (column.detailOrder ?? column.order),
		})),
	);
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

function surfaceDisplayName(surface: ColumnSurface): "Results" | "Details" {
	return surface === "list" ? "Results" : "Details";
}

/** Module identity for a bare case-list module, whose workspace is its home. */
export function CaseListModuleHeader({
	moduleUuid,
	name,
	onSave,
	compact = false,
}: {
	readonly moduleUuid: Uuid;
	readonly name: string;
	readonly onSave: (name: string) => CommitOutcome | undefined;
	/** A short viewport already names the module in the breadcrumb. Keep only
	 *  its settings action in the fixed tab bar so the canvas remains usable. */
	readonly compact?: boolean;
}) {
	if (compact) {
		return (
			<div
				data-case-list-module-header="compact"
				className="absolute top-1 right-3 z-raised size-11 @sm:right-6"
			>
				<ModuleSettingsButton moduleUuid={moduleUuid} />
			</div>
		);
	}

	return (
		<div
			data-case-list-module-header="full"
			className="mb-3 flex min-w-0 items-start gap-2 border-b border-nova-border/60 pb-3"
		>
			<EditableTitle
				value={name}
				onSave={onSave}
				wrap
				ariaLabel="Module name"
			/>
			<span className="shrink-0">
				<ModuleSettingsButton moduleUuid={moduleUuid} />
			</span>
		</div>
	);
}

// ── Top-level component ───────────────────────────────────────────

export function CaseListConfigWorkspace({
	moduleUuid,
	tab,
}: CaseListConfigWorkspaceProps) {
	/* WorkspaceBody is intentionally keyed by module identity, but scroll is
	 * friendlier when returning to a module. Keep this ephemeral map one level
	 * above the keyed body; same-module tab switches are preserved by Activity,
	 * while these offsets bridge a module unmount/remount. */
	const scrollPositions = useRef(new Map<string, number>());
	/* Key the body by module so selection state can't leak across
	 * modules — the Activity boundary keeps ONE workspace instance
	 * alive while the URL's module changes under it. */
	return (
		<WorkspaceBody
			key={moduleUuid}
			moduleUuid={moduleUuid}
			tab={tab}
			scrollPositions={scrollPositions}
		/>
	);
}

interface WorkspaceBodyProps extends CaseListConfigWorkspaceProps {
	readonly scrollPositions: { readonly current: Map<string, number> };
}

function WorkspaceBody({
	moduleUuid,
	tab,
	scrollPositions,
}: WorkspaceBodyProps) {
	const mod = useModule(moduleUuid);
	/* The EFFECTIVE view — the same property admission set + types the
	 * commit gate validates against (see the hook doc). */
	const caseTypes = useEffectiveCaseTypes();
	const appId = useAppId() ?? "";
	const compactHeight = useIsBreakpoint("max", 360, "height");
	const navigate = useNavigate();
	const { moveColumnOnSurface, moveSearchInputToIndex, commitMany, inline } =
		useBlueprintMutations();

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
	const pendingCanvasFocusRef = useRef<ColumnSurface | null>(null);
	const pendingSearchFocusRef = useRef<SearchInputDef["uuid"] | "add" | null>(
		null,
	);
	const [inputRemovalReview, setInputRemovalReview] =
		useState<SearchInputRemovalReviewSession | null>(null);
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
	useLayoutEffect(() => {
		if (
			sel?.type === "search-condition" ||
			pendingSearchOverviewScrollRef.current === null
		) {
			return;
		}
		const scroller = document.querySelector<HTMLElement>(
			'[data-case-workspace-scroll-body="search"]',
		);
		if (scroller === null) return;
		scroller.scrollTop = pendingSearchOverviewScrollRef.current;
		pendingSearchOverviewScrollRef.current = null;
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
					?.querySelector<HTMLButtonElement>("[data-search-condition-origin]")
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
	const scrollBodyRefs = useMemo(() => {
		const bind =
			(kind: CaseListWorkspaceTab) => (node: HTMLDivElement | null) => {
				if (node === null) return;
				const key = `${moduleUuid}:${kind}`;
				node.scrollTop = scrollPositions.current.get(key) ?? 0;
				return () => {
					scrollPositions.current.set(key, node.scrollTop);
				};
			};
		return {
			search: bind("search"),
			list: bind("list"),
			detail: bind("detail"),
		};
	}, [moduleUuid, scrollPositions]);
	const rememberScroll = useCallback(
		(kind: CaseListWorkspaceTab, scrollTop: number) => {
			scrollPositions.current.set(`${moduleUuid}:${kind}`, scrollTop);
		},
		[moduleUuid, scrollPositions],
	);

	/* Tab switches deselect — covers in-app tab clicks AND browser
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
			if (input?.kind === "advanced") return;
			leaveSearchCondition(
				input === undefined ? null : { type: "input", uuid: input.uuid },
			);
			return;
		}
		if (searchConfig?.searchButtonDisplayCondition === undefined) {
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
	 * manager (not a raw listener — the manager preventDefaults every
	 * matched key, and later registrations win) so it layers over the
	 * builder-layout shortcuts and stays quiet while an input or
	 * CodeMirror editor has focus. Registered only while something is
	 * selected so a bare Escape still reaches the layout-level handler. */
	useKeyboardShortcuts(
		"case-list-workspace",
		useMemo(
			() =>
				sel !== null
					? [{ key: "Escape", handler: closeSelectionAndRestoreFocus }]
					: [],
			[sel, closeSelectionAndRestoreFocus],
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
	} = useMemo(
		() =>
			caseType !== undefined
				? caseListConfigVerdicts(config, caseTypes, caseType, {
						caseSearchEnabled: effectiveSearchConfig !== undefined,
						boundary: boundaryVerdicts,
					})
				: EMPTY_VERDICTS,
		[boundaryVerdicts, config, caseTypes, caseType, effectiveSearchConfig],
	);

	// ── Mutators ──

	const updateSearchConfig = useCallback(
		(next: CaseSearchConfig) => {
			// Reaching Search settings is explicit action authoring. Clear the
			// owner-only provenance bit while preserving every real setting.
			const { searchActionEnabled: _previousIntent, ...enabled } = next;
			commitMany(
				caseSearchConfigPatchMutations(moduleUuid, searchConfig, enabled),
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
					const base =
						searchConfig === undefined
							? ({ searchActionEnabled: false } as const)
							: normalizeOwnerOnlyCaseSearchConfig(searchConfig);
					commitMany([
						setOwnerOnlyCaseSearchMutation(moduleUuid, {
							...base,
							excludedOwnerIds: next,
						}),
					]);
					return;
				}
				commitMany(
					caseSearchConfigPatchMutations(moduleUuid, searchConfig, {
						...searchConfig,
						excludedOwnerIds: next,
					}),
				);
				return;
			}
			if (searchConfig === undefined) return;
			if (isOwnerOnlyCaseSearchConfig(searchConfig)) {
				commitMany(
					clearCaseSearchConfigSettingsMutations(moduleUuid, searchConfig),
				);
				return;
			}
			const { excludedOwnerIds: _previous, ...rest } = searchConfig;
			commitMany(
				caseSearchConfigPatchMutations(moduleUuid, searchConfig, rest),
			);
		},
		[commitMany, moduleUuid, searchConfig],
	);
	const configureSearchAction = useCallback(() => {
		const outcome = commitMany([
			enableCaseSearchMutation(moduleUuid, searchConfig),
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

	/* Rename — only surfaced for a `caseListOnly` module, where this
	 * workspace IS the module's home (no module screen to carry the title).
	 * Forward the gated outcome so a refused rename keeps the draft + finding
	 * inline, exactly like the module screen's title. */
	const saveModuleName = useCallback(
		(name: string) => inline.updateModule(moduleUuid, { name }),
		[inline, moduleUuid],
	);

	const ct = caseTypes.find((c) => c.name === caseType);
	const addDisabledReason =
		(ct?.properties.length ?? 0) === 0 ? PROPERTYLESS_HINT : undefined;

	const routeColumnToRepair = (
		surface: ColumnSurface,
		column: Column,
		messages: readonly string[] = [],
	) => {
		setWorkspaceAnnouncement(
			`${columnDisplayLabel(column)} needs more setup before it can be added to ${surfaceDisplayName(surface)}`,
		);
		setSel({
			type: "column",
			uuid: column.uuid,
			reveal: { surface, messages },
		});
	};

	const replaceColumn = (uuid: string, next: Column) => {
		// Carry identity and all display-order keys forward — see
		// `withPreservedIdentity`.
		const current = config.columns.find((column) => column.uuid === uuid);
		if (current === undefined) return;
		const replacement = withPreservedIdentity(current, next);
		const repair =
			sel?.type === "column" && sel.uuid === uuid ? sel.reveal : undefined;
		if (repair === undefined) {
			commitMany(columnSnapshotMutations(moduleUuid, current, replacement));
			return;
		}

		/* The author arrived here by asking to add saved information. Try the
		 * repair and reveal as ONE gated edit; when it is ready, the requested
		 * field appears without another confirmation click or a half-valid
		 * intermediate state. If more repair remains, preserve the safe hidden
		 * edit and keep the inspector open with the fresh gate guidance. */
		const repairedColumns = config.columns.map((column) =>
			column.uuid === uuid ? replacement : column,
		);
		const order = appendSurfaceOrderKey(repairedColumns, repair.surface);
		const revealed = showColumnOnDisplay(
			repairedColumns,
			replacement.uuid,
			repair.surface,
			order,
		).find((column) => column.uuid === replacement.uuid);
		if (revealed === undefined) return;
		const revealOutcome = inline.commitMany(
			columnSnapshotMutations(moduleUuid, current, revealed),
		);
		if (revealOutcome.ok) {
			setWorkspaceAnnouncement(
				`${columnDisplayLabel(replacement)} added to ${surfaceDisplayName(repair.surface)}`,
			);
			setSel({ type: "column", uuid: replacement.uuid });
			return;
		}

		const repairOutcome = inline.commitMany(
			columnSnapshotMutations(moduleUuid, current, replacement),
		);
		setSel({
			type: "column",
			uuid: replacement.uuid,
			reveal: {
				surface: repair.surface,
				messages:
					revealOutcome.messages.length > 0
						? revealOutcome.messages
						: repairOutcome.ok
							? repair.messages
							: repairOutcome.messages,
			},
		});
	};
	const addSeededColumn = (surface: ColumnSurface, seed: Column) => {
		const mutation = seededColumnAddMutation(moduleUuid, config, surface, seed);
		const outcome = commitMany([mutation]);
		if (outcome.ok) {
			setWorkspaceAnnouncement(
				`${columnDisplayLabel(seed)} added to ${surfaceDisplayName(surface)}`,
			);
			setSel({ type: "column", uuid: seed.uuid });
		}
	};
	const addColumn = (surface: ColumnSurface, property: CaseProperty) => {
		// The center-canvas chooser owns the property decision. Creation only
		// turns that explicit choice into a working display definition; it never
		// advances through system properties behind the author's back.
		addSeededColumn(
			surface,
			seedColumnForProperty(
				property,
				surface === "list"
					? { visibleInDetail: false }
					: { visibleInList: false },
			),
		);
	};
	const addCalculatedColumn = (surface: ColumnSurface) => {
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
		surface: ColumnSurface,
		uuid: Column["uuid"],
		toIndex: number,
	) => moveColumnOnSurface(moduleUuid, uuid, surface, toIndex);
	const updateColumns = (next: readonly Column[]) => {
		commitMany(
			columnSnapshotBatchMutations(
				moduleUuid,
				config.columns,
				pruneStoppedSortOrphans(config.columns, next),
			),
		);
	};
	const hideColumnFromSurface = (surface: ColumnSurface, column: Column) => {
		const visible = projectCaseWorkspaceColumns(config.columns);
		if (surface === "list" && visible.listVisible.length <= 1) return;
		const label = columnDisplayLabel(column);
		const hidden = removeColumnFromDisplay(
			config.columns,
			column.uuid,
			surface,
		).find((candidate) => candidate.uuid === column.uuid);
		if (hidden === undefined) return;
		const outcome = commitMany(
			columnSnapshotMutations(moduleUuid, column, hidden),
		);
		if (!outcome.ok) return;
		pendingCanvasFocusRef.current = surface;
		setWorkspaceAnnouncement(
			`${label} hidden from ${surfaceDisplayName(surface)}. You can add it again from Add information.`,
		);
		deselect();
	};
	const deleteColumn = (surface: ColumnSurface, column: Column) => {
		const displayedOn = [
			...(column.visibleInList !== false ? ["Results"] : []),
			...(column.visibleInDetail !== false ? ["Details"] : []),
		];
		const outcome = commitMany([
			{ kind: "removeColumn", moduleUuid, uuid: column.uuid },
		]);
		if (!outcome.ok) return;
		pendingCanvasFocusRef.current = surface;
		setWorkspaceAnnouncement(
			`${columnDisplayLabel(column)} removed${displayedOn.length === 0 ? "" : ` from ${displayedOn.join(" and ")}`}. Saved case data wasn’t deleted.`,
		);
		deselect();
	};
	const showColumn = (surface: ColumnSurface, column: Column) => {
		/* A definition already known to need attention never touches the gate.
		 * Open its source/formatting controls while it remains off-screen. */
		if (brokenColumns.has(column.uuid)) {
			routeColumnToRepair(surface, column);
			return;
		}
		const order = appendSurfaceOrderKey(config.columns, surface);
		const shown = showColumnOnDisplay(
			config.columns,
			column.uuid,
			surface,
			order,
		).find((candidate) => candidate.uuid === column.uuid);
		if (shown === undefined) return;
		/* Fully hidden legacy definitions are deliberately absent from normal
		 * config warnings. Ask the SAME gate silently before revealing one: a
		 * refusal becomes a repair route, never a toast plus a dead click. */
		const outcome = inline.commitMany(
			columnSnapshotMutations(moduleUuid, column, shown),
		);
		if (!outcome.ok) {
			routeColumnToRepair(surface, column, outcome.messages);
			return;
		}
		setWorkspaceAnnouncement(
			`${columnDisplayLabel(column)} added to ${surfaceDisplayName(surface)}`,
		);
		setSel({ type: "column", uuid: column.uuid });
	};

	const replaceInput = (uuid: string, next: SearchInputDef) => {
		// Carry the existing identity + display order forward.
		const current = config.searchInputs.find((input) => input.uuid === uuid);
		if (current === undefined) return;
		commitMany([
			searchInputUpdateMutation(
				moduleUuid,
				current,
				withPreservedIdentity(current, next),
			),
		]);
	};
	const removeInput = (uuid: SearchInputDef["uuid"]) => {
		const orderedInputs = [...config.searchInputs].sort(bySortKey);
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
			? caseSearchConfigAfterFinalFieldRemoval(
					searchConfig,
					hasCasesAvailableCondition,
				)
			: searchConfig;
		const mutations: Mutation[] = [
			{ kind: "removeSearchInput", moduleUuid, uuid },
		];
		if (removesVisibleSearchScreen && searchConfig !== undefined) {
			mutations.push(
				cleanupCaseSearchAfterFinalInputMutation({
					uuid: moduleUuid,
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
					nextSearchConfig.searchActionEnabled !== false
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
				openSearchCondition({ kind: "input", uuid: dependency.inputUuid });
				return;
			}
			deselect();
			navigate.openCaseList(moduleUuid);
		},
		[deselect, inputRemovalReview, moduleUuid, navigate, openSearchCondition],
	);
	const returnToInputRemovalReview = useCallback(() => {
		if (inputRemovalReview?.phase !== "target") return;
		const remaining = searchInputRemovalDependencies(
			config,
			searchConfig,
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
			navigate.openSearchConfig(moduleUuid);
		}
	}, [
		config,
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
		const seed = seedSearchInputForProperty(config, property);
		const seeded = { ...seed, order: appendOrderKey(config.searchInputs) };
		const outcome = commitMany([
			enableCaseSearchMutation(moduleUuid, searchConfig),
			{ kind: "addSearchInput", moduleUuid, searchInput: seeded },
		]);
		// Never select an identity the gate refused to create. The gate can still
		// reject a concurrent structural edit even though the seed was valid when
		// this interaction began.
		if (outcome.ok) setSel({ type: "input", uuid: seeded.uuid });
	};
	const moveInput = (uuid: SearchInputDef["uuid"], toIndex: number) =>
		moveSearchInputToIndex(moduleUuid, uuid, toIndex);
	const clearFilter = useCallback(
		(nextFilter: Predicate | undefined) => {
			const mutations: Mutation[] = [
				{
					kind: "setCaseListMeta",
					uuid: moduleUuid,
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
					uuid: moduleUuid,
					patch: { filter: nextFilter ?? null },
				},
			]),
		[commitMany, moduleUuid],
	);

	// `currentCaseType` is required below. When the module has no case
	// type this URL shouldn't surface — guard defensively so a
	// deletion-in-flight URL doesn't crash.
	if (!mod || caseType === undefined) return null;

	// ── Inspector resolution ──

	const inspector = resolveInspector({
		sel,
		activeTab: tab,
		config,
		searchConfig,
		caseTypes,
		caseType,
		onSearchConfigChange: updateSearchConfig,
		replaceColumn,
		replaceInput,
		onEditInputCondition: (uuid) =>
			openSearchCondition({ kind: "input", uuid }),
		onEditSearchButtonCondition: editSearchButtonCondition,
		searchSettingsHasError: searchButtonConditionBroken,
		onHideColumn: hideColumnFromSurface,
		onDeleteColumn: deleteColumn,
		onRemoveInput: removeInput,
		inputRemovalReview,
		onStartInputRemovalReview: startInputRemovalReview,
		onCancelInputRemovalReview: cancelInputRemovalReview,
		onCompleteInputRemovalReview: completeInputRemovalReview,
		onReviewInputRemovalDependency: reviewInputRemovalDependency,
	});

	/* A `caseListOnly` module has no module screen (it would be an empty form
	 * menu), so this workspace is its only home — carry the module identity
	 * (rename + settings: case type and both appearance surfaces) in the fixed
	 * header, reusing the same controls the module screen mounts. Form-bearing
	 * modules keep their identity on the module screen, so no header here. */
	const moduleHeader: ReactNode = mod.caseListOnly ? (
		<CaseListModuleHeader
			moduleUuid={moduleUuid}
			name={mod.name}
			onSave={saveModuleName}
			compact={compactHeight}
		/>
	) : null;

	let searchConditionSurface: ReactNode = null;
	if (sel?.type === "search-condition") {
		if (sel.target.kind === "input") {
			const inputUuid = sel.target.uuid;
			const input = config.searchInputs.find(
				(candidate) => candidate.uuid === inputUuid,
			);
			if (input?.kind === "advanced") {
				const dependencyReview =
					inputRemovalReview?.phase === "target" &&
					inputRemovalReview.dependency.kind === "search-field-condition" &&
					inputRemovalReview.dependency.inputUuid === input.uuid
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
							label:
								input.label ||
								labelFromProperty(input.name) ||
								"this search field",
						}}
						value={input.predicate}
						onChange={(predicate) =>
							replaceInput(input.uuid, { ...input, predicate })
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
						currentCaseType={caseType}
						knownInputs={searchInputDecls(config.searchInputs)}
						dependencyReview={dependencyReview}
					/>
				);
			}
		} else if (searchConfig?.searchButtonDisplayCondition !== undefined) {
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
					currentCaseType={caseType}
					focusRequest={searchButtonConditionFocusRequest}
				/>
			);
		}
	}
	let resultsDependencyReview: CaseListCanvasProps["dependencyReview"];
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

	return (
		<div className="case-list-workspace @container flex h-full min-h-0 flex-col overflow-hidden">
			<p
				className="sr-only"
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				{workspaceAnnouncement}
			</p>
			<WorkspaceTabs
				header={moduleHeader}
				compactHeight={compactHeight}
				tab={tab}
				errorAreas={errorAreas}
				onSelectTab={(next) => {
					/* Tabs are no-ops when already active. */
					if (next === tab) return;
					if (next === "search") navigate.openSearchConfig(moduleUuid);
					else if (next === "list") navigate.openCaseList(moduleUuid);
					else navigate.openDetailConfig(moduleUuid);
				}}
			/>

			{/* Each tab keeps its own body scroller mounted. The strip above is a
			 * fixed flex sibling, so it cannot drift before "sticking" and each
			 * canvas naturally remembers its own scroll position on return. Do not
			 * use data-preview-scroll-container here: that selector belongs to the
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
								addInputDisabledReason={addDisabledReason}
								hasSearchSurface={config.searchInputs.length > 0}
								hasSearchAction={effectiveSearchConfig !== undefined}
								opensResultsAutomatically={opensResultsAutomatically}
								onMoveInput={moveInput}
								searchSettingsHasError={searchButtonConditionBroken}
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
							brokenColumns={brokenColumns}
							selection={sel}
							onSelect={setSel}
							onAddColumn={(property) => addColumn("list", property)}
							onAddCalculated={() => addCalculatedColumn("list")}
							addColumnDisabledReason={addDisabledReason}
							onMoveColumn={(uuid, toIndex) =>
								moveColumn("list", uuid, toIndex)
							}
							onColumnsChange={updateColumns}
							onShowColumn={(column) => showColumn("list", column)}
							onRepairColumn={(column) => routeColumnToRepair("list", column)}
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
							onRepairColumn={(column) => routeColumnToRepair("detail", column)}
						/>
					</div>
				</Activity>
			</div>

			{inspector !== null && (
				<InspectorSurface
					kicker={inspector.kicker}
					title={inspector.title}
					onClose={closeSelectionAndRestoreFocus}
				>
					{inspector.body}
				</InspectorSurface>
			)}
		</div>
	);
}

// ── Inspector resolution ──────────────────────────────────────────

interface ResolveInspectorArgs {
	readonly sel: WorkspaceSelection | null;
	readonly activeTab: CaseListWorkspaceTab;
	readonly config: CaseListConfig;
	readonly searchConfig: CaseSearchConfig | undefined;
	readonly caseTypes: ReturnType<typeof useEffectiveCaseTypes>;
	readonly caseType: string;
	readonly onSearchConfigChange: (next: CaseSearchConfig) => void;
	readonly replaceColumn: (uuid: string, next: Column) => void;
	readonly replaceInput: (uuid: string, next: SearchInputDef) => void;
	readonly onEditInputCondition: (uuid: SearchInputDef["uuid"]) => void;
	readonly onEditSearchButtonCondition: (focusNewCondition?: boolean) => void;
	readonly searchSettingsHasError: boolean;
	readonly onHideColumn: (surface: ColumnSurface, column: Column) => void;
	readonly onDeleteColumn: (surface: ColumnSurface, column: Column) => void;
	readonly onRemoveInput: (uuid: SearchInputDef["uuid"]) => void;
	readonly inputRemovalReview: SearchInputRemovalReviewSession | null;
	readonly onStartInputRemovalReview: (input: SearchInputDef) => void;
	readonly onCancelInputRemovalReview: () => void;
	readonly onCompleteInputRemovalReview: (inputLabel: string) => void;
	readonly onReviewInputRemovalDependency: (
		dependency: SearchInputRemovalDependency,
	) => void;
}

/**
 * Selection → inspector chrome + body. Returns `null` when nothing is
 * selected OR the selected entity no longer exists (e.g. the agent
 * removed it mid-session) — a dangling selection renders no inspector
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
			const sortedCols = [...config.columns].sort(bySortKey);
			const column = sortedCols.find((c) => c.uuid === sel.uuid);
			if (column === undefined) return null;
			const projection = projectCaseWorkspaceColumns(config.columns);
			const surface =
				sel.reveal?.surface ??
				(args.activeTab === "list"
					? "list"
					: args.activeTab === "detail"
						? "detail"
						: null);
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
							surface={surface}
							visibleCount={
								surface === "list"
									? projection.listVisible.length
									: projection.detailVisible.length
							}
							listVisibleCount={projection.listVisible.length}
							caseTypes={args.caseTypes}
							currentCaseType={args.caseType}
							repairMessages={sel.reveal?.messages}
							onChange={(next) => args.replaceColumn(column.uuid, next)}
							onHide={() => args.onHideColumn(surface, column)}
							onDelete={() => args.onDeleteColumn(surface, column)}
						/>
					),
			};
		}
		case "input": {
			// DISPLAY position + DISPLAY-ordered siblings (`sort-by-(order, uuid)`),
			// not array position.
			const sortedInputs = [...config.searchInputs].sort(bySortKey);
			const index = sortedInputs.findIndex((s) => s.uuid === sel.uuid);
			const input = sortedInputs[index];
			if (input === undefined) return null;
			const removalDependencies = searchInputRemovalDependencies(
				config,
				args.searchConfig,
				input.uuid,
			);
			return {
				kicker: "Search field",
				title: input.label || labelFromProperty(input.name) || "Untitled field",
				body: (
					<SearchInputInspectorBody
						input={input}
						index={index}
						siblings={sortedInputs}
						caseTypes={args.caseTypes}
						currentCaseType={args.caseType}
						onChange={(next) => args.replaceInput(input.uuid, next)}
						onEditCondition={() => args.onEditInputCondition(input.uuid)}
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
					? (args.searchConfig?.searchScreenTitle ?? DEFAULT_CASE_SEARCH_TITLE)
					: "Search action",
				body: (
					<SearchPanelInspectorBody
						value={args.searchConfig}
						onChange={args.onSearchConfigChange}
						caseTypes={args.caseTypes}
						currentCaseType={args.caseType}
						knownInputs={config.searchInputs}
						hasVisibleSearchScreen={hasVisibleSearchScreen}
						hasSearchAction={effectiveSearch !== undefined}
						opensResultsAutomatically={opensResultsAutomatically}
						onEditDisplayCondition={args.onEditSearchButtonCondition}
						searchSettingsHasError={args.searchSettingsHasError}
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
	surface,
	visibleCount,
	listVisibleCount,
	caseTypes,
	currentCaseType,
	repairMessages,
	onChange,
	onHide,
	onDelete,
}: {
	readonly column: Column;
	readonly surface: ColumnSurface;
	readonly visibleCount: number;
	readonly listVisibleCount: number;
	readonly caseTypes: ReturnType<typeof useEffectiveCaseTypes>;
	readonly currentCaseType: string;
	/** Defined (including an empty array) while this off-screen definition is
	 * being repaired in response to an Add information request. */
	readonly repairMessages: readonly string[] | undefined;
	readonly onChange: (next: Column) => void;
	readonly onHide: () => void;
	readonly onDelete: () => void;
}) {
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const screenName = surfaceDisplayName(surface);
	const keepLastResult = surface === "list" && visibleCount <= 1;
	const deleteWouldRemoveLastResult =
		column.visibleInList !== false && listVisibleCount <= 1;
	const repairing = repairMessages !== undefined;
	const uniqueRepairMessages = [...new Set(repairMessages ?? [])];
	const displayedOn = [
		...(column.visibleInList !== false ? ["Results"] : []),
		...(column.visibleInDetail !== false ? ["Details"] : []),
	];
	const deleteLocation =
		displayedOn.length === 0
			? "its saved label and formatting"
			: `it from ${displayedOn.join(" and ")}`;
	return (
		<>
			{repairing && (
				<div className="rounded-xl border border-nova-violet/25 bg-nova-violet/[0.06] px-3 py-3 leading-relaxed">
					<p className="text-[14px] font-medium text-nova-text">
						Finish setting up this information
					</p>
					<p className="mt-1 text-[13px] text-nova-text-secondary">
						Choose what it shows and how it appears below. It will be added to{" "}
						{screenName} when it’s ready.
					</p>
					{uniqueRepairMessages.length > 0 && (
						<ul className="mt-2 list-disc space-y-1 pl-4 text-[13px] text-nova-text-muted">
							{uniqueRepairMessages.map((message) => (
								<li key={message}>{message}</li>
							))}
						</ul>
					)}
				</div>
			)}
			<ColumnEditor
				key={column.uuid}
				value={column}
				onChange={onChange}
				caseTypes={caseTypes}
				currentCaseType={currentCaseType}
			/>
			{!repairing && (
				<div className="border-t border-nova-border pt-3">
					<Button
						type="button"
						onClick={onHide}
						disabled={keepLastResult}
						aria-disabled={keepLastResult}
						variant="outline"
						size="xl"
						className={`w-full bg-transparent px-3 text-[14px] dark:bg-transparent ${
							keepLastResult
								? "border-white/[0.04] text-nova-text-muted"
								: "border-white/[0.06] text-nova-text-secondary not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-violet/[0.06] not-disabled:hover:text-nova-text"
						}`}
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
			)}
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
					Deleting this information won’t delete saved case data
				</p>
			)}
			<AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
				<AlertDialogContent className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display">
							Deleting {columnDisplayLabel(column)} removes {deleteLocation}
						</AlertDialogTitle>
						<AlertDialogDescription>
							Saved case data will stay
							{column.sort !== undefined
								? ". This information will also be removed from the default order."
								: ""}
						</AlertDialogDescription>
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
	readonly currentCaseType: string;
	readonly onChange: (next: SearchInputDef) => void;
	readonly onEditCondition: () => void;
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
	return (
		<>
			<SearchInputEditor
				value={input}
				index={index}
				siblings={siblings}
				caseTypes={caseTypes}
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
						<AlertDialogTitle className="font-display">
							Update{" "}
							{removalDependencies.length === 1 ? "this rule" : "these rules"}{" "}
							before removing {inputLabel}
						</AlertDialogTitle>
						<AlertDialogDescription>
							This search field supplies an answer used somewhere else. Remove
							or replace that answer in each rule first.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<ul aria-label={`Rules using ${inputLabel}`} className="grid gap-2">
						{removalDependencies.map((dependency) => (
							<li
								key={`${dependency.kind}:${
									dependency.kind === "search-field-condition"
										? dependency.inputUuid
										: "results"
								}:${JSON.stringify(dependency.paths)}`}
							>
								<Button
									type="button"
									variant="outline"
									size="xl"
									onClick={() => {
										navigatingReviewRef.current = true;
										onReviewRemovalDependency(dependency);
									}}
									className="h-auto min-h-11 w-full justify-between gap-3 border-white/[0.08] bg-white/[0.025] px-3 py-2.5 text-left text-[14px]"
								>
									<span className="min-w-0 flex-1 break-words font-medium text-nova-text">
										<span className="block">{dependency.label}</span>
										<span className="mt-0.5 block text-[12px] font-normal text-nova-text-muted">
											{dependency.paths.length === 1
												? "Uses this answer once"
												: `Uses this answer in ${dependency.paths.length} places`}
										</span>
									</span>
									<span className="shrink-0 font-medium text-nova-violet-bright">
										Review
									</span>
								</Button>
							</li>
						))}
					</ul>
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
						<AlertDialogTitle className="font-display">
							Removing this field removes the Search screen
						</AlertDialogTitle>
						<AlertDialogDescription>
							This is the only Search field. After it is removed,
							{opensResultsAutomatically
								? " people will go straight to Results using Cases available."
								: " people can browse the case list without searching first."}
							{searchScreenSettingsRemoved.length > 0
								? ` The ${settingsList} will be removed.`
								: ""}
							{searchActionSettingsPreserved.length > 0
								? ` Your ${actionSettingsList} will stay in More settings.`
								: ""}{" "}
							Cases available and the Results layout will stay the same.
							{preservesAssignedCaseRule
								? " The assigned cases setting doesn’t change."
								: ""}
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
	/** Optional module-identity row rendered above the tabs, inside the same
	 *  fixed workspace header — present only when this workspace is the module's home
	 *  (a `caseListOnly` module). */
	readonly header?: ReactNode;
	/** Compact fixed chrome for unusually short windows. The body remains the
	 *  only scroller and receives real height instead of collapsing to zero. */
	readonly compactHeight?: boolean;
}

const TAB_DEFS: ReadonlyArray<{
	id: CaseListWorkspaceTab;
	icon: IconifyIcon;
	/** Concise visible label — the workspace is commonly only ~560px wide. */
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
 * Peer config tabs — no numbering, no implied order. The run-through
 * lives behind the chrome's global Preview toggle, so the strip is
 * pure workbench navigation.
 */
export function WorkspaceTabs({
	tab,
	errorAreas,
	onSelectTab,
	header,
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
				{header}
				<nav
					aria-label="Case workspace screens"
					className={`flex items-center gap-1 @sm:gap-1.5 @2xl:gap-2 ${
						compactHeight && header ? "pr-12 @sm:pr-14" : ""
					}`}
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
								<Button
									type="button"
									aria-label={accessibleName}
									aria-current={active ? "page" : undefined}
									onClick={() => onSelectTab(id)}
									variant="ghost"
									size="xl"
									className={`relative min-w-0 flex-1 gap-1 border px-1.5 py-1.5 text-left @sm:gap-2 @sm:px-2 @2xl:px-3.5 ${
										active
											? "bg-nova-violet/[0.13] border-nova-border-bright"
											: "border-transparent not-disabled:hover:bg-white/[0.03]"
									}`}
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
											active
												? "text-nova-violet-bright"
												: "text-nova-text-muted"
										}`}
									/>
									{/* Flex column (not a plain block): a block wrapper carries
									 *  the inherited 16px/24px line-height strut into the label's
									 *  anonymous line box, which pads ~5px of dead space above the
									 *  label and bottom-weights the whole text block. Flex children
									 *  size to their own line-height, so label + meta center as a
									 *  unit against the icon. */}
									<span className="flex min-w-0 flex-col">
										{/* Grid stacks the visible label over an invisible bold
										 *  ghost, so the slot is always as wide as the bold form —
										 *  selecting a tab must never nudge its neighbors. */}
										<span className="grid text-sm leading-tight">
											<span
												className={`col-start-1 row-start-1 ${
													active
														? "font-semibold text-nova-text"
														: "font-medium text-nova-text-secondary"
												}`}
											>
												{label}
											</span>
											<span
												aria-hidden="true"
												className="col-start-1 row-start-1 font-semibold invisible"
											>
												{label}
											</span>
										</span>
									</span>
								</Button>
							</SimpleTooltip>
						);
					})}
				</nav>
			</ContentFrame>
		</div>
	);
}
