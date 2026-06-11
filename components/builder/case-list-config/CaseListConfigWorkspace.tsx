// components/builder/case-list-config/CaseListConfigWorkspace.tsx
//
// The unified case-list authoring workspace — three focused config
// tabs (Search / Case list / Case detail) plus a first-class Preview
// tab. Each config tab is an artifact-first canvas where clicking a
// thing configures that thing in the right-rail inspector; Preview is
// the live run-through, a place (URL-addressed) rather than a
// popup or a cursor mode. The tab IS the URL (`/cases`,
// `/search-config`, `/detail-config`, `/case-preview`), so tab
// switches are ordinary history navigation and deep links land on the
// right canvas. This surface carries no cursor-mode toggle —
// selection is its mode, and Preview covers the run-through
// (`BuilderContentArea` suppresses the pill here).
//
// Selection is workspace-local state (case-list entities have no
// standalone URLs the way fields do), keyed by module so navigating
// to a different module's case list never carries a stale selection.
// The inspector mounts via `InspectorSurface`, which claims the right
// rail and releases it automatically when this screen hides (Activity
// destroys effects) or the selection clears (Esc, the rail's close
// affordances, tab switches).
//
// Edits flow through `updateModule(uuid, { caseListConfig })` /
// `{ caseSearchConfig }` against the doc store — the same wholesale
// per-slot contract the magazine-era workspace used.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerId from "@iconify-icons/tabler/id";
import tablerListDetails from "@iconify-icons/tabler/list-details";
import tablerPlayerPlay from "@iconify-icons/tabler/player-play";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InspectorSurface } from "@/components/builder/inspector/InspectorSurface";
import { Tooltip } from "@/components/ui/Tooltip";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useModule } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/doc/types";
import type {
	CaseListConfig,
	CaseSearchConfig,
	Column,
	SearchInputDef,
} from "@/lib/domain";
import { useNavigate } from "@/lib/routing/hooks";
import { useAppId } from "@/lib/session/hooks";
import { useKeyboardShortcuts } from "@/lib/ui/hooks/useKeyboardShortcuts";
import { ColumnEditor } from "./ColumnEditor";
import { CaseListCanvas } from "./canvas/CaseListCanvas";
import { DetailCanvas } from "./canvas/DetailCanvas";
import { PreviewCanvas } from "./canvas/PreviewCanvas";
import { SearchCanvas } from "./canvas/SearchCanvas";
import {
	type CaseListConfigErrorAreas,
	caseListConfigErrorAreas,
} from "./configValidity";
import { FilterInspectorBody } from "./inspector/FilterInspectorBody";
import { ListPanelInspectorBody } from "./inspector/ListPanelInspectorBody";
import { SearchInputEditor } from "./inspector/SearchInputEditor";
import { SearchPanelInspectorBody } from "./inspector/SearchPanelInspectorBody";
import { seedColumn, seedSearchInput } from "./seeds";
import { resolveSortedColumns, sortPositionByUuid } from "./sortPriority";
import { useCaseListPreview } from "./useCaseListPreview";
import { useSampleData } from "./useSampleData";
import type { WorkspaceSelection } from "./workspaceSelection";

// ── Public types ──────────────────────────────────────────────────

/** Which canvas is showing — derived from the URL location kind. */
export type CaseListWorkspaceTab = "search" | "list" | "detail" | "preview";

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
	const caseTypes = useCaseTypes();
	const appId = useAppId() ?? "";
	const navigate = useNavigate();
	const { updateModule } = useBlueprintMutations();

	const caseType = mod?.caseType;
	const config = mod?.caseListConfig ?? EMPTY_CONFIG;
	const searchConfig = mod?.caseSearchConfig;

	// ── Selection ──
	const [sel, setSel] = useState<WorkspaceSelection | null>(null);
	const deselect = useCallback(() => setSel(null), []);

	/* Tab switches deselect — covers in-app tab clicks AND browser
	 * back/forward, since both arrive as a `tab` prop change. */
	const prevTabRef = useRef(tab);
	useEffect(() => {
		if (prevTabRef.current === tab) return;
		prevTabRef.current = tab;
		setSel(null);
	}, [tab]);

	/* Where Preview toggles back to. Tracks the last config tab the
	 * user was on so clicking the active Preview button returns them
	 * exactly where they left off (defaults to the list). */
	const lastConfigTabRef = useRef<Exclude<CaseListWorkspaceTab, "preview">>(
		tab === "preview" ? "list" : tab,
	);
	useEffect(() => {
		if (tab !== "preview") lastConfigTabRef.current = tab;
	}, [tab]);

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
	const errorAreas = useMemo(
		() =>
			caseType !== undefined
				? caseListConfigErrorAreas(config, caseTypes, caseType)
				: { search: false, list: false, detail: false },
		[config, caseTypes, caseType],
	);
	const configValid =
		!errorAreas.search && !errorAreas.list && !errorAreas.detail;
	const {
		state: preview,
		fetching: previewFetching,
		reload: reloadPreview,
	} = useCaseListPreview({
		appId,
		caseListConfig: config,
		currentCaseType: caseType ?? "",
		configValid,
	});

	/* Generate / Reset sample data — surfaced from the list canvas's
	 * empty state and the list-panel inspector. Writes real rows to the
	 * user's case store, then reloads the live canvases. */
	const sampleData = useSampleData({
		appId,
		caseType,
		onDone: reloadPreview,
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

	const ct = caseTypes.find((c) => c.name === caseType);
	const addDisabledReason =
		(ct?.properties.length ?? 0) === 0 ? PROPERTYLESS_HINT : undefined;

	const replaceColumn = (uuid: string, next: Column) => {
		updateConfig({
			...config,
			columns: config.columns.map((c) => (c.uuid === uuid ? next : c)),
		});
	};
	const removeColumn = (uuid: string) => {
		updateConfig({
			...config,
			columns: config.columns.filter((c) => c.uuid !== uuid),
		});
		deselect();
	};
	const addColumn = (slots?: { visibleInList?: boolean }) => {
		// Smart seed — bound to an unused property, human-worded header,
		// date-formatted when the property is date-shaped. A blank seed
		// would render "untitled" and demand three edits before the
		// canvas looks right; this one is presentable as it lands.
		const seed = seedColumn(config, ct, slots);
		if (seed === undefined) return;
		updateConfig({ ...config, columns: [...config.columns, seed] });
		setSel({ type: "column", uuid: seed.uuid });
	};
	const reorderColumns = (next: readonly Column[]) => {
		updateConfig({ ...config, columns: [...next] });
	};

	const replaceInput = (uuid: string, next: SearchInputDef) => {
		updateConfig({
			...config,
			searchInputs: config.searchInputs.map((s) =>
				s.uuid === uuid ? next : s,
			),
		});
	};
	const removeInput = (uuid: string) => {
		updateConfig({
			...config,
			searchInputs: config.searchInputs.filter((s) => s.uuid !== uuid),
		});
		deselect();
	};
	const addInput = () => {
		// Smart seed — bound property, human label, widget matched to the
		// data type, fuzzy match for text. An unbound input matches
		// NOTHING at runtime, which reads as "search is broken"; a seed
		// must work the moment it lands.
		const seed = seedSearchInput(config, ct);
		if (seed === undefined) return;
		updateConfig({ ...config, searchInputs: [...config.searchInputs, seed] });
		setSel({ type: "input", uuid: seed.uuid });
	};
	const reorderInputs = (next: readonly SearchInputDef[]) => {
		updateConfig({ ...config, searchInputs: [...next] });
	};

	// `currentCaseType` is required below. When the module has no case
	// type this URL shouldn't surface — guard defensively so a
	// deletion-in-flight URL doesn't crash.
	if (!mod || caseType === undefined) return null;

	// ── Inspector resolution ──

	const inspector = resolveInspector({
		sel,
		config,
		searchConfig,
		caseTypes,
		caseType,
		appId,
		moduleName: mod.name,
		caseListOnly: mod.caseListOnly === true,
		sampleData,
		onConfigChange: updateConfig,
		onSearchConfigChange: updateSearchConfig,
		replaceColumn,
		removeColumn,
		replaceInput,
		removeInput,
		onSelectListPanel: () => setSel({ type: "list-panel" }),
	});

	const detailFieldCount = config.columns.filter(
		(c) => c.visibleInDetail !== false,
	).length;

	return (
		<div className="case-list-workspace @container">
			<WorkspaceTabs
				tab={tab}
				searchMeta={`${config.searchInputs.length} ${config.searchInputs.length === 1 ? "field" : "fields"}`}
				listMeta={`${config.columns.length} ${config.columns.length === 1 ? "column" : "columns"}`}
				detailMeta={`${detailFieldCount} ${detailFieldCount === 1 ? "field" : "fields"}`}
				errorAreas={errorAreas}
				onSelectTab={(next) => {
					/* Preview is a toggle: clicking it while active returns to
					 * the tab the user came from. Config tabs stay no-ops when
					 * already active. */
					if (next === tab) {
						if (next !== "preview") return;
						const back = lastConfigTabRef.current;
						if (back === "search") navigate.openSearchConfig(moduleUuid);
						else if (back === "detail") navigate.openDetailConfig(moduleUuid);
						else navigate.openCaseList(moduleUuid);
						return;
					}
					if (next === "search") navigate.openSearchConfig(moduleUuid);
					else if (next === "list") navigate.openCaseList(moduleUuid);
					else if (next === "detail") navigate.openDetailConfig(moduleUuid);
					else navigate.openCasePreview(moduleUuid);
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
					onReorderInputs={reorderInputs}
				/>
			)}
			{tab === "list" && (
				<CaseListCanvas
					config={config}
					moduleName={mod.name}
					preview={preview}
					refreshing={previewFetching}
					selection={sel}
					onSelect={setSel}
					onAddColumn={() => addColumn()}
					addColumnDisabledReason={addDisabledReason}
					onReorderColumns={reorderColumns}
					generateSampleData={sampleData.generate}
				/>
			)}
			{tab === "detail" && (
				<DetailCanvas
					config={config}
					preview={preview}
					selection={sel}
					onSelect={setSel}
					onAddDetailField={() => addColumn({ visibleInList: false })}
					addDisabledReason={addDisabledReason}
				/>
			)}
			{tab === "preview" && (
				<PreviewCanvas
					moduleName={mod.name}
					config={config}
					searchConfig={searchConfig}
					caseType={ct}
					appId={appId}
					onConfigChange={updateConfig}
					warmRows={preview.kind === "rows" ? preview.rows : undefined}
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
	readonly config: CaseListConfig;
	readonly searchConfig: CaseSearchConfig | undefined;
	readonly caseTypes: ReturnType<typeof useCaseTypes>;
	readonly caseType: string;
	readonly appId: string;
	readonly moduleName: string;
	readonly caseListOnly: boolean;
	readonly sampleData: ReturnType<typeof useSampleData>;
	readonly onConfigChange: (next: CaseListConfig) => void;
	readonly onSearchConfigChange: (next: CaseSearchConfig) => void;
	readonly replaceColumn: (uuid: string, next: Column) => void;
	readonly removeColumn: (uuid: string) => void;
	readonly replaceInput: (uuid: string, next: SearchInputDef) => void;
	readonly removeInput: (uuid: string) => void;
	/** Select the list panel — the column inspector's "arrange the
	 *  sort order" affordance lands the user on the sort stack. */
	readonly onSelectListPanel: () => void;
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
			const index = config.columns.findIndex((c) => c.uuid === sel.uuid);
			const column = config.columns[index];
			if (column === undefined) return null;
			const title =
				column.kind === "calculated"
					? column.header || "Untitled column"
					: column.header || column.field || "Untitled column";
			return {
				kicker: `Column ${index + 1} of ${config.columns.length}`,
				title,
				body: (
					<>
						<ColumnEditor
							value={column}
							onChange={(next) => args.replaceColumn(column.uuid, next)}
							caseTypes={args.caseTypes}
							currentCaseType={args.caseType}
							sortedColumnCount={resolveSortedColumns(config.columns).length}
							sortPriorityPosition={sortPositionByUuid(config.columns).get(
								column.uuid,
							)}
							onEditSortOrder={args.onSelectListPanel}
						/>
						<RemoveEntityButton
							label="Remove column"
							onClick={() => args.removeColumn(column.uuid)}
						/>
					</>
				),
			};
		}
		case "input": {
			const index = config.searchInputs.findIndex((s) => s.uuid === sel.uuid);
			const input = config.searchInputs[index];
			if (input === undefined) return null;
			return {
				kicker: `Search field ${index + 1} of ${config.searchInputs.length}`,
				title: input.label || input.name || "Untitled field",
				body: (
					<SearchInputEditor
						value={input}
						index={index}
						siblings={config.searchInputs}
						caseTypes={args.caseTypes}
						currentCaseType={args.caseType}
						onChange={(next) => args.replaceInput(input.uuid, next)}
						onRemove={() => args.removeInput(input.uuid)}
					/>
				),
			};
		}
		case "filter":
			return {
				kicker: "Case list",
				title: "Filter",
				body: (
					<FilterInspectorBody
						config={config}
						onChange={args.onConfigChange}
						caseTypes={args.caseTypes}
						currentCaseType={args.caseType}
						appId={args.appId}
					/>
				),
			};
		case "search-panel":
			return {
				kicker: "Search screen",
				title: args.searchConfig?.searchScreenTitle ?? "Search",
				body: (
					<SearchPanelInspectorBody
						value={args.searchConfig}
						onChange={args.onSearchConfigChange}
						caseTypes={args.caseTypes}
						currentCaseType={args.caseType}
						knownInputs={config.searchInputs}
					/>
				),
			};
		case "list-panel":
			return {
				kicker: "Case list",
				title: args.moduleName,
				body: (
					<ListPanelInspectorBody
						config={config}
						onChange={args.onConfigChange}
						caseListOnly={args.caseListOnly}
						sampleData={args.sampleData}
					/>
				),
			};
	}
}

// ── Tabs ──────────────────────────────────────────────────────────

interface WorkspaceTabsProps {
	readonly tab: CaseListWorkspaceTab;
	readonly searchMeta: string;
	readonly listMeta: string;
	readonly detailMeta: string;
	readonly errorAreas: CaseListConfigErrorAreas;
	readonly onSelectTab: (next: CaseListWorkspaceTab) => void;
}

const TAB_DEFS: ReadonlyArray<{
	id: Exclude<CaseListWorkspaceTab, "preview">;
	icon: IconifyIcon;
	label: string;
}> = [
	{ id: "search", icon: tablerSearch, label: "Search" },
	{ id: "list", icon: tablerListDetails, label: "Case list" },
	{ id: "detail", icon: tablerId, label: "Case detail" },
];

/**
 * Peer config tabs — no numbering, no implied order — plus the
 * Preview affordance on the right edge, visually distinct (violet,
 * play glyph) because it answers a different question: the config
 * tabs are workbenches; Preview is the composed running experience.
 */
function WorkspaceTabs({
	tab,
	searchMeta,
	listMeta,
	detailMeta,
	errorAreas,
	onSelectTab,
}: WorkspaceTabsProps) {
	const metas: Record<Exclude<CaseListWorkspaceTab, "preview">, string> = {
		search: searchMeta,
		list: listMeta,
		detail: detailMeta,
	};
	const previewActive = tab === "preview";
	/* The canvas narrows when the inspector docks (and again with both
	 * sidebars open), so the row compacts by container width: metas
	 * drop first, then labels go icon-only with the tooltip carrying
	 * the name. */
	return (
		<div className="sticky top-0 z-raised flex items-center gap-1.5 @2xl:gap-2 px-4 @2xl:px-7 py-2.5 border-b border-nova-border bg-pv-bg/90 backdrop-blur-md">
			{TAB_DEFS.map(({ id, icon, label }) => {
				const active = tab === id;
				const hasErrors = errorAreas[id];
				return (
					<Tooltip
						key={id}
						content={
							hasErrors
								? `${label} needs attention — open it to see what's wrong`
								: label
						}
						placement="bottom"
					>
						<button
							type="button"
							onClick={() => onSelectTab(id)}
							className={`relative flex items-center gap-2.5 px-3 @2xl:px-3.5 py-1.5 min-h-11 rounded-lg text-left whitespace-nowrap cursor-pointer border transition-all ${
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
								className={`shrink-0 ${
									active ? "text-nova-violet-bright" : "text-nova-text-muted"
								}`}
							/>
							<span className="hidden @xl:block">
								<span
									className={`block text-[13px] leading-tight ${
										active
											? "font-semibold text-nova-text"
											: "font-medium text-nova-text-secondary"
									}`}
								>
									{label}
								</span>
								<span className="hidden @3xl:block text-[10px] text-nova-text-muted leading-tight">
									{metas[id]}
								</span>
							</span>
						</button>
					</Tooltip>
				);
			})}
			<Tooltip
				content={
					previewActive
						? "Back to editing"
						: "Try these screens exactly as your app runs them"
				}
				placement="bottom"
			>
				<button
					type="button"
					onClick={() => onSelectTab("preview")}
					aria-pressed={previewActive}
					className={`ml-auto inline-flex items-center gap-2 px-3 @xl:px-4 min-h-11 rounded-lg text-[13px] font-semibold whitespace-nowrap cursor-pointer border transition-all ${
						previewActive
							? "bg-nova-violet border-nova-violet text-white shadow-[0_0_16px_rgba(139,92,246,0.4)]"
							: "bg-nova-violet/[0.12] border-nova-border-bright text-nova-violet-bright hover:bg-nova-violet/[0.2]"
					}`}
				>
					<Icon icon={tablerPlayerPlay} width="14" height="14" />
					<span className="hidden @xl:inline">Preview</span>
				</button>
			</Tooltip>
		</div>
	);
}

// ── Inspector footer ──────────────────────────────────────────────

function RemoveEntityButton({
	label,
	onClick,
}: {
	readonly label: string;
	readonly onClick: () => void;
}) {
	return (
		<div className="pt-2 border-t border-nova-border">
			<button
				type="button"
				onClick={onClick}
				className="w-full inline-flex items-center justify-center gap-2 px-3 min-h-11 text-[13px] rounded-lg border border-white/[0.06] text-nova-text-muted hover:text-nova-rose hover:border-nova-rose/40 transition-colors cursor-pointer"
			>
				<Icon icon={tablerTrash} width="14" height="14" />
				<span>{label}</span>
			</button>
		</div>
	);
}
