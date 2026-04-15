/**
 * QuestionRow — a single leaf question in the virtualized edit view.
 *
 * Owns:
 *   - dnd-kit `useSortable` registration (this row is draggable; its id is
 *     the question uuid, its group is the parent-container key).
 *   - Per-entity subscription (`useQuestion`) so this row only re-renders
 *     when THIS question changes, not when a sibling does.
 *   - Per-entity engine state subscription for display-only rendering
 *     (label, hint, inputs appear empty in edit mode).
 *   - EditableQuestionWrapper (click-to-select, hover, keyboard activate).
 *   - Inline settings panel when selected.
 *   - Pending-scroll fulfillment when this row becomes the selected one.
 *
 * Does NOT handle group or repeat questions — those are bracket rows in
 * the flat row model. QuestionRow is a leaf-only renderer.
 */

"use client";
import { CollisionPriority } from "@dnd-kit/abstract";
import { useSortable } from "@dnd-kit/react/sortable";
import { memo } from "react";
import { useFulfillPendingScroll } from "@/components/builder/contexts/ScrollRegistryContext";
import { InlineSettingsPanel } from "@/components/builder/InlineSettingsPanel";
import { EditableQuestionWrapper } from "@/components/preview/form/EditableQuestionWrapper";
import { FIELD_STYLES } from "@/components/preview/form/fieldStyles";
import { HiddenField } from "@/components/preview/form/fields/HiddenField";
import { LabelField } from "@/components/preview/form/fields/LabelField";
import { QuestionField } from "@/components/preview/form/QuestionField";
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

interface QuestionRowProps {
	/** This row's stable identity. Survives renames. */
	readonly uuid: Uuid;
	/** UUID of the parent container (form uuid or group/repeat uuid). */
	readonly parentUuid: Uuid;
	/** Position in the parent's child array — drives dnd-kit's sortable
	 *  index for reorder calculations. */
	readonly siblingIndex: number;
	/** Nesting depth — 0 for form-root children, 1+ inside groups/repeats. */
	readonly depth: number;
}

// ── Implementation ────────────────────────────────────────────────────

/**
 * The row dispatches on question type to pick a field renderer. This mirrors
 * the legacy recursive `SortableQuestion` — the only thing unique about the
 * virtualized version is that it lives in a flat row instead of a recursive
 * tree. All dispatch branches render through the same `EditableQuestionWrapper`
 * so selection, hover, and drag state live in exactly one place.
 */
export const QuestionRow = memo(function QuestionRow({
	uuid,
	parentUuid,
	siblingIndex,
	depth,
}: QuestionRowProps) {
	const { formUuid } = useVirtualFormContext();

	// Per-entity doc subscription — only this question's edits re-render this
	// row. Immer structural sharing keeps unchanged references stable so
	// siblings never bleed through.
	const q = useQuestionDoc(uuid) as NQuestion | undefined;

	// Runtime engine state (resolved label/hint, required flag, etc.).
	const state = useEngineState(uuid);
	const controller = useEngineController();

	// Selection state from the URL. Returns `true` for exactly the one
	// selected row and `false` for every other row — identity-stable so
	// unrelated selection changes don't re-render.
	const isQuestionSelected = useIsQuestionSelected(uuid);

	// dnd-kit sortable registration. Group namespaces sortables by container
	// so the `move()` helper can reorder within a bucket and transfer
	// between buckets correctly.
	const group = groupKeyForParent(parentUuid, formUuid);
	const { ref, isDragging } = useSortable({
		id: uuid,
		index: siblingIndex,
		group,
		type: "question",
		accept: "question",
		plugins: [],
		// A leaf question has no nested droppable, so the default collision
		// priority (Normal) is correct — group/repeat containers use Lowest
		// so their inner droppable wins over the outer sortable.
		collisionPriority: CollisionPriority.Normal,
	});

	// Fulfill any pending scroll targeting this question when it becomes
	// selected. Re-fires on isSelected transitions so within-form moves +
	// duplicate flows scroll correctly.
	useFulfillPendingScroll(uuid, isQuestionSelected);

	const saveField = useTextEditSave(uuid);

	if (!q) return null;

	// Edit mode suppresses runtime values and validation — the preview
	// inputs appear empty and clean. Runtime state is preserved internally
	// in case the user flips to pointer mode.
	const displayState = {
		...state,
		value: "",
		touched: false,
		valid: true,
		errorMessage: undefined,
	};

	const content =
		q.type === "label" ? (
			<LabelField question={q} state={displayState} />
		) : q.type === "hidden" ? (
			<HiddenField question={q} />
		) : (
			// Structural wrapper for label + hint + field. Plain div (not
			// <label>) because the children may contain nested interactive
			// elements that <label> would incorrectly focus-forward to, and
			// to sidestep the biome `noLabelWithoutControl` false positive.
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
				<QuestionField
					question={q}
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
					paddingRight: depthPadding(0),
				}}
				data-question-uuid={uuid}
			>
				{isDragging && (
					// Ghost placeholder — outlined dashed border where the
					// question used to be, retaining its height.
					<div className="absolute inset-0 rounded-lg border-2 border-dashed border-nova-violet/30 bg-nova-violet/[0.02]" />
				)}
				<div className={isDragging ? "invisible" : undefined}>
					<EditableQuestionWrapper questionUuid={uuid} isDragging={isDragging}>
						{content}
					</EditableQuestionWrapper>
				</div>
			</div>
			{isQuestionSelected && (
				// Sibling of the sortable wrapper so the expanded panel's
				// height doesn't inflate the sortable's collision shape.
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
