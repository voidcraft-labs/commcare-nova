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
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { appendOrderKey } from "@/lib/doc/order/append";
import type { ColumnSurface } from "@/lib/doc/order/columnSurface";
import { bySortKey } from "@/lib/doc/order/compare";
import type { Mutation, Uuid } from "@/lib/doc/types";
import {
	type CaseListConfig,
	type CaseSearchConfig,
	type Column,
	type CommitOutcome,
	caseSearchConfigHasAuthoredSettings,
	DEFAULT_CASE_SEARCH_TITLE,
	type SearchInputDef,
} from "@/lib/domain";
import {
	effectiveFilterForEmission,
	type Predicate,
} from "@/lib/domain/predicate";
import { useNavigate } from "@/lib/routing/hooks";
import { useAppId, useCanEdit } from "@/lib/session/hooks";
import { useKeyboardShortcuts } from "@/lib/ui/hooks/useKeyboardShortcuts";
import { ColumnEditor } from "./ColumnEditor";
import { CaseListCanvas } from "./canvas/CaseListCanvas";
import { DetailCanvas } from "./canvas/DetailCanvas";
import { SearchCanvas } from "./canvas/SearchCanvas";
import {
	type CaseListConfigErrorAreas,
	caseListConfigVerdicts,
} from "./configValidity";
import { FilterInspectorBody } from "./inspector/FilterInspectorBody";
import { ListPanelInspectorBody } from "./inspector/ListPanelInspectorBody";
import { SearchInputEditor } from "./inspector/SearchInputEditor";
import { SearchPanelInspectorBody } from "./inspector/SearchPanelInspectorBody";
import { withPreservedIdentity } from "./preserveIdentity";
import { labelFromProperty, seedColumn, seedSearchInput } from "./seeds";
import { useCaseListPreview } from "./useCaseListPreview";
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

/**
 * Hover hint surfaced on disabled add affordances whose seed depends
 * on a case-property reference.
 */
const PROPERTYLESS_HINT = "Define case-type properties first.";

/** Stable empty config for modules whose `caseListConfig` slot is
 *  still absent — first edit persists the seeded shape. */
const EMPTY_CONFIG: CaseListConfig = { columns: [], searchInputs: [] };

/** Stable no-case-type verdicts — a fresh object per render would
 *  defeat the canvases' memoization. */
const EMPTY_VERDICTS = {
	errorAreas: { search: false, list: false, detail: false },
	brokenColumns: new Set<string>(),
	previewObstacle: null,
} as const;

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

function surfaceDisplayName(surface: ColumnSurface): "results" | "details" {
	return surface === "list" ? "results" : "details";
}

// ── Top-level component ───────────────────────────────────────────

export function CaseListConfigWorkspace({
	moduleUuid,
	tab,
}: CaseListConfigWorkspaceProps) {
	/* Key the body by module so selection state can't leak across
	 * modules — the Activity boundary keeps ONE workspace instance
	 * alive while the URL's module changes under it. */
	return <WorkspaceBody key={moduleUuid} moduleUuid={moduleUuid} tab={tab} />;
}

function WorkspaceBody({ moduleUuid, tab }: CaseListConfigWorkspaceProps) {
	const mod = useModule(moduleUuid);
	/* The EFFECTIVE view — the same property admission set + types the
	 * commit gate validates against (see the hook doc). */
	const caseTypes = useEffectiveCaseTypes();
	const appId = useAppId() ?? "";
	const canEdit = useCanEdit();
	const navigate = useNavigate();
	const {
		updateModule,
		moveColumnOnSurface,
		moveSearchInputToIndex,
		commitMany,
		inline,
	} = useBlueprintMutations();

	const caseType = mod?.caseType;
	const config = mod?.caseListConfig ?? EMPTY_CONFIG;
	const searchConfig = mod?.caseSearchConfig;

	// ── Selection ──
	const [sel, setSel] = useState<WorkspaceSelection | null>(null);
	const [workspaceAnnouncement, setWorkspaceAnnouncement] = useState("");
	const pendingCanvasFocusRef = useRef<ColumnSurface | null>(null);
	const deselect = useCallback(() => setSel(null), []);

	/* Tab switches deselect — covers in-app tab clicks AND browser
	 * back/forward, since both arrive as a `tab` prop change. */
	const prevTabRef = useRef(tab);
	useEffect(() => {
		if (prevTabRef.current === tab) return;
		prevTabRef.current = tab;
		setSel(null);
	}, [tab]);

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

	/* Escape closes the inspector. Routed through the shared keyboard
	 * manager (not a raw listener — the manager preventDefaults every
	 * matched key, and later registrations win) so it layers over the
	 * builder-layout shortcuts and stays quiet while an input or
	 * CodeMirror editor has focus. Registered only while something is
	 * selected so a bare Escape still reaches the layout-level handler. */
	useKeyboardShortcuts(
		"case-list-workspace",
		useMemo(
			() => (sel !== null ? [{ key: "Escape", handler: deselect }] : []),
			[sel, deselect],
		),
	);

	// ── Live preview (one load feeds the list + detail canvases) ──
	// One walk answers the tab dots, the in-canvas marks, and the
	// preview gate (see `configValidity.ts` for what gates what).
	const { errorAreas, brokenColumns, previewObstacle } = useMemo(
		() =>
			caseType !== undefined
				? caseListConfigVerdicts(config, caseTypes, caseType)
				: EMPTY_VERDICTS,
		[config, caseTypes, caseType],
	);
	const { state: preview, fetching: previewFetching } = useCaseListPreview({
		appId,
		caseListConfig: config,
		currentCaseType: caseType ?? "",
		previewObstacle,
	});

	// ── Mutators ──

	const updateConfig = useCallback(
		(next: CaseListConfig) => {
			updateModule(moduleUuid, { caseListConfig: next });
		},
		[updateModule, moduleUuid],
	);
	const updateSearchConfig = useCallback(
		(next: CaseSearchConfig) => {
			updateModule(moduleUuid, { caseSearchConfig: next });
		},
		[updateModule, moduleUuid],
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
			`${columnDisplayLabel(column)} needs a quick fix before it can be added to ${surfaceDisplayName(surface)}.`,
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
		const nextConfig = {
			...config,
			columns: config.columns.map((c) =>
				c.uuid === uuid ? withPreservedIdentity(c, next) : c,
			),
		};
		const repair =
			sel?.type === "column" && sel.uuid === uuid ? sel.reveal : undefined;
		if (repair === undefined) {
			updateConfig(nextConfig);
			return;
		}

		/* The author arrived here by asking to add saved information. Try the
		 * repair and reveal as ONE gated edit; when it is ready, the requested
		 * field appears without another confirmation click or a half-valid
		 * intermediate state. If more repair remains, preserve the safe hidden
		 * edit and keep the inspector open with the fresh gate guidance. */
		const order = appendSurfaceOrderKey(nextConfig.columns, repair.surface);
		const revealConfig = {
			...nextConfig,
			columns: showColumnOnDisplay(
				nextConfig.columns,
				next.uuid,
				repair.surface,
				order,
			),
		};
		const revealOutcome = inline.updateModule(moduleUuid, {
			caseListConfig: revealConfig,
		});
		if (revealOutcome.ok) {
			setWorkspaceAnnouncement(
				`${columnDisplayLabel(next)} fixed and added to ${surfaceDisplayName(repair.surface)}.`,
			);
			setSel({ type: "column", uuid: next.uuid });
			return;
		}

		const repairOutcome = inline.updateModule(moduleUuid, {
			caseListConfig: nextConfig,
		});
		setSel({
			type: "column",
			uuid: next.uuid,
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
	const addColumn = (surface: ColumnSurface) => {
		// Smart seed — bound to an unused property, human-worded header,
		// date-formatted when the property is date-shaped. A blank seed
		// would render "untitled" and demand three edits before the
		// canvas looks right; this one is presentable as it lands.
		const seed = seedColumn(
			config,
			ct,
			surface === "list"
				? { visibleInDetail: false }
				: { visibleInList: false },
		);
		if (seed === undefined) return;
		const seeded = {
			...seed,
			order: appendOrderKey(config.columns),
			...(surface === "list"
				? { listOrder: appendSurfaceOrderKey(config.columns, "list") }
				: { detailOrder: appendSurfaceOrderKey(config.columns, "detail") }),
		} as Column;
		updateConfig({ ...config, columns: [...config.columns, seeded] });
		setSel({ type: "column", uuid: seeded.uuid });
	};
	const moveColumn = (
		surface: ColumnSurface,
		uuid: Column["uuid"],
		toIndex: number,
	) => moveColumnOnSurface(moduleUuid, uuid, surface, toIndex);
	const updateColumns = (next: readonly Column[]) => {
		updateConfig({
			...config,
			columns: pruneStoppedSortOrphans(config.columns, next),
		});
	};
	const hideColumnFromSurface = (surface: ColumnSurface, column: Column) => {
		const visible = projectCaseWorkspaceColumns(config.columns);
		if (surface === "list" && visible.listVisible.length <= 1) return;
		const label = columnDisplayLabel(column);
		updateConfig({
			...config,
			columns: removeColumnFromDisplay(config.columns, column.uuid, surface),
		});
		pendingCanvasFocusRef.current = surface;
		setWorkspaceAnnouncement(
			`${label} hidden from ${surface === "list" ? "results" : "details"}. You can add it again from Add information.`,
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
		const nextConfig = {
			...config,
			columns: showColumnOnDisplay(config.columns, column.uuid, surface, order),
		};
		/* Fully hidden legacy definitions are deliberately absent from normal
		 * config warnings. Ask the SAME gate silently before revealing one: a
		 * refusal becomes a repair route, never a toast plus a dead click. */
		const outcome = inline.updateModule(moduleUuid, {
			caseListConfig: nextConfig,
		});
		if (!outcome.ok) {
			routeColumnToRepair(surface, column, outcome.messages);
			return;
		}
		setWorkspaceAnnouncement(
			`${columnDisplayLabel(column)} added to ${surfaceDisplayName(surface)}.`,
		);
		setSel({ type: "column", uuid: column.uuid });
	};

	const replaceInput = (uuid: string, next: SearchInputDef) => {
		// Carry the existing identity + display order forward.
		updateConfig({
			...config,
			searchInputs: config.searchInputs.map((s) =>
				s.uuid === uuid ? withPreservedIdentity(s, next) : s,
			),
		});
	};
	const removeInput = (
		uuid: SearchInputDef["uuid"],
		options?: { readonly discardSearchSettings?: boolean },
	) => {
		const remainingInputs = config.searchInputs.filter((s) => s.uuid !== uuid);
		const removesSearchSurface =
			remainingInputs.length === 0 &&
			searchConfig !== undefined &&
			(!caseSearchConfigHasAuthoredSettings(searchConfig) ||
				options?.discardSearchSettings === true) &&
			effectiveFilterForEmission(config.filter) === undefined;
		const outcome = commitMany([
			{ kind: "removeSearchInput", moduleUuid, uuid },
			...(removesSearchSurface
				? options?.discardSearchSettings === true
					? ([
							{
								kind: "updateModule",
								uuid: moduleUuid,
								patch: { caseSearchConfig: null },
							},
						] satisfies Mutation[])
					: ([
							{
								kind: "setCaseSearchMarker",
								uuid: moduleUuid,
								enabled: false,
							},
						] satisfies Mutation[])
				: []),
		]);
		if (outcome.ok) deselect();
	};
	const addInput = () => {
		// Smart seed — bound property, human label, widget matched to the
		// data type, fuzzy match for text. An unbound input matches
		// NOTHING at runtime, which reads as "search is broken"; a seed
		// must work the moment it lands.
		const seed = seedSearchInput(config, ct);
		if (seed === undefined) return;
		const seeded = { ...seed, order: appendOrderKey(config.searchInputs) };
		const outcome = commitMany([
			{ kind: "setCaseSearchMarker", uuid: moduleUuid, enabled: true },
			{ kind: "addSearchInput", moduleUuid, searchInput: seeded },
		]);
		// Never select an identity the gate refused to create. This matters when
		// a concurrent filter edit makes a formerly-valid seed conflict.
		if (outcome.ok) setSel({ type: "input", uuid: seeded.uuid });
	};
	const moveInput = (uuid: SearchInputDef["uuid"], toIndex: number) =>
		moveSearchInputToIndex(moduleUuid, uuid, toIndex);
	const clearFilter = useCallback(
		(nextFilter: Predicate | undefined) => {
			const stopsAutomaticSearch =
				config.searchInputs.length === 0 && searchConfig !== undefined;
			return commitMany([
				{
					kind: "setCaseListMeta",
					uuid: moduleUuid,
					patch: { filter: nextFilter ?? null },
				},
				...(stopsAutomaticSearch
					? caseSearchConfigHasAuthoredSettings(searchConfig)
						? ([
								{
									kind: "updateModule",
									uuid: moduleUuid,
									patch: { caseSearchConfig: null },
								},
							] satisfies Mutation[])
						: ([
								{
									kind: "setCaseSearchMarker",
									uuid: moduleUuid,
									enabled: false,
								},
							] satisfies Mutation[])
					: []),
			]);
		},
		[commitMany, config.searchInputs.length, moduleUuid, searchConfig],
	);

	// `currentCaseType` is required below. When the module has no case
	// type this URL shouldn't surface — guard defensively so a
	// deletion-in-flight URL doesn't crash.
	if (!mod || caseType === undefined) return null;

	// ── Inspector resolution ──

	const inspector = resolveInspector({
		sel,
		activeTab: tab,
		moduleUuid,
		config,
		searchConfig,
		caseTypes,
		caseType,
		appId,
		caseListOnly: mod.caseListOnly === true,
		onConfigChange: updateConfig,
		onClearFilter: clearFilter,
		onSearchConfigChange: updateSearchConfig,
		replaceColumn,
		replaceInput,
		onHideColumn: hideColumnFromSurface,
		onRemoveInput: removeInput,
	});

	/* A `caseListOnly` module has no module screen (it would be an empty form
	 * menu), so this workspace is its only home — carry the module identity
	 * (rename + settings: case type, menu appearance) in the sticky header,
	 * reusing the same controls the module screen mounts. Form-bearing modules
	 * keep their identity on the module screen, so no header here. */
	const moduleHeader: ReactNode = mod.caseListOnly ? (
		<div className="flex items-center gap-2 pb-2.5 mb-2.5 border-b border-nova-border/60">
			<EditableTitle value={mod.name} onSave={saveModuleName} />
			<ModuleSettingsButton moduleUuid={moduleUuid} />
		</div>
	) : null;

	return (
		<div className="case-list-workspace @container">
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

			{tab === "search" && (
				<SearchCanvas
					searchInputs={config.searchInputs}
					searchConfig={searchConfig}
					caseTypes={caseTypes}
					currentCaseType={caseType}
					selection={sel}
					onSelect={setSel}
					onAddInput={addInput}
					addInputDisabledReason={addDisabledReason}
					hasSearchSurface={config.searchInputs.length > 0}
					hasAutomaticResultsFilter={
						effectiveFilterForEmission(config.filter) !== undefined
					}
					onMoveInput={moveInput}
				/>
			)}
			{tab === "list" && (
				<CaseListCanvas
					config={config}
					caseType={ct}
					caseTypes={caseTypes}
					brokenColumns={brokenColumns}
					preview={preview}
					refreshing={previewFetching}
					selection={sel}
					onSelect={setSel}
					onAddColumn={() => addColumn("list")}
					addColumnDisabledReason={addDisabledReason}
					onMoveColumn={(uuid, toIndex) => moveColumn("list", uuid, toIndex)}
					onColumnsChange={updateColumns}
					onShowColumn={(column) => showColumn("list", column)}
					onRepairColumn={(column) => routeColumnToRepair("list", column)}
					onOpenOptions={() => setSel({ type: "list-panel" })}
					showMenuAppearance={canEdit && mod.caseListOnly === true}
				/>
			)}
			{tab === "detail" && (
				<DetailCanvas
					config={config}
					brokenColumns={brokenColumns}
					preview={preview}
					selection={sel}
					onSelect={setSel}
					onAddDetailField={() => addColumn("detail")}
					addDisabledReason={addDisabledReason}
					onMoveColumn={(uuid, toIndex) => moveColumn("detail", uuid, toIndex)}
					onShowColumn={(column) => showColumn("detail", column)}
					onRepairColumn={(column) => routeColumnToRepair("detail", column)}
				/>
			)}

			{inspector !== null && (
				<InspectorSurface
					kicker={inspector.kicker}
					title={inspector.title}
					onClose={deselect}
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
	/** Owning module — used to key media-slot staged uploads
	 *  (`caselist:<moduleUuid>:<slot>`). */
	readonly moduleUuid: Uuid;
	readonly config: CaseListConfig;
	readonly searchConfig: CaseSearchConfig | undefined;
	readonly caseTypes: ReturnType<typeof useEffectiveCaseTypes>;
	readonly caseType: string;
	readonly appId: string;
	readonly caseListOnly: boolean;
	readonly onConfigChange: (next: CaseListConfig) => void;
	readonly onClearFilter: (next: Predicate | undefined) => CommitOutcome;
	readonly onSearchConfigChange: (next: CaseSearchConfig) => void;
	readonly replaceColumn: (uuid: string, next: Column) => void;
	readonly replaceInput: (uuid: string, next: SearchInputDef) => void;
	readonly onHideColumn: (surface: ColumnSurface, column: Column) => void;
	readonly onRemoveInput: (
		uuid: SearchInputDef["uuid"],
		options?: { readonly discardSearchSettings?: boolean },
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
					? column.header || "Untitled field"
					: column.header ||
						labelFromProperty(column.field) ||
						"Untitled field";
			return {
				kicker: "Information",
				title,
				body:
					surface === null ? null : (
						<ColumnInspectorBody
							column={column}
							surface={surface}
							visibleCount={
								surface === "list"
									? projection.listVisible.length
									: projection.detailVisible.length
							}
							caseTypes={args.caseTypes}
							currentCaseType={args.caseType}
							repairMessages={sel.reveal?.messages}
							onChange={(next) => args.replaceColumn(column.uuid, next)}
							onHide={() => args.onHideColumn(surface, column)}
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
						removalNeedsConfirmation={
							sortedInputs.length === 1 &&
							effectiveFilterForEmission(config.filter) === undefined &&
							caseSearchConfigHasAuthoredSettings(args.searchConfig)
						}
						onRemove={(discardSearchSettings) =>
							args.onRemoveInput(
								input.uuid,
								discardSearchSettings
									? { discardSearchSettings: true }
									: undefined,
							)
						}
					/>
				),
			};
		}
		case "filter":
			return {
				kicker: "Results",
				title: "Cases included",
				body: (
					<FilterInspectorBody
						config={config}
						onChange={args.onConfigChange}
						onClearFilter={args.onClearFilter}
						stopsAutomaticSearch={
							config.searchInputs.length === 0 &&
							args.searchConfig !== undefined
						}
						discardsAutomaticSearchSettings={caseSearchConfigHasAuthoredSettings(
							args.searchConfig,
						)}
						caseTypes={args.caseTypes}
						currentCaseType={args.caseType}
						appId={args.appId}
					/>
				),
			};
		case "search-panel": {
			const hasVisibleSearchScreen = config.searchInputs.length > 0;
			return {
				kicker: hasVisibleSearchScreen ? "Search screen" : "Search",
				title: hasVisibleSearchScreen
					? (args.searchConfig?.searchScreenTitle ?? DEFAULT_CASE_SEARCH_TITLE)
					: "Automatic search rules",
				body: (
					<SearchPanelInspectorBody
						value={args.searchConfig}
						onChange={args.onSearchConfigChange}
						caseTypes={args.caseTypes}
						currentCaseType={args.caseType}
						knownInputs={config.searchInputs}
						hasVisibleSearchScreen={hasVisibleSearchScreen}
					/>
				),
			};
		}
		case "list-panel":
			return {
				kicker: "Results",
				title: "Menu appearance",
				body: (
					<ListPanelInspectorBody
						moduleUuid={args.moduleUuid}
						config={config}
						onChange={args.onConfigChange}
						caseListOnly={args.caseListOnly}
					/>
				),
			};
	}
}

function ColumnInspectorBody({
	column,
	surface,
	visibleCount,
	caseTypes,
	currentCaseType,
	repairMessages,
	onChange,
	onHide,
}: {
	readonly column: Column;
	readonly surface: ColumnSurface;
	readonly visibleCount: number;
	readonly caseTypes: ReturnType<typeof useEffectiveCaseTypes>;
	readonly currentCaseType: string;
	/** Defined (including an empty array) while this off-screen definition is
	 * being repaired in response to an Add information request. */
	readonly repairMessages: readonly string[] | undefined;
	readonly onChange: (next: Column) => void;
	readonly onHide: () => void;
}) {
	const screenName = surfaceDisplayName(surface);
	const keepLastResult = surface === "list" && visibleCount <= 1;
	const repairing = repairMessages !== undefined;
	const uniqueRepairMessages = [...new Set(repairMessages ?? [])];
	return (
		<>
			{repairing && (
				<div className="rounded-xl border border-nova-violet/25 bg-nova-violet/[0.06] px-3 py-3 text-[12px] leading-relaxed">
					<p className="font-medium text-nova-text">One quick fix first</p>
					<p className="mt-1 text-nova-text-secondary">
						Review the source or display settings below. Nova will add this to{" "}
						{screenName} automatically as soon as it’s ready.
					</p>
					{uniqueRepairMessages.length > 0 && (
						<ul className="mt-2 list-disc space-y-1 pl-4 text-nova-text-muted">
							{uniqueRepairMessages.map((message) => (
								<li key={message}>{message}</li>
							))}
						</ul>
					)}
				</div>
			)}
			<ColumnEditor
				value={column}
				onChange={onChange}
				caseTypes={caseTypes}
				currentCaseType={currentCaseType}
			/>
			{!repairing && (
				<div className="border-t border-nova-border pt-3">
					<button
						type="button"
						onClick={keepLastResult ? undefined : onHide}
						aria-disabled={keepLastResult}
						className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border px-3 text-[13px] transition-colors ${
							keepLastResult
								? "cursor-not-allowed border-white/[0.04] text-nova-text-muted opacity-60"
								: "cursor-pointer border-white/[0.06] text-nova-text-secondary hover:border-nova-violet/30 hover:bg-nova-violet/[0.06] hover:text-nova-text"
						}`}
					>
						<Icon icon={tablerEyeOff} width="15" height="15" />
						Hide from {screenName}
					</button>
					<p className="mt-2 text-[12px] leading-relaxed text-nova-text-muted">
						{keepLastResult
							? "Add another result first. People need at least one piece of information to choose a case."
							: `You can add it back later from Add information in ${screenName}.`}
					</p>
				</div>
			)}
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
	removalNeedsConfirmation,
	onRemove,
}: {
	readonly input: SearchInputDef;
	readonly index: number;
	readonly siblings: readonly SearchInputDef[];
	readonly caseTypes: ReturnType<typeof useEffectiveCaseTypes>;
	readonly currentCaseType: string;
	readonly onChange: (next: SearchInputDef) => void;
	readonly removalNeedsConfirmation: boolean;
	readonly onRemove: (discardSearchSettings: boolean) => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const remove = () => {
		if (removalNeedsConfirmation) setConfirming(true);
		else onRemove(false);
	};
	return (
		<>
			<SearchInputEditor
				value={input}
				index={index}
				siblings={siblings}
				caseTypes={caseTypes}
				currentCaseType={currentCaseType}
				onChange={onChange}
			/>
			<RemoveRow
				label={
					removalNeedsConfirmation
						? "Remove search field and screen settings…"
						: "Remove search field"
				}
				onClick={remove}
			/>
			<AlertDialog open={confirming} onOpenChange={setConfirming}>
				<AlertDialogContent className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display">
							Remove the search screen?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This is the final search field, so removing it also removes the
							screen title and button settings. Results, Details, and the rule
							for who appears stay unchanged.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Keep search</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => onRemove(true)}
							className="bg-nova-rose text-nova-void not-disabled:hover:bg-[color-mix(in_oklab,var(--nova-rose),black_14%)] focus-visible:ring-nova-rose/40"
						>
							Remove search
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
	 *  sticky frame — present only when this workspace is the module's home
	 *  (a `caseListOnly` module). */
	readonly header?: ReactNode;
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
function WorkspaceTabs({
	tab,
	errorAreas,
	onSelectTab,
	header,
}: WorkspaceTabsProps) {
	/* The canvas narrows when the inspector docks (and again with both
	 * sidebars open), so the concise Search / Results / Details labels must
	 * remain visible. Below the `sm` container boundary, spacing tightens and
	 * the decorative icons step away; the text stays intact and the buttons keep
	 * their full accessible names. The
	 * bar spans the column (sticky, border); its contents use the same `3xl`
	 * frame as the composition canvases so navigation and content share a
	 * calm, consistent width when either sidebar collapses. */
	return (
		<div className="sticky top-0 z-raised py-2.5 border-b border-nova-border bg-pv-bg/90 backdrop-blur-md">
			<ContentFrame width="3xl" className="px-3 @sm:px-6">
				{header}
				<div className="flex items-center gap-1 @sm:gap-1.5 @2xl:gap-2">
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
										? `${accessibleLabel} needs attention — open it to see what's wrong`
										: accessibleLabel
								}
								side="bottom"
							>
								<button
									type="button"
									aria-label={accessibleName}
									aria-current={active ? "page" : undefined}
									onClick={() => onSelectTab(id)}
									className={`relative flex min-w-0 flex-1 items-center justify-center gap-1 px-1.5 @sm:gap-2 @sm:px-2 @2xl:px-3.5 py-1.5 min-h-11 rounded-lg text-left whitespace-nowrap cursor-pointer border transition-all ${
										active
											? "bg-nova-violet/[0.13] border-nova-border-bright"
											: "border-transparent hover:bg-white/[0.03]"
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
										<span className="grid text-[13px] leading-tight">
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
								</button>
							</SimpleTooltip>
						);
					})}
				</div>
			</ContentFrame>
		</div>
	);
}
