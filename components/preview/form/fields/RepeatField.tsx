/**
 * RepeatField — interactive rendering of a repeat container.
 *
 * Rendered only by `InteractiveFormRenderer` (pointer / test mode). The
 * edit-mode representation uses `GroupOpenRow` / `GroupCloseRow` on the
 * flat row list and never reaches this file.
 *
 * Interactive semantics:
 *   - All `count` instances render (not just a template).
 *   - Each instance is a bordered card with index header + optional
 *     trash button; the body recursively renders the repeat's template
 *     questions via `InteractiveFormRenderer`.
 *   - An "Add instance" button appears below the last instance so the
 *     user can grow the repeat while filling out the form.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useEngineController, useEngineState } from "@/hooks/useFormEngine";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";
import { LabelContent } from "@/lib/references/LabelContent";
import type { Question } from "@/lib/schemas/blueprint";
import type { QuestionPath } from "@/lib/services/questionPath";
import { FIELD_STYLES } from "../fieldStyles";
import { InteractiveFormRenderer } from "../InteractiveFormRenderer";

interface RepeatFieldProps {
	question: Question;
	path: string;
	questionPath: QuestionPath;
}

// ── RepeatInstance ────────────────────────────────────────────────────

interface RepeatInstanceProps {
	headerLeft: React.ReactNode;
	headerRight?: React.ReactNode;
	hasChildren: boolean;
	children: React.ReactNode;
}

/**
 * Bordered card for a single repeat instance. Header row (index + optional
 * action) on top; body (recursive child renderer) below. `flow-root`
 * creates a BFC so the last child's `mb-6` stays contained.
 */
function RepeatInstance({
	headerLeft,
	headerRight,
	hasChildren,
	children,
}: RepeatInstanceProps) {
	return (
		<div className="rounded-lg border border-pv-input-border overflow-hidden">
			<div className="flex items-center justify-between px-4 py-2 bg-pv-surface border-b border-pv-input-border">
				{headerLeft}
				{headerRight}
			</div>
			<div className={`flow-root ${hasChildren ? "px-4" : "p-4 min-h-[72px]"}`}>
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
	// Visibility is gated one level up by `InteractiveQuestion`, so we
	// only render when the repeat is visible. State is still needed for
	// resolved label text + the "Add …" button.
	const controller = useEngineController();
	const state = useEngineState(question.uuid);

	const hasChildren = useBlueprintDoc(
		(s) => (s.fieldOrder[question.uuid as Uuid]?.length ?? 0) > 0,
	);

	const count = controller.getRepeatCount(question.uuid);

	return (
		<div className="space-y-3">
			{question.label && (
				<LabelContent
					label={question.label}
					resolvedLabel={state.resolvedLabel}
					isEditMode={false}
					className={FIELD_STYLES.label}
				/>
			)}

			{Array.from({ length: count }, (_, idx) => (
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
					<InteractiveFormRenderer
						parentEntityId={question.uuid}
						prefix={`${path}[${idx}]`}
						parentPath={questionPath}
					/>
				</RepeatInstance>
			))}

			<button
				type="button"
				onClick={() => controller.addRepeat(question.uuid)}
				className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-pv-accent hover:text-pv-accent-bright border border-pv-input-border hover:border-pv-input-focus rounded-lg transition-colors cursor-pointer"
			>
				<Icon icon={tablerPlus} width="14" height="14" />
				Add {state.resolvedLabel ?? question.label ?? "entry"}
			</button>
		</div>
	);
}
