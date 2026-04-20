/**
 * Form-row card in the AppTree sidebar.
 *
 * Renders the form header (type icon, name, optional Connect marker,
 * field count) plus — when expanded — the nested list of top-level
 * FieldRows for the form's questions. Subscribes by UUID to exactly
 * this form's entity, its field-order array, and its field-count
 * derivation, so unrelated form edits do not re-render this card.
 *
 * Publishes a per-form icon map via `FormIconContext` so the nested
 * FieldRows can render inline reference chips with correct
 * field-kind icons without prop drilling.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import { AnimatePresence, motion } from "motion/react";
import { memo } from "react";
import { FieldRow } from "@/components/builder/appTree/FieldRow";
import {
	CollapseChevron,
	FormIconContext,
	HighlightedText,
	TreeItemRow,
} from "@/components/builder/appTree/shared";
import type { TreeSelectHandler } from "@/components/builder/appTree/useAppTreeSelection";
import {
	countQuestionsFromOrder,
	useFieldIconMap,
} from "@/components/builder/appTree/useFieldIconMap";
import type { SearchResult } from "@/components/builder/appTree/useSearchFilter";
import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useForm as useFormDoc } from "@/lib/doc/hooks/useEntity";
import type { Form, Uuid } from "@/lib/domain";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import { useIsFormSelected } from "@/lib/routing/hooks";

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
	const form = useFormDoc(formId) as Form | undefined;

	/** Subscribe to this form's field UUIDs from the doc store. */
	const fieldUuids = useBlueprintDoc((s) => s.fieldOrder[formId]);

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
	const hasFields = fieldUuids && fieldUuids.length > 0;
	const nameIndices = searchResult?.matchMap?.get(collapseKey);

	/** Build icon map for reference chips in field labels. */
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
				{hasFields && (
					<span className="text-xs text-nova-text-muted shrink-0">
						{count} q
					</span>
				)}
			</TreeItemRow>

			{hasFields && !isCollapsed && (
				<FormIconContext value={fieldIcons}>
					<div className="pb-2">
						<AnimatePresence mode="sync">
							{fieldUuids?.map((uuid, qIdx) => {
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
