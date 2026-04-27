/**
 * GroupBracket — opening + closing bracket rows for group / repeat
 * containers in the virtualized edit view.
 *
 * Drag semantics:
 *   - `GroupOpenRow` is BOTH draggable (the whole group moves when you
 *     drag its header) AND a drop target. The header encodes TWO
 *     positional intents via pragmatic-dnd's closest-edge helper:
 *       - cursor in the top half  → insert the source BEFORE the group
 *         at the parent's level (sibling), not inside it. This is the
 *         only way to place a field above a group when the group is the
 *         parent's first child — the parent-level insertion gap above
 *         the header is too thin to reliably hit, so we let the top half
 *         of the header claim "before" semantics.
 *       - cursor in the bottom half → insert the source as the first
 *         child of the group (the original, and still default, intent).
 *     The violet highlight ring only fires for the "into group" case so
 *     the user never sees conflicting feedback while the placeholder row
 *     above the header shows the parent-level landing slot.
 *   - `GroupCloseRow` is inert — a visual cap, not a drag surface.
 */

"use client";
import { attachClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerRepeat from "@iconify-icons/tabler/repeat";
import { memo, useCallback, useMemo } from "react";
import { useFulfillPendingScroll } from "@/components/builder/contexts/ScrollRegistryContext";
import { InlineSettingsPanel } from "@/components/builder/InlineSettingsPanel";
import { EditableFieldWrapper } from "@/components/preview/form/EditableFieldWrapper";
import { FIELD_STYLES } from "@/components/preview/form/fieldStyles";
import { TextEditable } from "@/components/preview/form/TextEditable";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useField } from "@/lib/doc/hooks/useEntity";
import type { FieldPatch, Uuid } from "@/lib/domain";
import { useEngineController } from "@/lib/preview/hooks/useEngineController";
import { useEngineState } from "@/lib/preview/hooks/useEngineState";
import { LabelContent } from "@/lib/references/LabelContent";
import { useIsFieldSelected } from "@/lib/routing/hooks";
import { useEditMode } from "@/lib/session/hooks";
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
	const mode = useEditMode();
	const { updateField } = useBlueprintMutations();
	/* Inline save for the TextEditable header — null outside edit mode so
	 * the group label stays read-only. Matches FieldRow's inlined pattern
	 * (empty string → undefined, commit via doc store). */
	const saveField = useMemo<
		((field: string, value: string) => void) | null
	>(() => {
		if (mode !== "edit") return null;
		return (property, value) => {
			const patch = {
				[property]: value === "" ? undefined : value,
			} as FieldPatch;
			updateField(uuid, patch);
		};
	}, [mode, uuid, updateField]);

	const isFieldSelected = useIsFieldSelected(uuid);
	useFulfillPendingScroll(uuid, isFieldSelected);

	// Wrap the header's drop data with pragmatic-dnd's closest-edge helper so
	// the monitor can distinguish top-half hovers (insert BEFORE the group)
	// from bottom-half hovers (insert INTO the group at position 0). With
	// only `["top", "bottom"]` allowed, the helper snaps to whichever edge
	// is closer to the cursor — half of a ~40px header is enough real estate
	// for either intent, and the placeholder row renders at a distinct depth
	// for each so the user sees the outcome before releasing.
	const buildDropData = useCallback<
		Parameters<typeof useRowDnd>[0]["buildDropData"]
	>(
		({ input, element }) =>
			attachClosestEdge(
				makeDropGroupHeaderData(uuid, parentUuid, siblingIndex),
				{ element, input, allowedEdges: ["top", "bottom"] },
			),
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

	const { ref, isDraggingSelf, isDragOver, dropEdge, preview } = useRowDnd({
		draggableUuid: uuid,
		cycleTargetContainerUuid: uuid,
		buildDropData,
		// Track the edge locally so we can suppress the "into group" ring
		// when the cursor is in the top half — that hover means "before the
		// group", which is already communicated by the depth-0 placeholder
		// in the parent-level gap above the header.
		trackEdge: true,
		renderPreview,
	});

	// Ring feedback fires only for the "insert into group" intent. When the
	// cursor is in the top half of the header (edge === "top"), the drop
	// lands at the parent level — the header is just a neighboring row, not
	// the landing container, so highlighting it would mislead.
	const showIntoGroupRing = isDragOver && dropEdge !== "top";

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
					paddingRight: depthPadding(depth),
					opacity: isDraggingSelf ? 0.4 : 1,
				}}
				data-field-uuid={uuid}
			>
				<EditableFieldWrapper
					fieldUuid={uuid}
					isDragging={isDraggingSelf}
					flatBottomOnSelect={!collapsed}
				>
					<div
						className={`rounded-t-lg border border-b-0 border-pv-input-border bg-pv-surface px-3 py-2 transition-shadow ${
							collapsed ? "rounded-b-lg border-b" : ""
						} ${showIntoGroupRing ? "ring-2 ring-nova-violet" : ""}`}
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
								 *  or repeat). Both kinds carry an OPTIONAL `label`
								 *  (containerFieldBase) — empty/absent label means the
								 *  container is transparent at runtime, but the author
								 *  still needs an inline affordance to give it one. We
								 *  always render `TextEditable` and let it activate on
								 *  click; the children below render a labelled
								 *  `LabelContent` when set, or the muted "Untitled..."
								 *  placeholder when empty. The placeholder is INSIDE
								 *  `TextEditable` so a click on the placeholder opens
								 *  the inline editor with an empty buffer. */}
								<TextEditable
									value={"label" in q && q.label ? q.label : ""}
									onSave={saveField ? (v) => saveField("label", v) : undefined}
									fieldType="label"
								>
									{"label" in q && q.label ? (
										<LabelContent
											label={q.label}
											resolvedLabel={state.resolvedLabel}
											isEditMode
											className={FIELD_STYLES.label}
										/>
									) : (
										<span className="text-xs italic text-nova-text-muted">
											Untitled {isRepeat ? "repeat" : "group"}
										</span>
									)}
								</TextEditable>
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
						paddingRight: depthPadding(depth),
					}}
				>
					{collapsed ? (
						/* Collapsed: no rails, no children. Drawer floats 8px
						 *  below the fully-rounded header. */
						<div className="pt-2">
							<InlineSettingsPanel field={q} variant="floating" />
						</div>
					) : (
						/* Expanded: drawer is a sub-element of the group.
						 *
						 *  - The gray rails continue uninterrupted
						 *    (`border-l / border-r`) so the group's column
						 *    stays visually intact — the eye sees one
						 *    container from header to close cap.
						 *  - `px-4` insets the drawer 16px from each rail.
						 *    The rail gutters on either side of the drawer
						 *    are the visual hook that says "this is a
						 *    sub-element inside the group," not "this is
						 *    the group's body content." Children below
						 *    still own the full rail column width, so they
						 *    read as the actual fields.
						 *  - No top padding (pt is 0): the drawer's flat
						 *    top butts against the selected ring's flat
						 *    bottom, with both strokes in violet, so the
						 *    drawer still reads as attached to the header.
						 *  - `pb-3` gives a breath between the drawer's
						 *    rounded bottom and the next `insertion(0)` row
						 *    that begins the children's area. */
						<div className="border-l border-r border-pv-input-border">
							<div className="px-4 pb-3">
								<InlineSettingsPanel field={q} variant="attached" />
							</div>
						</div>
					)}
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
				paddingRight: depthPadding(depth),
			}}
			data-group-close-uuid={uuid}
		>
			<div className="h-2 rounded-b-lg border border-t-0 border-pv-input-border bg-pv-surface/40" />
		</div>
	);
});
