/**
 * Form-row card in the AppTree sidebar.
 *
 * Renders the form header (type icon, name, optional Connect marker,
 * field count) plus — when expanded — the nested list of top-level
 * FieldRows for the form's fields. Subscribes by UUID to exactly
 * this form's entity, its field-order array, and its field-count
 * derivation, so unrelated form edits do not re-render this card.
 *
 * Field-label reference chips resolve through the shared `ReferenceProvider`
 * (each FieldRow against its own form), so no per-form icon map is threaded
 * down the tree.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import { AnimatePresence, motion } from "motion/react";
import { memo } from "react";
import { FieldRow } from "@/components/builder/appTree/FieldRow";
import {
	CollapseChevron,
	HighlightedText,
	TreeItemRow,
} from "@/components/builder/appTree/shared";
import { TreeRowDelete } from "@/components/builder/appTree/TreeRowDelete";
import type { TreeSelectHandler } from "@/components/builder/appTree/useAppTreeSelection";
import { mediaSrc } from "@/components/builder/media/mediaClient";
import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm as useFormDoc } from "@/lib/doc/hooks/useEntity";
import { useFormDescendantCount } from "@/lib/doc/hooks/useFieldIconMap";
import { useOrderedFields } from "@/lib/doc/hooks/useOrderedFields";
import type { SearchResult } from "@/lib/doc/hooks/useSearchFilter";
import type { Uuid } from "@/lib/domain";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import { useIsFormSelected, useNavigate } from "@/lib/routing/hooks";

export const FormCard = memo(function FormCard({
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
	const form = useFormDoc(formId);

	/** Subscribe to this form's field UUIDs from the doc store.
	 *  `useOrderedFields` returns a reference-stable empty-array sentinel
	 *  when the form has no children entry, so downstream `.length`
	 *  checks work without an existence guard. */
	const fieldUuids = useOrderedFields(formId);

	/** Recursive descendant count — drives the "N fields" badge. Walks every
	 *  nested group so grouped fields are counted the same as top-level
	 *  ones. */
	const count = useFormDescendantCount(formId);

	/** Boolean selection — URL-driven via useIsFormSelected.
	 *  Only this form + the previously selected re-render on change. */
	const isSelected = useIsFormSelected(formId);

	const { removeForm } = useBlueprintMutations();
	const navigate = useNavigate();
	// Removing the form (cascades its fields) is one gated, undoable batch; if
	// it was the open form, fall back to its module so the URL stays valid.
	// Returns whether the gate committed so the row can disarm on a refusal.
	const handleDelete = () => {
		const { ok } = removeForm(formId);
		if (ok && isSelected) navigate.openModule(moduleUuid);
		return ok;
	};

	const collapseKey = `f${moduleIndex}_${formIndex}`;
	const isCollapsed = searchResult?.forceExpand?.has(collapseKey)
		? false
		: collapsed.has(collapseKey);
	const hasFields = fieldUuids.length > 0;
	const nameIndices = searchResult?.matchMap?.get(collapseKey);

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
				className={`group pl-5 pr-3 py-2.5 transition-colors flex items-center gap-2 ${locked ? "pointer-events-none" : "cursor-pointer hover:bg-nova-violet/[0.06]"}`}
				onClick={() =>
					onSelect({
						kind: "form",
						moduleUuid,
						formUuid: formId,
					})
				}
			>
				{hasFields ? (
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
						{form.icon ? (
							// Form menu-tile icon, shown on the tree row too.
							// biome-ignore lint/performance/noImgElement: session-authed proxy; next/image can't carry the cookie auth
							<img
								src={mediaSrc(form.icon)}
								alt=""
								className="size-3.5 rounded object-cover shrink-0"
							/>
						) : (
							<Icon
								icon={formIcon}
								width="14"
								height="14"
								className="text-nova-text-muted shrink-0"
							/>
						)}
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
				{hasFields && (
					<span className="text-xs text-nova-text-muted shrink-0">
						{count} {count === 1 ? "field" : "fields"}
					</span>
				)}
				{!locked && (
					<TreeRowDelete label="Delete form" onDelete={handleDelete} />
				)}
			</TreeItemRow>

			{hasFields && !isCollapsed && (
				<div className="pb-2">
					<AnimatePresence mode="sync">
						{fieldUuids.map((uuid, fieldIdx) => {
							if (searchResult && !searchResult.visibleFieldUuids.has(uuid))
								return null;
							return (
								<FieldRow
									key={uuid}
									uuid={uuid}
									moduleUuid={moduleUuid}
									formUuid={formId}
									onSelect={onSelect}
									depth={0}
									delay={delay + fieldIdx * 0.02}
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
		</motion.div>
	);
});
