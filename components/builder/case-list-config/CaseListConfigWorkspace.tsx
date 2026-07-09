// components/builder/case-list-config/CaseListConfigWorkspace.tsx
//
// The unified case-list authoring workspace — three focused config
// tabs (Search / Case List / Case Detail). Each tab is an
// artifact-first canvas where clicking a thing configures that thing
// in the right-rail inspector. The tab IS the URL (`/cases`,
// `/search-config`, `/detail-config`), so tab switches are ordinary
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
// Edits flow through `updateModule(uuid, { caseListConfig })` /
// `{ caseSearchConfig }` against the doc store — the same wholesale
// per-slot contract the magazine-era workspace used.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
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
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { appendOrderKey, sequenceOrderKeys } from "@/lib/doc/order/append";
import { bySortKey } from "@/lib/doc/order/compare";
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
import { SearchCanvas } from "./canvas/SearchCanvas";
import {
	type CaseListConfigErrorAreas,
	caseListConfigErrorAreas,
} from "./configValidity";
import { FilterInspectorBody } from "./inspector/FilterInspectorBody";
import { ListPanelInspectorBody } from "./inspector/ListPanelInspectorBody";
import { SearchInputEditor } from "./inspector/SearchInputEditor";
import { SearchPanelInspectorBody } from "./inspector/SearchPanelInspectorBody";
import { withPreservedIdentity } from "./preserveIdentity";
import { seedColumn, seedSearchInput } from "./seeds";
import { resolveSortedColumns, sortPositionByUuid } from "./sortPriority";
import { useCaseListPreview } from "./useCaseListPreview";
import { useSampleData } from "./useSampleData";
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

/** Re-key a reordered sequence so each item's `order` reflects the new order —
 *  the auto-save diff reads the order key, not array position. */
function resequence<T extends { order?: string }>(items: readonly T[]): T[] {
	const keys = sequenceOrderKeys(items.length);
	return items.map((item, i) => ({ ...item, order: keys[i] }));
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
	const caseTypes = useCaseTypes();
	const appId = useAppId() ?? "";
	const navigate = useNavigate();
	const { updateModule, inline } = useBlueprintMutations();

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
		caseType: caseTypes.find((ct) => ct.name === caseType),
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

	const replaceColumn = (uuid: string, next: Column) => {
		// Carry the existing `uuid` + `order` forward — see `withPreservedIdentity`.
		updateConfig({
			...config,
			columns: config.columns.map((c) =>
				c.uuid === uuid ? withPreservedIdentity(c, next) : c,
			),
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
		// Append after the last column in DISPLAY order — the absolute `order`
		// key is what the auto-save diff reads, not the array position.
		const seeded = { ...seed, order: appendOrderKey(config.columns) };
		updateConfig({ ...config, columns: [...config.columns, seeded] });
		setSel({ type: "column", uuid: seeded.uuid });
	};
	const reorderColumns = (next: readonly Column[]) => {
		// Re-key the whole sequence so the `order` keys reflect the new order —
		// the diff detects a reorder by an order-key change, not array position,
		// so a key-less shuffle would be silently dropped on save.
		updateConfig({ ...config, columns: resequence(next) });
	};

	const replaceInput = (uuid: string, next: SearchInputDef) => {
		// Carry the existing `uuid` + `order` forward — see `withPreservedIdentity`.
		updateConfig({
			...config,
			searchInputs: config.searchInputs.map((s) =>
				s.uuid === uuid ? withPreservedIdentity(s, next) : s,
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
		const seeded = { ...seed, order: appendOrderKey(config.searchInputs) };
		updateConfig({ ...config, searchInputs: [...config.searchInputs, seeded] });
		setSel({ type: "input", uuid: seeded.uuid });
	};
	const reorderInputs = (next: readonly SearchInputDef[]) => {
		updateConfig({ ...config, searchInputs: resequence(next) });
	};

	// `currentCaseType` is required below. When the module has no case
	// type this URL shouldn't surface — guard defensively so a
	// deletion-in-flight URL doesn't crash.
	if (!mod || caseType === undefined) return null;

	// ── Inspector resolution ──

	const inspector = resolveInspector({
		sel,
		moduleUuid,
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
			<WorkspaceTabs
				header={moduleHeader}
				tab={tab}
				searchMeta={`${config.searchInputs.length} ${config.searchInputs.length === 1 ? "field" : "fields"}`}
				listMeta={`${config.columns.length} ${config.columns.length === 1 ? "column" : "columns"}`}
				detailMeta={`${detailFieldCount} ${detailFieldCount === 1 ? "field" : "fields"}`}
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
					generate={sampleData.generate}
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
	/** Owning module — used to key media-slot staged uploads
	 *  (`caselist:<moduleUuid>:<slot>`). */
	readonly moduleUuid: Uuid;
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
			// DISPLAY position (`sort-by-(order, uuid)`) for the "Column N of M"
			// kicker, not array position.
			const sortedCols = [...config.columns].sort(bySortKey);
			const index = sortedCols.findIndex((c) => c.uuid === sel.uuid);
			const column = sortedCols[index];
			if (column === undefined) return null;
			const title =
				column.kind === "calculated"
					? column.header || "Untitled Column"
					: column.header || column.field || "Untitled Column";
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
							sortedColumnCount={resolveSortedColumns(sortedCols).length}
							sortPriorityPosition={sortPositionByUuid(sortedCols).get(
								column.uuid,
							)}
							onEditSortOrder={args.onSelectListPanel}
						/>
						<RemoveRow
							label="Remove Column"
							onClick={() => args.removeColumn(column.uuid)}
						/>
					</>
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
				kicker: `Search field ${index + 1} of ${config.searchInputs.length}`,
				title: input.label || input.name || "Untitled Field",
				body: (
					<SearchInputEditor
						value={input}
						index={index}
						siblings={sortedInputs}
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
						moduleUuid={args.moduleUuid}
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
	/** Optional module-identity row rendered above the tabs, inside the same
	 *  sticky frame — present only when this workspace is the module's home
	 *  (a `caseListOnly` module). */
	readonly header?: ReactNode;
}

const TAB_DEFS: ReadonlyArray<{
	id: CaseListWorkspaceTab;
	icon: IconifyIcon;
	label: string;
}> = [
	{ id: "search", icon: tablerSearch, label: "Search" },
	{ id: "list", icon: tablerListDetails, label: "Case List" },
	{ id: "detail", icon: tablerId, label: "Case Detail" },
];

/**
 * Peer config tabs — no numbering, no implied order. The run-through
 * lives behind the chrome's global Preview toggle, so the strip is
 * pure workbench navigation.
 */
function WorkspaceTabs({
	tab,
	searchMeta,
	listMeta,
	detailMeta,
	errorAreas,
	onSelectTab,
	header,
}: WorkspaceTabsProps) {
	const metas: Record<CaseListWorkspaceTab, string> = {
		search: searchMeta,
		list: listMeta,
		detail: detailMeta,
	};
	/* The canvas narrows when the inspector docks (and again with both
	 * sidebars open), so the row compacts by container width: metas
	 * drop first, then labels go icon-only with the tooltip carrying
	 * the name. The bar spans the column (sticky, border); its contents
	 * sit in the workspace's shared ContentFrame — the same `5xl` frame
	 * the case-list canvas, the breadcrumb strip, and the preview
	 * run-through use, so every layer shares one left edge. */
	return (
		<div className="sticky top-0 z-raised py-2.5 border-b border-nova-border bg-pv-bg/90 backdrop-blur-md">
			<ContentFrame width="5xl" className="px-6">
				{header}
				<div className="flex items-center gap-1.5 @2xl:gap-2">
					{TAB_DEFS.map(({ id, icon, label }) => {
						const active = tab === id;
						const hasErrors = errorAreas[id];
						return (
							<SimpleTooltip
								key={id}
								content={
									hasErrors
										? `${label} needs attention — open it to see what's wrong`
										: label
								}
								side="bottom"
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
									<span className="hidden @xl:flex flex-col gap-0.5">
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
										<span className="hidden @min-[40rem]:block text-[10px] text-nova-text-muted leading-tight">
											{metas[id]}
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
