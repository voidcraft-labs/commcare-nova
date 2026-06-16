/**
 * Module-row card in the AppTree sidebar.
 *
 * Renders the module header (icon tile, name, optional case-type slug,
 * collapse chevron), an inline case-list column preview when the
 * module defines case-list columns, and — when expanded — the nested
 * list of FormCards.
 *
 * Subscribes by UUID to exactly this module's entity + its
 * `formOrder` array. Other modules' edits do not re-render this card.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerGridDots from "@iconify-icons/tabler/grid-dots";
import tablerTable from "@iconify-icons/tabler/table";
import { AnimatePresence, motion } from "motion/react";
import { memo } from "react";
import { FormCard } from "@/components/builder/appTree/FormCard";
import { AddFormMenu } from "@/components/builder/appTree/insertion/AddFormMenu";
import { interleaveInsertions } from "@/components/builder/appTree/insertion/interleaveInsertions";
import {
	CollapseChevron,
	HighlightedText,
	TreeItemRow,
} from "@/components/builder/appTree/shared";
import { TreeRowDelete } from "@/components/builder/appTree/TreeRowDelete";
import type { TreeSelectHandler } from "@/components/builder/appTree/useAppTreeSelection";
import { mediaSrc } from "@/components/builder/media/mediaClient";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import { useModule as useModuleDoc } from "@/lib/doc/hooks/useEntity";
import { useFormIds } from "@/lib/doc/hooks/useModuleIds";
import type { SearchResult } from "@/lib/doc/hooks/useSearchFilter";
import type { CaseListConfig, Uuid } from "@/lib/domain";
import {
	useIsCaseListSelected,
	useIsModuleSelected,
	useNavigate,
} from "@/lib/routing/hooks";

export const ModuleCard = memo(function ModuleCard({
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
	const mod = useModuleDoc(moduleUuid);

	/** Subscribe to this module's form IDs from the doc store. `undefined`
	 *  while the module row is mounted without a formOrder entry — the
	 *  component returns null below in that case. */
	const formIds = useFormIds(moduleUuid);

	const connectType = useConnectTypeOrUndefined();

	/** Boolean selection — URL-driven via useIsModuleSelected.
	 *  Only this module + the previously selected re-render on change. */
	const isSelected = useIsModuleSelected(moduleUuid);
	const isCaseListSelected = useIsCaseListSelected(moduleUuid);

	const { removeModule } = useBlueprintMutations();
	const navigate = useNavigate();
	// Removing the module (cascades its forms/fields + retires an orphaned case
	// type) is one gated, undoable batch; if it was the open module, fall back
	// to the app home so the URL doesn't point at a now-deleted entity. Returns
	// whether the gate committed so the row can disarm on a refusal.
	const handleDelete = () => {
		const { ok } = removeModule(moduleUuid);
		if (ok && isSelected) navigate.goHome();
		return ok;
	};

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
				className={`group pl-3 pr-3 py-2.5 flex items-center justify-between gap-2 ${locked ? "pointer-events-none" : "cursor-pointer"}`}
				onClick={() => onSelect({ kind: "module", moduleUuid })}
			>
				<div className="flex items-center gap-2 min-w-0">
					<CollapseChevron
						isCollapsed={isCollapsed}
						onClick={(e) => {
							e.stopPropagation();
							toggle(collapseKey);
						}}
						hidden={locked}
					/>
					{mod.icon ? (
						// Module menu-tile icon, shown on the tree row too.
						// biome-ignore lint/performance/noImgElement: session-authed proxy; next/image can't carry the cookie auth
						<img
							src={mediaSrc(mod.icon)}
							alt=""
							className="w-8 h-8 rounded-lg object-cover"
						/>
					) : (
						<div className="w-8 h-8 rounded-lg bg-nova-violet/10 flex items-center justify-center">
							<Icon
								icon={tablerGridDots}
								width="16"
								height="16"
								className="text-nova-violet-bright"
							/>
						</div>
					)}
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
				{!locked && (
					<TreeRowDelete label="Delete module" onDelete={handleDelete} />
				)}
			</TreeItemRow>

			{!isCollapsed && (
				<>
					{/* Case List & Search — the workspace's entry point. Lives
					 *  here in the tree (not on the module screen) so it's
					 *  one click from anywhere, including via the collapsed
					 *  icon rail. The column strip beneath the row is a
					 *  scaled-down mirror of the runtime list (visibleInList
					 *  ?? true), so the node doubles as an at-a-glance
					 *  preview of what workers see. */}
					{mod.caseType && !locked && (
						<CaseListNode
							caseListConfig={mod.caseListConfig}
							selected={isCaseListSelected}
							onClick={() => onSelect({ kind: "cases", moduleUuid })}
						/>
					)}

					<div className="border-t border-nova-border">
						<AnimatePresence mode="sync">
							{/* Form insertion points interleave between forms (and a
							 *  leading one, so a form can be added to an empty module) —
							 *  hidden while filtering or locked. */}
							{interleaveInsertions(formIds, {
								suppress: !!locked || !!searchResult,
								itemKey: (formId) => formId,
								renderItem: (formId, fIdx) =>
									searchResult &&
									!searchResult.visibleFormIds.has(formId) ? null : (
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
											connectType={connectType}
											locked={locked}
										/>
									),
								renderInsertion: (atIndex, key) => (
									<AddFormMenu
										key={key}
										moduleUuid={moduleUuid}
										hasCaseType={!!mod.caseType}
										atIndex={atIndex}
									/>
								),
							})}
						</AnimatePresence>
					</div>
				</>
			)}
		</motion.div>
	);
});

/**
 * The tree's Case List & Search node — a navigable row plus the
 * column-strip preview, both one click target. Always renders for
 * case-typed modules (even before any column exists) so the entry
 * point stays discoverable.
 */
function CaseListNode({
	caseListConfig,
	selected,
	onClick,
}: {
	caseListConfig: CaseListConfig | undefined;
	selected: boolean;
	onClick: () => void;
}) {
	const visibleColumns =
		caseListConfig?.columns.filter((col) => col.visibleInList ?? true) ?? [];
	return (
		<button
			type="button"
			onClick={onClick}
			className={`block text-left mx-4 mb-3 w-[calc(100%-2rem)] rounded-lg border overflow-hidden cursor-pointer transition-colors ${
				selected
					? "border-nova-violet/50 bg-nova-violet/[0.08]"
					: "border-white/[0.06] bg-white/[0.02] hover:border-nova-violet/30 hover:bg-nova-violet/[0.04]"
			}`}
		>
			<div
				className={`flex items-center gap-1.5 px-3 py-2 ${visibleColumns.length > 0 ? "border-b border-white/[0.04]" : ""}`}
			>
				<Icon
					icon={tablerTable}
					width="13"
					height="13"
					className={
						selected ? "text-nova-violet-bright" : "text-nova-text-muted"
					}
				/>
				<span
					className={`text-[11px] font-medium uppercase tracking-widest ${
						selected ? "text-nova-violet-bright" : "text-nova-text-muted"
					}`}
				>
					Case List & Search
				</span>
			</div>
			{visibleColumns.length > 0 && (
				<div className="flex">
					{visibleColumns.map((col, colIdx) => {
						const labelSource =
							col.kind === "calculated" ? col.header : col.header || col.field;
						const label = labelSource || "(unnamed)";
						return (
							<div
								key={col.uuid}
								className={`flex-1 px-3 py-2 text-xs font-medium text-nova-text-secondary truncate ${
									colIdx > 0 ? "border-l border-white/[0.04]" : ""
								}`}
							>
								{label}
							</div>
						);
					})}
				</div>
			)}
		</button>
	);
}
