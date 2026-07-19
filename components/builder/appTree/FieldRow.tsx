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
 * Inline reference chips in labels resolve against the row's OWN form
 * (`formUuid`) through the shared `ReferenceProvider` — the same gate the
 * editor and canvas use, so the sidebar never renders a chip that doesn't
 * resolve (e.g. a `#<type>/<prop>` ref to a type the form can't read).
 */
"use client";
import { Icon } from "@iconify/react/offline";
import { motion } from "motion/react";
import { memo } from "react";
import {
	CollapseChevron,
	HighlightedText,
	TreeItemRow,
} from "@/components/builder/appTree/shared";
import type { TreeSelectHandler } from "@/components/builder/appTree/useAppTreeSelection";
import { PeerBadge, usePeerEditingColor } from "@/components/builder/PeerBadge";
import { type FieldPath, fpath } from "@/lib/doc/fieldPath";
import { useField } from "@/lib/doc/hooks/useEntity";
import { useOrderedFields } from "@/lib/doc/hooks/useOrderedFields";
import type { SearchResult } from "@/lib/doc/hooks/useSearchFilter";
import { fieldRegistry, type Uuid } from "@/lib/domain";
import { textWithChips } from "@/lib/references/LabelContent";
import { useReferenceProvider } from "@/lib/references/ReferenceContext";
import { useIsFieldSelected } from "@/lib/routing/hooks";

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
	const field = useField(uuid);

	/** Subscribe to children UUIDs (for groups/repeats) from the doc store.
	 *  `useOrderedFields` returns the reference-stable empty-array sentinel
	 *  when the field has no children entry, so downstream `.length`
	 *  checks are safe without an existence guard. */
	const childUuids = useOrderedFields(uuid);

	/** Boolean selection — URL-driven via useIsFieldSelected.
	 *  Only this field + the old selection re-render on change. */
	const isSelected = useIsFieldSelected(uuid);

	/** Shared provider — resolves label chips against this row's own form. */
	const provider = useReferenceProvider();

	/** The hue of a peer whose selection IS this field, or null — drives the
	 *  live "editing this" ring. Called unconditionally (before the guard). */
	const editingColor = usePeerEditingColor(uuid);

	if (!field) return null;

	const fieldPath = fpath(field.id, parentPath);
	const iconData = fieldRegistry[field.kind].icon;
	const hasChildren = childUuids.length > 0;
	const isCollapsed =
		hasChildren &&
		(searchResult?.forceExpand?.has(fieldPath)
			? false
			: collapsed.has(fieldPath));
	const labelIndices = searchResult?.matchMap?.get(fieldPath);
	const idIndices = searchResult?.matchMap?.get(`${fieldPath}__id`);
	// `label` is absent from `hidden` and optional on `group` (empty/absent
	// label = transparent group). The `in` narrowing alone leaves `string |
	// undefined`, so coerce `undefined` to "" — the tree row still renders
	// for those kinds with the id-only display path below.
	const fieldLabel = "label" in field && field.label ? field.label : "";
	const showIdMatch = !!(idIndices && fieldLabel);
	const textIndices = labelIndices ?? (!fieldLabel ? idIndices : undefined);
	const displayText = fieldLabel || field.id;
	const chipContent = !textIndices
		? textWithChips(displayText, provider, formUuid)
		: null;

	return (
		<motion.li
			initial={{ opacity: 0, x: -5 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ delay, duration: 0.2 }}
		>
			<TreeItemRow
				data-tree-field={fieldPath}
				label={displayText}
				disabled={locked}
				selected={isSelected}
				className={`flex min-h-11 items-center gap-1 py-1.5 pr-3 text-xs transition-colors ${
					locked
						? "text-nova-text-secondary"
						: isSelected
							? "cursor-pointer bg-nova-violet/[0.08] text-nova-text shadow-[inset_2px_0_0_var(--nova-violet)]"
							: "cursor-pointer hover:bg-nova-violet/[0.06] text-nova-text-secondary"
				} ${editingColor ? `ring-1 ring-inset ${editingColor.ring}` : ""}`}
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
					<span className="size-11 shrink-0" aria-hidden />
				)}
				<span className="w-4 text-center text-nova-text-muted shrink-0 flex items-center justify-center">
					<Icon icon={iconData} width="12" height="12" />
				</span>
				{showIdMatch ? (
					<span className="flex items-center gap-1.5 min-w-0 flex-1">
						<span
							className={`truncate shrink ${hasChildren ? "font-medium text-nova-text" : ""}`}
						>
							{textIndices ? (
								<HighlightedText text={displayText} indices={textIndices} />
							) : (
								chipContent
							)}
						</span>
						<span className="max-w-[45%] shrink-0 truncate font-mono text-xs text-nova-text-muted">
							(
							<HighlightedText text={field.id} indices={idIndices} />)
						</span>
					</span>
				) : (
					/* `min-w-0 flex-1` is load-bearing: a flex item's default
					 * min-width is auto, so a bare `truncate` never actually
					 * truncates — a long label would push into the trailing meta
					 * (count / peer marker) instead of ellipsizing. flex-1 also
					 * pins the trailing cluster to the row's right edge whatever
					 * the label length. */
					<span
						className={`min-w-0 flex-1 truncate ${hasChildren ? "font-medium text-nova-text" : ""}`}
					>
						{textIndices ? (
							<HighlightedText text={displayText} indices={textIndices} />
						) : (
							chipContent
						)}
					</span>
				)}
				{hasChildren && isCollapsed && (
					<span className="shrink-0 text-xs text-nova-text-muted">
						{childUuids.length}
					</span>
				)}
				{/* Peer marker in the fixed trailing slot — the flex-1 label pins
				 *  it (after any collapsed-count) to the right edge at a constant
				 *  offset, and it renders no wrapper at all while solo. */}
				<PeerBadge uuid={uuid} />
			</TreeItemRow>

			{/* Nested children for groups/repeats — self-recursive */}
			{hasChildren && !isCollapsed && (
				<ul aria-label={`${displayText} fields`} className="m-0 list-none p-0">
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
				</ul>
			)}
		</motion.li>
	);
});
