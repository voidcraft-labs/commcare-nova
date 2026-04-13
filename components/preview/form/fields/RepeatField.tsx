"use client";
import { CollisionPriority } from "@dnd-kit/abstract";
import { useDroppable } from "@dnd-kit/react";
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerRepeat from "@iconify-icons/tabler/repeat";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useBuilderStore } from "@/hooks/useBuilder";
import { useEditContext } from "@/hooks/useEditContext";
import { useEngineController, useEngineState } from "@/hooks/useFormEngine";
import { useTextEditSave } from "@/hooks/useTextEditSave";
import { LabelContent } from "@/lib/references/LabelContent";
import type { Question } from "@/lib/schemas/blueprint";
import type { QuestionPath } from "@/lib/services/questionPath";
import { FormRenderer } from "../FormRenderer";
import { FIELD_STYLES } from "../fieldStyles";
import { TextEditable } from "../TextEditable";

interface RepeatFieldProps {
	question: Question;
	path: string;
	questionPath: QuestionPath;
}

// ── RepeatInstance ────────────────────────────────────────────────────
// Visual wrapper for a single repeat instance: bordered card with a
// header bar and a body area. Shared between edit and preview modes.

interface RepeatInstanceProps {
	/** Content rendered in the header's leading position */
	headerLeft: React.ReactNode;
	/** Optional action rendered in the header's trailing position */
	headerRight?: React.ReactNode;
	/** Ref forwarded to the body div (used for droppable targeting) */
	bodyRef?: React.Ref<HTMLDivElement>;
	/** When true, vertical padding is omitted — inner field spacing handles
	 *  the inset. Empty instances keep full p-4 + min-height for the target. */
	hasChildren?: boolean;
	children: React.ReactNode;
}

function RepeatInstance({
	headerLeft,
	headerRight,
	bodyRef,
	hasChildren,
	children,
}: RepeatInstanceProps) {
	return (
		<div className="rounded-lg border border-pv-input-border overflow-hidden">
			<div className="flex items-center justify-between px-4 py-2 bg-pv-surface border-b border-pv-input-border">
				{headerLeft}
				{headerRight}
			</div>
			{/* flow-root creates a BFC so the last question's mb-6 (interact mode)
			 * stays contained — without it the margin collapses through, and the
			 * body bg ends early, exposing bg-pv-surface behind it. */}
			<div
				ref={bodyRef}
				className={`flow-root ${hasChildren ? "px-4" : "p-4 min-h-[72px]"}`}
			>
				{children}
			</div>
		</div>
	);
}

// ── RepeatField ──────────────────────────────────────────────────────

export function RepeatField({
	question,
	path,
	questionPath,
}: RepeatFieldProps) {
	const controller = useEngineController();
	const state = useEngineState(question.uuid);
	const ctx = useEditContext();
	const isEditMode = ctx?.mode === "edit";
	const saveField = useTextEditSave(question.uuid);

	/** Subscribe to children count from the store — drives hasChildren styling
	 *  for the repeat container. Only fires on count change (0→1, 1→0). */
	const hasChildren = useBuilderStore(
		(s) => (s.questionOrder[question.uuid]?.length ?? 0) > 0,
	);

	/* Droppable target for the repeat's children area — enables dropping items
	 * into empty repeats. The ID matches the group key used by the nested
	 * FormRenderer so the move() helper can route items correctly. */
	const { ref: droppableRef } = useDroppable({
		id: `${question.uuid}:container`,
		type: "container",
		accept: "question",
		collisionPriority: CollisionPriority.Low,
		disabled: !isEditMode,
	});

	if (!state.visible) return null;

	const count = controller.getRepeatCount(question.uuid);

	return (
		<div className="space-y-3">
			{question.label && (
				<TextEditable
					value={question.label ?? ""}
					onSave={saveField ? (v) => saveField("label", v) : undefined}
					fieldType="label"
				>
					<LabelContent
						label={question.label ?? ""}
						resolvedLabel={state.resolvedLabel}
						isEditMode={isEditMode}
						className={FIELD_STYLES.label}
					/>
				</TextEditable>
			)}

			{isEditMode ? (
				/* Edit mode: single template instance. Repeat children share the
				 * same question schema — rendering N copies creates duplicate
				 * useSortable IDs and a shared useDroppable ref that corrupt
				 * dnd-kit's state. One instance keeps the drag system clean.
				 * All instances show identical empty state in edit mode anyway
				 * (displayState overrides values), so nothing is lost visually. */
				<RepeatInstance
					headerLeft={
						<span className="flex items-center gap-1.5 text-xs font-medium text-nova-text-secondary">
							<Icon icon={tablerRepeat} width="13" height="13" />
							Template
							{count > 1 && (
								<span className="text-nova-text-muted font-normal">
									· {count} instances
								</span>
							)}
						</span>
					}
					bodyRef={droppableRef}
					hasChildren={hasChildren}
				>
					<FormRenderer
						parentEntityId={question.uuid}
						prefix={`${path}[0]`}
						parentPath={questionPath}
					/>
				</RepeatInstance>
			) : (
				/* Preview / live mode: render all instances. No DragDropProvider
				 * wraps preview mode, so useSortable hooks in nested FormRenderers
				 * are harmless no-ops despite the duplicate paths. */
				Array.from({ length: count }, (_, idx) => (
					<RepeatInstance
						// biome-ignore lint/suspicious/noArrayIndexKey: repeat instances have no stable identity beyond position
						key={idx}
						headerLeft={
							<span className="text-xs font-medium text-nova-text-secondary">
								#{idx + 1}
							</span>
						}
						headerRight={
							count > 1 ? (
								<button
									type="button"
									onClick={() => controller.removeRepeat(question.uuid, idx)}
									className="p-1 text-nova-text-muted hover:text-nova-rose transition-colors cursor-pointer"
								>
									<Icon icon={tablerTrash} width="14" height="14" />
								</button>
							) : undefined
						}
						hasChildren={hasChildren}
					>
						<FormRenderer
							parentEntityId={question.uuid}
							prefix={`${path}[${idx}]`}
							parentPath={questionPath}
						/>
					</RepeatInstance>
				))
			)}

			{/* Add instance — only in preview where instances are visible and
			 * the user is interacting with form data, not the schema template. */}
			{!isEditMode && (
				<button
					type="button"
					onClick={() => controller.addRepeat(question.uuid)}
					className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-pv-accent hover:text-pv-accent-bright border border-pv-input-border hover:border-pv-input-focus rounded-lg transition-colors cursor-pointer"
				>
					<Icon icon={tablerPlus} width="14" height="14" />
					Add {state.resolvedLabel ?? question.label ?? "entry"}
				</button>
			)}
		</div>
	);
}
