/**
 * FieldRow — a single leaf field in the virtualized edit view.
 *
 * Drag wiring comes from the shared `useRowDnd` hook, which registers
 * the draggable + drop-target adapters and owns the cycle-safety +
 * self-drop filters. This row opts into `trackEdge: true` so it shows
 * a `DropZonePlaceholder` on its top or bottom edge during a drag —
 * indicating where the dragged item will land on drop.
 *
 * The placeholder is `position: absolute` inside the 24px insertion gap
 * and never changes row height, so the virtualizer stays stable.
 *
 * Does NOT handle group or repeat questions — those are bracket rows in
 * the flat row model. FieldRow is a leaf-only renderer.
 */

"use client";
import { attachClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { memo, useCallback } from "react";
import { useFulfillPendingScroll } from "@/components/builder/contexts/ScrollRegistryContext";
import { InlineSettingsPanel } from "@/components/builder/InlineSettingsPanel";
import { EditableFieldWrapper } from "@/components/preview/form/EditableFieldWrapper";
import { FieldRenderer } from "@/components/preview/form/FieldRenderer";
import { FIELD_STYLES } from "@/components/preview/form/fieldStyles";
import { HiddenField } from "@/components/preview/form/fields/HiddenField";
import { LabelField } from "@/components/preview/form/fields/LabelField";
import { TextEditable } from "@/components/preview/form/TextEditable";
import { useEngineController, useEngineState } from "@/hooks/useFormEngine";
import { useTextEditSave } from "@/hooks/useTextEditSave";
import { useField } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/domain";
import { LabelContent } from "@/lib/references/LabelContent";
import { useIsFieldSelected } from "@/lib/routing/hooks";
import { DragPreviewPill } from "../DragPreviewPill";
import { makeDropFieldData } from "../dragData";
import { depthPadding } from "../rowStyles";
import { useRowDnd } from "../useRowDnd";

interface FieldRowProps {
	readonly uuid: Uuid;
	readonly parentUuid: Uuid;
	readonly siblingIndex: number;
	readonly depth: number;
}

export const FieldRow = memo(function FieldRow({
	uuid,
	parentUuid,
	siblingIndex,
	depth,
}: FieldRowProps) {
	const q = useField(uuid);
	const state = useEngineState(uuid);
	const controller = useEngineController();
	const isFieldSelected = useIsFieldSelected(uuid);
	useFulfillPendingScroll(uuid, isFieldSelected);
	const saveField = useTextEditSave(uuid);

	const buildDropData = useCallback<
		Parameters<typeof useRowDnd>[0]["buildDropData"]
	>(
		({ input, element }) =>
			attachClosestEdge(makeDropFieldData(uuid, parentUuid, siblingIndex), {
				element,
				input,
				allowedEdges: ["top", "bottom"],
			}),
		[uuid, parentUuid, siblingIndex],
	);

	// `label` is absent from the `hidden` kind; fall back to id or a
	// generic placeholder so the drag preview never shows an empty pill.
	const labelText =
		q && "label" in q && typeof q.label === "string" ? q.label.trim() : "";
	const previewLabel = labelText || q?.id || "Field";
	const renderPreview = useCallback(
		() => <DragPreviewPill label={previewLabel} />,
		[previewLabel],
	);

	const { ref, isDraggingSelf, preview } = useRowDnd({
		draggableUuid: uuid,
		cycleTargetContainerUuid: parentUuid,
		buildDropData,
		renderPreview,
	});

	if (!q) return null;

	const displayState = {
		...state,
		value: "",
		touched: false,
		valid: true,
		errorMessage: undefined,
	};

	// Leaf rows never render group/repeat — those kinds are drawn by
	// GroupOpenRow/GroupCloseRow. The fallback branch handles every
	// input-producing kind that exposes `label` + optional `hint`.
	// Narrow on `kind` instead of the legacy wire `type` discriminant.
	const content =
		q.kind === "label" ? (
			<LabelField field={q} state={displayState} />
		) : q.kind === "hidden" ? (
			<HiddenField field={q} />
		) : q.kind === "group" || q.kind === "repeat" ? null : (
			<div className="block space-y-1.5">
				{q.label && (
					<div className="flex items-center gap-1">
						<div className="min-w-0 flex-1">
							<TextEditable
								value={q.label}
								onSave={saveField ? (v) => saveField("label", v) : undefined}
								fieldType="label"
							>
								<LabelContent
									label={q.label}
									resolvedLabel={state.resolvedLabel}
									isEditMode
									className={FIELD_STYLES.label}
								/>
							</TextEditable>
						</div>
						{state.required && (
							<span className="text-nova-rose text-xs shrink-0">*</span>
						)}
					</div>
				)}
				{q.hint && (
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
				)}
				<FieldRenderer
					field={q}
					state={displayState}
					onChange={(value) => controller.onValueChange(uuid, value)}
					onBlur={() => controller.onTouch(uuid)}
				/>
			</div>
		);

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
					flatBottomOnSelect
				>
					{content}
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
					{/* Drawer attaches flush to the field's flat-bottomed
					 *  selection ring — violet strokes continue ring →
					 *  drawer without a seam, so the field and its
					 *  inspector read as one two-pane card. */}
					<InlineSettingsPanel field={q} variant="attached" />
				</div>
			)}
			{preview}
		</>
	);
});
