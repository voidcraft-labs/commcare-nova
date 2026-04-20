/**
 * Recursive field row in the AppTree sidebar.
 *
 * A `FieldRow` subscribes by UUID to exactly one field entity + its
 * child UUIDs. Immer's structural sharing means that editing one
 * field's label only re-renders that row — sibling FieldRows,
 * FormCards, and ModuleCards are untouched.
 *
 * Group / repeat containers expand to reveal their children, and the
 * row is self-recursive (calls itself for each child). Keeping the
 * recursion inside this file avoids an import cycle that would arise
 * if child rows lived in a different module importing back here.
 *
 * The component also reads the `FormIconContext` so inline reference
 * chips in labels render with the correct field-kind icon.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import { motion } from "motion/react";
import { memo, use } from "react";
import {
	CollapseChevron,
	FormIconContext,
	HighlightedText,
	TreeItemRow,
} from "@/components/builder/appTree/shared";
import type { TreeSelectHandler } from "@/components/builder/appTree/useAppTreeSelection";
import { useField } from "@/lib/doc/hooks/useEntity";
import { useOrderedFields } from "@/lib/doc/hooks/useOrderedFields";
import type { SearchResult } from "@/lib/doc/hooks/useSearchFilter";
import { fieldRegistry, type Uuid } from "@/lib/domain";
import { textWithChips } from "@/lib/references/LabelContent";
import { useIsFieldSelected } from "@/lib/routing/hooks";
import { type FieldPath, fpath } from "@/lib/services/fieldPath";

export const FieldRow = memo(function FieldRow({
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
	parentPath?: FieldPath;
}) {
	/** Subscribe to this field's entity by UUID from the doc store. */
	const q = useField(uuid);

	/** Subscribe to children UUIDs (for groups/repeats) from the doc store.
	 *  `useOrderedFields` returns the reference-stable empty-array sentinel
	 *  when the field has no children entry, so downstream `.length`
	 *  checks are safe without an existence guard. */
	const childUuids = useOrderedFields(uuid);

	/** Boolean selection — URL-driven via useIsFieldSelected.
	 *  Only this field + the old selection re-render on change. */
	const isSelected = useIsFieldSelected(uuid);

	const iconOverrides = use(FormIconContext);

	if (!q) return null;

	const fieldPath = fpath(q.id, parentPath);
	const iconData = fieldRegistry[q.kind].icon;
	const hasChildren = childUuids.length > 0;
	const isCollapsed =
		hasChildren &&
		(searchResult?.forceExpand?.has(fieldPath)
			? false
			: collapsed.has(fieldPath));
	const labelIndices = searchResult?.matchMap?.get(fieldPath);
	const idIndices = searchResult?.matchMap?.get(`${fieldPath}__id`);
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
				data-tree-field={fieldPath}
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
						kind: "field",
						moduleUuid,
						formUuid,
						fieldUuid: uuid,
					});
				}}
			>
				{hasChildren ? (
					<CollapseChevron
						isCollapsed={!!isCollapsed}
						onClick={(e) => {
							e.stopPropagation();
							toggle(fieldPath);
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
						{childUuids.length}
					</span>
				)}
			</TreeItemRow>

			{/* Nested children for groups/repeats — self-recursive */}
			{hasChildren && !isCollapsed && (
				<div>
					{childUuids.map((childUuid, cIdx) => (
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
							parentPath={fieldPath}
						/>
					))}
				</div>
			)}
		</motion.div>
	);
});
