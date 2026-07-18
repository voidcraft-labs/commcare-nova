/**
 * Module-row card in the AppTree sidebar.
 *
 * Renders the module header (icon tile, name, optional case-type slug,
 * collapse chevron), a calm entry point for the case workspace, and —
 * when expanded — the nested list of FormCards.
 *
 * Subscribes by UUID to exactly this module's entity + its
 * `formOrder` array. Other modules' edits do not re-render this card.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerGridDots from "@iconify-icons/tabler/grid-dots";
import tablerListSearch from "@iconify-icons/tabler/list-search";
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
import { PeerBadge } from "@/components/builder/PeerBadge";
import { Button } from "@/components/shadcn/button";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import { useModule as useModuleDoc } from "@/lib/doc/hooks/useEntity";
import { useFormIds } from "@/lib/doc/hooks/useModuleIds";
import type { SearchResult } from "@/lib/doc/hooks/useSearchFilter";
import { humanizeId, type Uuid } from "@/lib/domain";
import {
	useIsCaseListSelected,
	useIsModuleSelected,
	useNavigate,
} from "@/lib/routing/hooks";

/** Keep the structure tree useful without exposing Nova's stored identifier. */
export function moduleCaseTypeLabel(caseType: string): string {
	const label = humanizeId(caseType);
	if (/cases$/i.test(label)) return label;
	if (/case$/i.test(label)) return `${label.slice(0, -4)}cases`;
	return `${label} cases`;
}

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
		<motion.li
			initial={{ opacity: 0, y: 24 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
			className={`transition-colors border-b border-nova-border last:border-b-0 ${isSelected ? "bg-nova-violet/[0.04]" : ""}`}
		>
			<TreeItemRow
				label={mod.name}
				disabled={locked}
				selected={isSelected}
				className={`group flex min-h-11 items-center justify-between gap-1.5 py-1.5 pr-3 pl-2 ${locked ? "text-nova-text-secondary" : "cursor-pointer"}`}
				// A `caseListOnly` module IS its case list (no forms anywhere in
				// the app), so the module screen would be an empty form menu —
				// open the case-list config instead. Selecting it still tints this
				// row (useIsModuleSelected covers `cases`) AND borders the Case
				// List & Search node below, so the two read as one unit.
				onClick={() =>
					onSelect(
						mod.caseListOnly
							? { kind: "cases", moduleUuid }
							: { kind: "module", moduleUuid },
					)
				}
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
					<div className="min-w-0">
						<h3 className="font-medium text-sm truncate">
							{nameIndices ? (
								<HighlightedText text={mod.name} indices={nameIndices} />
							) : (
								mod.name
							)}
						</h3>
						{mod.caseType && (
							<span className="block truncate text-xs text-nova-text-muted">
								{moduleCaseTypeLabel(mod.caseType)}
							</span>
						)}
					</div>
				</div>
				{/* Trailing cluster — the peer marker is the OUTERMOST element on
				 *  every tree-row type, so it sits at one constant offset from the
				 *  right edge whatever other meta (count, hover-delete) a row
				 *  carries; the delete fades in just inboard of it. */}
				<div className="flex items-center gap-1.5 shrink-0">
					{!locked && (
						<TreeRowDelete label="Delete module" onDelete={handleDelete} />
					)}
					<PeerBadge uuid={moduleUuid} />
				</div>
			</TreeItemRow>

			{!isCollapsed && (
				<ul aria-label={`${mod.name} contents`} className="m-0 list-none p-0">
					{/* Cases — the workspace's entry point. Lives
					 *  here in the tree (not on the module screen) so it's
					 *  one click from anywhere, including via the collapsed
					 *  icon rail. Its summary matches the three authoring
					 *  destinations without squeezing field data into the tree. */}
					{mod.caseType && !locked && (
						<CaseListNode
							selected={isCaseListSelected}
							onClick={() => onSelect({ kind: "cases", moduleUuid })}
						/>
					)}

					<li className="border-t border-nova-border">
						<ul className="m-0 list-none p-0" aria-label={`${mod.name} forms`}>
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
											prominent={atIndex === formIds.length}
										/>
									),
								})}
							</AnimatePresence>
						</ul>
					</li>
				</ul>
			)}
		</motion.li>
	);
});

/**
 * The tree's case-workspace node. Always renders for case-typed modules
 * so Search, Results, and Details stay one friendly click away without
 * turning the narrow structure tree into a miniature data table.
 */
function CaseListNode({
	selected,
	onClick,
}: {
	selected: boolean;
	onClick: () => void;
}) {
	return (
		<li>
			<Button
				type="button"
				variant="outline"
				size="xl"
				onClick={onClick}
				aria-current={selected ? "page" : undefined}
				className={`group mx-4 mb-3 h-auto min-h-14 w-[calc(100%-2rem)] justify-start gap-3 whitespace-normal rounded-xl px-3 py-2.5 text-left ${
					selected
						? "border-nova-violet/50 bg-nova-violet/[0.08]"
						: "border-white/[0.06] bg-white/[0.02] hover:border-nova-violet/30 hover:bg-nova-violet/[0.04] dark:bg-white/[0.02] dark:hover:bg-nova-violet/[0.04]"
				}`}
			>
				<span
					className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
						selected
							? "bg-nova-violet/15 text-nova-violet-bright"
							: "bg-white/[0.03] text-nova-text-muted group-hover:bg-nova-violet/[0.08] group-hover:text-nova-text"
					}`}
					aria-hidden="true"
				>
					<Icon icon={tablerListSearch} width="16" height="16" />
				</span>
				<span className="min-w-0">
					<span
						className={`block truncate text-sm font-medium ${
							selected ? "text-nova-text" : "text-nova-text-secondary"
						}`}
					>
						Cases
					</span>
					<span className="block truncate text-xs text-nova-text-muted">
						Search · Results · Details
					</span>
				</span>
			</Button>
		</li>
	);
}
