/**
 * GroupField — interactive rendering of a group container.
 *
 * Rendered only by `InteractiveFormRenderer` (pointer / test mode). The
 * edit-mode group representation is handled by the flat row model
 * (`GroupOpenRow` + nested rows + `GroupCloseRow`).
 *
 * **Flipbook parity.** This component emits three sibling blocks that
 * mirror the edit-mode row structure pixel-for-pixel:
 *
 *   1. **Header block.** Top-rounded, gray-bordered, surface background,
 *      with a chevron collapse toggle — same chrome the virtualized
 *      `GroupOpenRow` uses.
 *   2. **Rails container.** Wraps the recursive child renderer and
 *      paints continuous left/right borders along the group's column so
 *      a child at any nested depth visually sits inside the group's
 *      outline. Skipped entirely when the group is collapsed.
 *   3. **Close cap.** 2px flat-top / bottom-rounded bracket that caps
 *      the column — matches `GroupCloseRow` exactly.
 *
 * Collapse state is stored in `FormLayoutContext` so it survives
 * mode/cursor switches within a form — toggling a group in edit mode
 * keeps it toggled when the user flips to live, and vice-versa.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { useCallback } from "react";
import { useEngineState } from "@/hooks/useFormEngine";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";
import { LabelContent } from "@/lib/references/LabelContent";
import type { Question } from "@/lib/schemas/blueprint";
import type { QuestionPath } from "@/lib/services/questionPath";
import { useFormLayout } from "../FormLayoutContext";
import { FIELD_STYLES } from "../fieldStyles";
import { InteractiveFormRenderer } from "../InteractiveFormRenderer";
import { depthPadding } from "../virtual/rowStyles";

interface GroupFieldProps {
	question: Question;
	path: string;
	questionPath: QuestionPath;
	depth: number;
}

export function GroupField({
	question,
	path,
	questionPath,
	depth,
}: GroupFieldProps) {
	// Visibility is gated one level up by `InteractiveQuestion`, so we
	// reach this component only when the group is visible. We still need
	// the engine state for resolved label/hint rendering.
	const state = useEngineState(question.uuid);
	const { toggleCollapse, isCollapsed } = useFormLayout();
	const collapsed = isCollapsed(question.uuid as Uuid);

	// Subscribe to children count — drives the empty-state placeholder
	// block when the group has no template children yet.
	const hasChildren = useBlueprintDoc(
		(s) => (s.questionOrder[question.uuid as Uuid]?.length ?? 0) > 0,
	);

	const onToggle = useCallback(() => {
		toggleCollapse(question.uuid as Uuid);
	}, [toggleCollapse, question.uuid]);

	return (
		<>
			{/* ── Header block ──────────────────────────────────────────── */}
			<div
				style={{
					paddingLeft: depthPadding(depth),
					paddingRight: depthPadding(depth),
				}}
			>
				<div
					className={`border border-pv-input-border bg-pv-surface px-3 py-2 ${
						collapsed ? "rounded-lg" : "rounded-t-lg border-b-0"
					}`}
				>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={onToggle}
							className="text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer p-0.5 -m-0.5 rounded"
							aria-label={collapsed ? "Expand group" : "Collapse group"}
						>
							<Icon
								icon={collapsed ? tablerChevronRight : tablerChevronDown}
								width="14"
								height="14"
							/>
						</button>
						<div className="min-w-0 flex-1">
							{question.label ? (
								/* `px-[5px] py-[5px]` matches TextEditable's
								 *  idle/read-only wrapper in edit mode — without
								 *  this, a labelled group header is exactly 10px
								 *  shorter in live mode than in edit mode and
								 *  the flipbook shifts every child downward. */
								<div className="px-[5px] py-[5px]">
									<LabelContent
										label={question.label}
										resolvedLabel={state.resolvedLabel}
										isEditMode={false}
										className={FIELD_STYLES.label}
									/>
								</div>
							) : (
								<span className="text-xs italic text-nova-text-muted">
									Untitled group
								</span>
							)}
						</div>
					</div>
					{question.hint && (
						<div className="mt-0.5 px-[5px] py-[5px]">
							<LabelContent
								label={question.hint}
								resolvedLabel={state.resolvedHint}
								isEditMode={false}
								className={FIELD_STYLES.hint}
							/>
						</div>
					)}
				</div>
			</div>

			{/* ── Rails + children ─────────────────────────────────────── */}
			{!collapsed && (
				<>
					<div className="relative">
						{/* Nesting rail — absolute L/R borders spanning from just
						 *  below the header to just above the close cap. Positioned
						 *  via inline style so it tracks the depth-padded column
						 *  exactly; the header's `border border-b-0` and the close
						 *  cap's `border border-t-0` seal the top and bottom edges. */}
						<div
							className="absolute top-0 bottom-0 border-l border-r border-pv-input-border pointer-events-none"
							style={{
								left: depthPadding(depth),
								right: depthPadding(depth),
							}}
						/>
						{hasChildren ? (
							<InteractiveFormRenderer
								parentEntityId={question.uuid}
								prefix={path}
								parentPath={questionPath}
								depth={depth + 1}
							/>
						) : (
							<div className="h-[72px]" />
						)}
					</div>

					{/* ── Close cap ─────────────────────────────────────── */}
					<div
						style={{
							paddingLeft: depthPadding(depth),
							paddingRight: depthPadding(depth),
						}}
					>
						<div className="h-2 rounded-b-lg border border-t-0 border-pv-input-border bg-pv-surface/40" />
					</div>
				</>
			)}
		</>
	);
}
