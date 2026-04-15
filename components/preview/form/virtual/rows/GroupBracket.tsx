/**
 * GroupBracket — opening and closing bracket rows for group / repeat
 * containers in the virtualized edit view.
 *
 * A group's visual container is painted across three row types in the
 * flat model:
 *
 *   group-open   → this component's "open" variant. Renders the header
 *                  (editable label, collapse toggle, drag handle) and the
 *                  top-rounded border stub.
 *   (children)   → individual QuestionRows / nested GroupBrackets, each
 *                  indented per their depth.
 *   group-close  → this component's "close" variant. A short spacer row
 *                  that completes the group visually (bottom-rounded).
 *
 * The "open" row is the draggable part — dragging it moves the entire
 * group/repeat (the walker re-emits the group at its new position on the
 * next render, and all its children follow by virtue of being flattened
 * under the new parent).
 */

"use client";
import { CollisionPriority } from "@dnd-kit/abstract";
import { useSortable } from "@dnd-kit/react/sortable";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerRepeat from "@iconify-icons/tabler/repeat";
import { memo, useCallback } from "react";
import { useFulfillPendingScroll } from "@/components/builder/contexts/ScrollRegistryContext";
import { InlineSettingsPanel } from "@/components/builder/InlineSettingsPanel";
import { EditableQuestionWrapper } from "@/components/preview/form/EditableQuestionWrapper";
import { FIELD_STYLES } from "@/components/preview/form/fieldStyles";
import { TextEditable } from "@/components/preview/form/TextEditable";
import { useEngineController, useEngineState } from "@/hooks/useFormEngine";
import { useTextEditSave } from "@/hooks/useTextEditSave";
import { useQuestion as useQuestionDoc } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/doc/types";
import { LabelContent } from "@/lib/references/LabelContent";
import { useIsQuestionSelected } from "@/lib/routing/hooks";
import type { NQuestion } from "@/lib/services/normalizedState";
import { depthPadding } from "../rowStyles";
import {
	groupKeyForParent,
	useVirtualFormContext,
} from "../VirtualFormContext";

// ── Open variant ──────────────────────────────────────────────────────

interface GroupOpenProps {
	readonly uuid: Uuid;
	readonly parentUuid: Uuid;
	readonly siblingIndex: number;
	readonly depth: number;
	readonly collapsed: boolean;
}

/**
 * Opening bracket of a group or repeat. Header bar with editable label,
 * collapse toggle, and repeat-template badge when appropriate.
 */
export const GroupOpenRow = memo(function GroupOpenRow({
	uuid,
	parentUuid,
	siblingIndex,
	depth,
	collapsed,
}: GroupOpenProps) {
	const { formUuid, toggleCollapse } = useVirtualFormContext();
	const q = useQuestionDoc(uuid) as NQuestion | undefined;
	const state = useEngineState(uuid);
	const controller = useEngineController();
	const saveField = useTextEditSave(uuid);

	// Selection state from the URL — groups + repeats are selectable just
	// like leaf questions, so the inline settings panel and
	// scroll-into-view behavior must match QuestionRow exactly.
	const isQuestionSelected = useIsQuestionSelected(uuid);
	useFulfillPendingScroll(uuid, isQuestionSelected);

	// Same sortable wiring as a leaf question — the group itself is
	// draggable. Container-lowest collision priority means the inner
	// droppable (empty-container row, or a nested sortable) wins when the
	// cursor is over the group's body.
	const group = groupKeyForParent(parentUuid, formUuid);
	const { ref, isDragging } = useSortable({
		id: uuid,
		index: siblingIndex,
		group,
		type: "question",
		accept: "question",
		plugins: [],
		collisionPriority: CollisionPriority.Lowest,
	});

	const onToggleCollapse = useCallback(() => {
		toggleCollapse(uuid);
	}, [toggleCollapse, uuid]);

	if (!q) return null;

	const isRepeat = q.type === "repeat";
	// Repeat template shows the runtime instance count when it differs
	// from the default (1). Matches the legacy RepeatField badge so the
	// author still sees "3 instances" on the edit canvas.
	const repeatCount = isRepeat ? controller.getRepeatCount(uuid) : 0;

	return (
		<>
			<div
				ref={ref}
				className="relative"
				style={{
					paddingLeft: depthPadding(depth),
					paddingRight: depthPadding(0),
				}}
				data-question-uuid={uuid}
			>
				{isDragging && (
					<div className="absolute inset-0 rounded-lg border-2 border-dashed border-nova-violet/30 bg-nova-violet/[0.02]" />
				)}
				<div className={isDragging ? "invisible" : undefined}>
					<EditableQuestionWrapper questionUuid={uuid} isDragging={isDragging}>
						<div
							className={`rounded-t-lg border border-b-0 border-pv-input-border bg-pv-surface px-3 py-2 ${
								collapsed ? "rounded-b-lg border-b" : ""
							}`}
						>
							<div className="flex items-center gap-2">
								{/* Collapse toggle — click-through to the doc-level
								 *  VirtualFormContext. `data-no-drag` so the button
								 *  doesn't fight the EditableQuestionWrapper's
								 *  hold-to-drag gesture. */}
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										onToggleCollapse();
									}}
									data-no-drag
									className="text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer p-0.5 -m-0.5 rounded"
									aria-label={collapsed ? "Expand group" : "Collapse group"}
								>
									<Icon
										icon={collapsed ? tablerChevronRight : tablerChevronDown}
										width="14"
										height="14"
									/>
								</button>

								{isRepeat && (
									<span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-nova-text-muted">
										<Icon icon={tablerRepeat} width="11" height="11" />
										Repeat
										{repeatCount > 1 && (
											<span className="font-normal normal-case tracking-normal">
												· {repeatCount} instances
											</span>
										)}
									</span>
								)}

								<div className="min-w-0 flex-1">
									{q.label ? (
										<TextEditable
											value={q.label}
											onSave={
												saveField ? (v) => saveField("label", v) : undefined
											}
											fieldType="label"
										>
											<LabelContent
												label={q.label}
												resolvedLabel={state.resolvedLabel}
												isEditMode
												className={FIELD_STYLES.label}
											/>
										</TextEditable>
									) : (
										<span className="text-xs italic text-nova-text-muted">
											Untitled {isRepeat ? "repeat" : "group"}
										</span>
									)}
								</div>
							</div>
							{/* Hints on groups render beneath the label — the legacy
							 *  `GroupField` supported this and authored content should
							 *  not silently disappear when switching to the virtual view. */}
							{q.hint && (
								<div className="mt-0.5">
									<TextEditable
										value={q.hint}
										onSave={saveField ? (v) => saveField("hint", v) : undefined}
										fieldType="hint"
									>
										<LabelContent
											label={q.hint}
											resolvedLabel={state.resolvedHint}
											isEditMode
											className={FIELD_STYLES.hint}
										/>
									</TextEditable>
								</div>
							)}
						</div>
					</EditableQuestionWrapper>
				</div>
			</div>
			{isQuestionSelected && (
				// Sibling of the sortable — panel height never inflates the
				// sortable's collision shape.
				<div
					data-settings-panel
					style={{
						paddingLeft: depthPadding(depth),
						paddingRight: depthPadding(0),
					}}
				>
					<InlineSettingsPanel question={q} />
				</div>
			)}
		</>
	);
});

// ── Close variant ─────────────────────────────────────────────────────

interface GroupCloseProps {
	readonly uuid: Uuid;
	readonly depth: number;
}

/**
 * Closing bracket of a group or repeat. Not draggable; not interactive.
 * Its sole job is to cap the visual container the open row starts.
 *
 * When the parent group is collapsed, the `GroupOpenRow` already renders
 * a fully-rounded bordered pill (it applies `rounded-b-lg border-b`), so
 * painting a close stub immediately below would produce a phantom empty
 * bar. This row self-hides in that case.
 *
 * Rendering `null` does not change the row count — the virtualizer still
 * allocates a slot for this index — but the slot shrinks to 0px via
 * `measureElement`, which is the expected behavior when a row has no
 * visible content.
 */
export const GroupCloseRow = memo(function GroupCloseRow({
	uuid,
	depth,
}: GroupCloseProps) {
	const { isCollapsed } = useVirtualFormContext();
	if (isCollapsed(uuid)) return null;
	return (
		<div
			style={{
				paddingLeft: depthPadding(depth),
				paddingRight: depthPadding(0),
			}}
			data-group-close-uuid={uuid}
		>
			<div className="h-2 rounded-b-lg border border-t-0 border-pv-input-border bg-pv-surface/40" />
		</div>
	);
});
