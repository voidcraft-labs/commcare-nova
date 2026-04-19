/**
 * AppTree — structure sidebar with per-entity subscriptions.
 *
 * Each tree component (ModuleCard, FormCard, FieldRow) subscribes to its
 * own entity in the builder store by ID/UUID. Immer structural sharing means
 * editing field A's label only re-renders FieldRow(A) in the sidebar —
 * not the other 166 FieldRows, not the FormCards, not the ModuleCards.
 *
 * Selection uses boolean selectors — only the old and new selected components
 * re-render on selection change (2 total), not every tree item.
 *
 * Search filtering operates directly on entity maps — no assembled TreeData.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerGridDots from "@iconify-icons/tabler/grid-dots";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerTable from "@iconify-icons/tabler/table";
import tablerX from "@iconify-icons/tabler/x";
import { AnimatePresence, motion } from "motion/react";
import { memo, use, useCallback, useDeferredValue, useState } from "react";
import {
	CollapseChevron,
	FormIconContext,
	HighlightedText,
	TreeItemRow,
} from "@/components/builder/appTree/shared";
import {
	type TreeSelectHandler,
	useAppTreeSelection,
} from "@/components/builder/appTree/useAppTreeSelection";
import {
	countQuestionsFromOrder,
	useFieldIconMap,
} from "@/components/builder/appTree/useFieldIconMap";
import {
	type SearchResult,
	useSearchFilter,
} from "@/components/builder/appTree/useSearchFilter";
import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useForm as useFormDoc } from "@/lib/doc/hooks/useEntity";
import { useModuleIds } from "@/lib/doc/hooks/useModuleIds";
import {
	type Field,
	type Form,
	fieldRegistry,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import { textWithChips } from "@/lib/references/LabelContent";
import {
	useIsFieldSelected,
	useIsFormSelected,
	useIsModuleSelected,
} from "@/lib/routing/hooks";
import { BuilderPhase } from "@/lib/services/builder";
import { type QuestionPath, qpath } from "@/lib/services/questionPath";
import { useBuilderPhase } from "@/lib/session/hooks";

interface AppTreeProps {
	actions?: React.ReactNode;
	hideHeader?: boolean;
}

export function AppTree({ actions, hideHeader }: AppTreeProps) {
	const moduleOrder = useModuleIds();
	const appName = useBlueprintDoc((s) => s.appName);
	const phase = useBuilderPhase();

	const locked =
		phase !== BuilderPhase.Ready && phase !== BuilderPhase.Completed;

	const handleSelect = useAppTreeSelection();
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [searchQuery, setSearchQuery] = useState("");
	const deferredQuery = useDeferredValue(searchQuery);

	const toggle = useCallback((key: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	/* Search: compute match indices from entity maps.
	 * Only fires when the deferred query or entities change. */
	const searchResult = useSearchFilter(deferredQuery);

	if (!moduleOrder || moduleOrder.length === 0) {
		return (
			<div className="h-full flex items-center justify-center text-nova-text-muted text-sm">
				Waiting for generation...
			</div>
		);
	}

	return (
		<div className="h-full flex flex-col">
			{!hideHeader && (
				<div className="flex items-center justify-between px-6 h-12 border-b border-nova-border shrink-0">
					<div className="flex items-center min-w-0">
						<span className="text-sm font-medium text-nova-text truncate">
							{appName}
						</span>
					</div>
					{actions && (
						<div className="flex items-center gap-2 shrink-0">{actions}</div>
					)}
				</div>
			)}

			{/* Search input */}
			<div
				className={`px-3 py-3 shrink-0 ${locked ? "pointer-events-none opacity-40" : ""}`}
			>
				<div className="relative">
					<Icon
						icon={tablerSearch}
						width="14"
						height="14"
						className="absolute left-2.5 top-1/2 -translate-y-1/2 text-nova-text-muted pointer-events-none"
					/>
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								if (searchQuery) setSearchQuery("");
								else (e.target as HTMLInputElement).blur();
							}
						}}
						placeholder="Filter questions..."
						autoComplete="off"
						data-1p-ignore
						className="w-full pl-8 pr-7 py-1.5 text-xs bg-nova-surface border border-nova-border rounded-lg text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:border-nova-violet transition-colors"
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={() => setSearchQuery("")}
							className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
						>
							<Icon icon={tablerX} width="12" height="12" />
						</button>
					)}
				</div>
			</div>

			{/* Scrollable module cards */}
			<div className="flex-1 overflow-auto">
				{searchResult && searchResult.visibleModuleIndices.size === 0 ? (
					<div className="flex items-center justify-center py-8 text-nova-text-muted text-xs">
						No matches
					</div>
				) : (
					<div>
						<AnimatePresence mode="sync">
							{moduleOrder.map((_moduleId, mIdx) => {
								if (
									searchResult &&
									!searchResult.visibleModuleIndices.has(mIdx)
								)
									return null;
								return (
									<ModuleCard
										key={_moduleId}
										moduleUuid={_moduleId}
										moduleIndex={mIdx}
										onSelect={handleSelect}
										collapsed={collapsed}
										toggle={toggle}
										searchResult={searchResult}
										locked={locked}
									/>
								);
							})}
						</AnimatePresence>
					</div>
				)}
			</div>
		</div>
	);
}

// ── ModuleCard ───────────────────────────────────────────────────────

const ModuleCard = memo(function ModuleCard({
	moduleUuid,
	moduleIndex,
	onSelect,
	collapsed,
	toggle,
	searchResult,
	locked,
}: {
	moduleUuid: Uuid;
	moduleIndex: number;
	onSelect: TreeSelectHandler;
	collapsed: Set<string>;
	toggle: (key: string) => void;
	searchResult: SearchResult | null;
	locked?: boolean;
}) {
	/** Subscribe to this module's entity from the doc store. Only re-renders
	 *  when THIS module changes (Immer structural sharing on the entity ref). */
	const mod = useBlueprintDoc((s) => s.modules[moduleUuid]) as
		| Module
		| undefined;

	/** Subscribe to this module's form IDs from the doc store. */
	const formIds = useBlueprintDoc((s) => s.formOrder[moduleUuid]);

	const connectType = useBlueprintDoc((s) => s.connectType);

	/** Boolean selection — URL-driven via useIsModuleSelected.
	 *  Only this module + the previously selected re-render on change. */
	const isSelected = useIsModuleSelected(moduleUuid);

	const collapseKey = `m${moduleIndex}`;
	const isCollapsed = searchResult?.forceExpand?.has(collapseKey)
		? false
		: collapsed.has(collapseKey);
	const nameIndices = searchResult?.matchMap?.get(collapseKey);

	if (!mod || !formIds) return null;

	return (
		<motion.div
			initial={{ opacity: 0, y: 24 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
			className={`transition-colors border-b border-nova-border last:border-b-0 ${isSelected ? "bg-nova-violet/[0.04]" : ""}`}
		>
			<TreeItemRow
				className={`pl-3 pr-3 py-2.5 flex items-center justify-between ${locked ? "pointer-events-none" : "cursor-pointer"}`}
				onClick={() => onSelect({ kind: "module", moduleUuid })}
			>
				<div className="flex items-center gap-2">
					<CollapseChevron
						isCollapsed={isCollapsed}
						onClick={(e) => {
							e.stopPropagation();
							toggle(collapseKey);
						}}
						hidden={locked}
					/>
					<div className="w-8 h-8 rounded-lg bg-nova-violet/10 flex items-center justify-center">
						<Icon
							icon={tablerGridDots}
							width="16"
							height="16"
							className="text-nova-violet-bright"
						/>
					</div>
					<div>
						<h3 className="font-medium text-sm">
							{nameIndices ? (
								<HighlightedText text={mod.name} indices={nameIndices} />
							) : (
								mod.name
							)}
						</h3>
						{mod.caseType && (
							<span className="text-xs text-nova-text-muted font-mono">
								{mod.caseType}
							</span>
						)}
					</div>
				</div>
			</TreeItemRow>

			{!isCollapsed && (
				<>
					{mod.caseListColumns && mod.caseListColumns.length > 0 && (
						<div className="mx-4 mb-3 rounded-lg border border-white/[0.06] bg-white/[0.02] overflow-hidden">
							<div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-white/[0.04]">
								<Icon
									icon={tablerTable}
									width="12"
									height="12"
									className="text-nova-text-muted"
								/>
								<span className="text-[10px] font-medium text-nova-text-muted uppercase tracking-widest">
									Case List
								</span>
							</div>
							<div className="flex">
								{mod.caseListColumns.map((col, colIdx) => (
									<div
										key={`${col.header}-${col.field}`}
										className={`flex-1 px-3 py-2 text-xs font-medium text-nova-text-secondary ${
											colIdx > 0 ? "border-l border-white/[0.04]" : ""
										}`}
									>
										{col.header}
									</div>
								))}
							</div>
						</div>
					)}

					<div className="border-t border-nova-border">
						<AnimatePresence mode="sync">
							{formIds.map((formId, fIdx) => {
								if (searchResult && !searchResult.visibleFormIds.has(formId))
									return null;
								return (
									<FormCard
										key={formId}
										formId={formId}
										moduleUuid={moduleUuid}
										moduleIndex={moduleIndex}
										formIndex={fIdx}
										onSelect={onSelect}
										delay={fIdx * 0.08}
										collapsed={collapsed}
										toggle={toggle}
										searchResult={searchResult}
										connectType={connectType ?? undefined}
										locked={locked}
									/>
								);
							})}
						</AnimatePresence>
					</div>
				</>
			)}
		</motion.div>
	);
});

// ── FormCard ─────────────────────────────────────────────────────────

const FormCard = memo(function FormCard({
	formId,
	moduleUuid,
	moduleIndex,
	formIndex,
	onSelect,
	delay,
	collapsed,
	toggle,
	searchResult,
	connectType,
	locked,
}: {
	formId: Uuid;
	moduleUuid: Uuid;
	moduleIndex: number;
	formIndex: number;
	onSelect: TreeSelectHandler;
	delay: number;
	collapsed: Set<string>;
	toggle: (key: string) => void;
	searchResult: SearchResult | null;
	connectType?: string;
	locked?: boolean;
}) {
	/** Subscribe to this form's entity from the doc store. */
	const form = useFormDoc(formId) as Form | undefined;

	/** Subscribe to this form's question UUIDs from the doc store. */
	const questionUuids = useBlueprintDoc((s) => s.fieldOrder[formId]);

	// Count via selector so the result is a primitive — reference equality
	// then prevents re-renders when unrelated forms' questions change.
	const count = useBlueprintDoc((s) =>
		countQuestionsFromOrder(formId, s.fieldOrder),
	);

	/** Boolean selection — URL-driven via useIsFormSelected.
	 *  Only this form + the previously selected re-render on change. */
	const isSelected = useIsFormSelected(formId);

	const collapseKey = `f${moduleIndex}_${formIndex}`;
	const isCollapsed = searchResult?.forceExpand?.has(collapseKey)
		? false
		: collapsed.has(collapseKey);
	const hasQuestions = questionUuids && questionUuids.length > 0;
	const nameIndices = searchResult?.matchMap?.get(collapseKey);

	/** Build icon map for reference chips in question labels. */
	const fieldIcons = useFieldIconMap(formId);

	if (!form) return null;

	const formIcon = formTypeIcons[form.type];

	return (
		<motion.div
			initial={{ opacity: 0, x: -8 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ delay, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
			className={`border-b border-nova-border last:border-b-0 ${
				isSelected ? "bg-nova-violet/[0.04]" : ""
			}`}
		>
			<TreeItemRow
				className={`pl-5 pr-3 py-2.5 transition-colors flex items-center gap-2 ${locked ? "pointer-events-none" : "cursor-pointer hover:bg-nova-violet/[0.06]"}`}
				onClick={() =>
					onSelect({
						kind: "form",
						moduleUuid,
						formUuid: formId,
					})
				}
			>
				{hasQuestions ? (
					<CollapseChevron
						isCollapsed={isCollapsed}
						onClick={(e) => {
							e.stopPropagation();
							toggle(collapseKey);
						}}
						hidden={locked}
					/>
				) : (
					<span className="w-3.5 shrink-0" />
				)}
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<Icon
							icon={formIcon}
							width="14"
							height="14"
							className="text-nova-text-muted shrink-0"
						/>
						<span className="text-sm font-medium truncate">
							{nameIndices ? (
								<HighlightedText text={form.name} indices={nameIndices} />
							) : (
								form.name
							)}
						</span>
						{form.connect && connectType && (
							<ConnectLogomark
								size={11}
								className="text-nova-violet-bright shrink-0"
							/>
						)}
					</div>
				</div>
				{hasQuestions && (
					<span className="text-xs text-nova-text-muted shrink-0">
						{count} q
					</span>
				)}
			</TreeItemRow>

			{hasQuestions && !isCollapsed && (
				<FormIconContext value={fieldIcons}>
					<div className="pb-2">
						<AnimatePresence mode="sync">
							{questionUuids?.map((uuid, qIdx) => {
								if (
									searchResult &&
									!searchResult.visibleQuestionUuids.has(uuid)
								)
									return null;
								return (
									<FieldRow
										key={uuid}
										uuid={uuid}
										moduleUuid={moduleUuid}
										formUuid={formId}
										onSelect={onSelect}
										depth={0}
										delay={delay + qIdx * 0.02}
										collapsed={collapsed}
										toggle={toggle}
										searchResult={searchResult}
										locked={locked}
									/>
								);
							})}
						</AnimatePresence>
					</div>
				</FormIconContext>
			)}
		</motion.div>
	);
});

// ── FieldRow ──────────────────────────────────────────────────────

const FieldRow = memo(function FieldRow({
	uuid,
	moduleUuid,
	formUuid,
	onSelect,
	depth,
	delay,
	collapsed,
	toggle,
	searchResult,
	locked,
	parentPath,
}: {
	uuid: Uuid;
	moduleUuid: Uuid;
	formUuid: Uuid;
	onSelect: TreeSelectHandler;
	depth: number;
	delay: number;
	collapsed: Set<string>;
	toggle: (key: string) => void;
	searchResult: SearchResult | null;
	locked?: boolean;
	parentPath?: QuestionPath;
}) {
	/** Subscribe to this question's entity by UUID from the doc store. */
	const q = useBlueprintDoc((s) => s.fields[uuid]) as Field | undefined;

	/** Subscribe to children UUIDs (for groups/repeats) from the doc store. */
	const childUuids = useBlueprintDoc((s) => s.fieldOrder[uuid]);

	/** Boolean selection — URL-driven via useIsFieldSelected.
	 *  Only this question + the old selection re-render on change. */
	const isSelected = useIsFieldSelected(uuid);

	const iconOverrides = use(FormIconContext);

	if (!q) return null;

	const questionPath = qpath(q.id, parentPath);
	const iconData = fieldRegistry[q.kind].icon;
	const hasChildren = childUuids && childUuids.length > 0;
	const isCollapsed =
		hasChildren &&
		(searchResult?.forceExpand?.has(questionPath)
			? false
			: collapsed.has(questionPath));
	const labelIndices = searchResult?.matchMap?.get(questionPath);
	const idIndices = searchResult?.matchMap?.get(`${questionPath}__id`);
	// `label` is absent from the `hidden` field kind — guard every access with
	// a `"label" in q` narrowing so the tree row still renders for hidden
	// fields (id-only display).
	const qLabel = "label" in q ? q.label : "";
	const showIdMatch = !!(idIndices && qLabel);
	const textIndices = labelIndices ?? (!qLabel ? idIndices : undefined);
	const displayText = qLabel || q.id;
	const chipContent = !textIndices
		? textWithChips(displayText, null, iconOverrides)
		: null;

	return (
		<motion.div
			initial={{ opacity: 0, x: -5 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ delay, duration: 0.2 }}
		>
			<TreeItemRow
				data-tree-question={questionPath}
				className={`flex items-center gap-1 py-2.5 transition-colors text-xs ${
					locked
						? "pointer-events-none text-nova-text-secondary"
						: isSelected
							? "cursor-pointer bg-nova-violet/[0.08] text-nova-text shadow-[inset_2px_0_0_var(--nova-violet)]"
							: "cursor-pointer hover:bg-nova-violet/[0.06] text-nova-text-secondary"
				}`}
				style={{ paddingLeft: `${28 + depth * 8}px` }}
				onClick={(e) => {
					e.stopPropagation();
					onSelect({
						kind: "question",
						moduleUuid,
						formUuid,
						questionUuid: uuid,
					});
				}}
			>
				{hasChildren ? (
					<CollapseChevron
						isCollapsed={!!isCollapsed}
						onClick={(e) => {
							e.stopPropagation();
							toggle(questionPath);
						}}
						hidden={locked}
					/>
				) : (
					/* Spacer preserves chevron column width so leaf rows align
					 * with sibling group headers — without it, children of a
					 * group appear less indented than the group itself. */
					<span className="w-4 shrink-0" aria-hidden />
				)}
				<span className="w-4 text-center text-nova-text-muted shrink-0 flex items-center justify-center">
					<Icon icon={iconData} width="12" height="12" />
				</span>
				{showIdMatch ? (
					<span className="flex items-center gap-1.5 min-w-0 flex-1">
						<span
							className={`truncate shrink ${hasChildren ? "font-medium text-[#b8b8dd]" : ""}`}
						>
							{textIndices ? (
								<HighlightedText text={displayText} indices={textIndices} />
							) : (
								chipContent
							)}
						</span>
						<span className="truncate shrink-0 max-w-[45%] font-mono text-[10px] text-nova-text-muted">
							(
							<HighlightedText text={q.id} indices={idIndices} />)
						</span>
					</span>
				) : (
					<span
						className={`truncate ${hasChildren ? "font-medium text-[#b8b8dd]" : ""}`}
					>
						{textIndices ? (
							<HighlightedText text={displayText} indices={textIndices} />
						) : (
							chipContent
						)}
					</span>
				)}
				{hasChildren && isCollapsed && (
					<span className="text-[10px] text-nova-text-muted ml-auto shrink-0">
						{childUuids?.length ?? 0}
					</span>
				)}
			</TreeItemRow>

			{/* Nested children for groups/repeats */}
			{hasChildren && !isCollapsed && (
				<div>
					{childUuids?.map((childUuid, cIdx) => (
						<FieldRow
							key={childUuid}
							uuid={childUuid}
							moduleUuid={moduleUuid}
							formUuid={formUuid}
							onSelect={onSelect}
							depth={depth + 1}
							delay={delay + (cIdx + 1) * 0.02}
							collapsed={collapsed}
							toggle={toggle}
							searchResult={searchResult}
							locked={locked}
							parentPath={questionPath}
						/>
					))}
				</div>
			)}
		</motion.div>
	);
});
