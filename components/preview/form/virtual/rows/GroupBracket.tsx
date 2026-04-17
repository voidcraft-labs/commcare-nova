/**
 * GroupBracket — opening + closing bracket rows for group / repeat
 * containers in the virtualized edit view.
 *
 * Drag semantics:
 *   - `GroupOpenRow` is BOTH draggable (the whole group moves when you
 *     drag its header) AND a drop target (dropping onto the header
 *     inserts the source at position 0 inside the group's children).
 *     Drop feedback is a violet highlight ring on the header.
 *   - `GroupCloseRow` is inert — a visual cap, not a drag surface.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerRepeat from "@iconify-icons/tabler/repeat";
import { memo, useCallback } from "react";
import { useFulfillPendingScroll } from "@/components/builder/contexts/ScrollRegistryContext";
import { InlineSettingsPanel } from "@/components/builder/InlineSettingsPanel";
import { EditableFieldWrapper } from "@/components/preview/form/EditableFieldWrapper";
import { FIELD_STYLES } from "@/components/preview/form/fieldStyles";
import { TextEditable } from "@/components/preview/form/TextEditable";
import { useEngineController, useEngineState } from "@/hooks/useFormEngine";
import { useTextEditSave } from "@/hooks/useTextEditSave";
import { useField } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/domain";
import { LabelContent } from "@/lib/references/LabelContent";
import { useIsFieldSelected } from "@/lib/routing/hooks";
import { DragPreviewPill } from "../DragPreviewPill";
import { makeDropGroupHeaderData } from "../dragData";
import { depthPadding } from "../rowStyles";
import { useRowDnd } from "../useRowDnd";
import { useVirtualFormContext } from "../VirtualFormContext";

// ── Open variant ──────────────────────────────────────────────────────

interface GroupOpenProps {
	readonly uuid: Uuid;
	readonly parentUuid: Uuid;
	readonly siblingIndex: number;
	readonly depth: number;
	readonly collapsed: boolean;
}

export const GroupOpenRow = memo(function GroupOpenRow({
	uuid,
	parentUuid,
	siblingIndex,
	depth,
	collapsed,
}: GroupOpenProps) {
	const { toggleCollapse } = useVirtualFormContext();
	const q = useField(uuid);
	const state = useEngineState(uuid);
	const controller = useEngineController();
	const saveField = useTextEditSave(uuid);

	const isFieldSelected = useIsFieldSelected(uuid);
	useFulfillPendingScroll(uuid, isFieldSelected);

	const buildDropData = useCallback<
		Parameters<typeof useRowDnd>[0]["buildDropData"]
	>(
		() => makeDropGroupHeaderData(uuid, parentUuid, siblingIndex),
		[uuid, parentUuid, siblingIndex],
	);

	// Domain `kind` replaces wire `type`. This row only ever renders
	// group/repeat fields (the row builder filters others out), but the
	// doc-store subscription returns a union-wide `Field`, so we narrow
	// with `in` / the kind discriminant before reading `label`.
	const isRepeatType = q?.kind === "repeat";
	const labelText =
		q && "label" in q && typeof q.label === "string" ? q.label.trim() : "";
	const previewLabel =
		labelText || q?.id || (isRepeatType ? "Untitled repeat" : "Untitled group");
	const renderPreview = useCallback(
		() => <DragPreviewPill label={previewLabel} />,
		[previewLabel],
	);

	const { ref, isDraggingSelf, isDragOver, preview } = useRowDnd({
		draggableUuid: uuid,
		cycleTargetContainerUuid: uuid,
		buildDropData,
		renderPreview,
	});

	const onToggleCollapse = useCallback(() => {
		toggleCollapse(uuid);
	}, [toggleCollapse, uuid]);

	if (!q) return null;

	const isRepeat = isRepeatType;
	const repeatCount = isRepeat ? controller.getRepeatCount(uuid) : 0;

	return (
		<>
			<div
				ref={ref}
				className="relative"
				style={{
					paddingLeft: depthPadding(depth),
					paddingRight: depthPadding(0),
					opacity: isDraggingSelf ? 0.4 : 1,
				}}
				data-question-uuid={uuid}
			>
				<EditableFieldWrapper questionUuid={uuid} isDragging={isDraggingSelf}>
					<div
						className={`rounded-t-lg border border-b-0 border-pv-input-border bg-pv-surface px-3 py-2 transition-shadow ${
							collapsed ? "rounded-b-lg border-b" : ""
						} ${isDragOver ? "ring-2 ring-nova-violet" : ""}`}
					>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									onToggleCollapse();
								}}
								data-no-drag
								className="pointer-events-auto text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer p-0.5 -m-0.5 rounded"
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
								{/* GroupBracket always receives a container field (group
								 *  or repeat). Both kinds carry `label` on the domain
								 *  schema, but TypeScript's union narrows here via the
								 *  container-kind check in the enclosing block. Guard
								 *  with `in` so the narrowing is explicit. */}
								{"label" in q && q.label ? (
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
						{/* Containers (group/repeat) carry no `hint` in the domain
						 *  schema — only `relevant`. The hint editor only appears
						 *  on non-container kinds via FieldRow. */}
					</div>
				</EditableFieldWrapper>
			</div>
			{isFieldSelected && (
				<div
					data-settings-panel
					style={{
						paddingLeft: depthPadding(depth),
						paddingRight: depthPadding(0),
					}}
				>
					{/* Inner wrapper preserves the group bracket's side borders
					 * through the settings panel so the visual container stays
					 * unbroken between header and children. */}
					<div className="border-l border-r border-pv-input-border">
						<InlineSettingsPanel field={q} />
					</div>
				</div>
			)}
			{preview}
		</>
	);
});

// ── Close variant ─────────────────────────────────────────────────────

interface GroupCloseProps {
	readonly uuid: Uuid;
	readonly depth: number;
}

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
