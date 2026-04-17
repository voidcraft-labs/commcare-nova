/**
 * GroupField — interactive rendering of a group container.
 *
 * Rendered only by `InteractiveFormRenderer` (pointer / test mode). The
 * edit-mode group representation is handled by the flat row model
 * (`GroupOpenRow` + nested rows + `GroupCloseRow`), so this file no
 * longer needs to participate in dnd-kit, inline-text editing, or any
 * other edit-only affordances.
 *
 * The group is a plain bordered card with a header (label + optional
 * hint) and a body that recursively renders the group's children via
 * `InteractiveFormRenderer`. `flow-root` creates a block formatting
 * context so the last child's `mb-6` margin stays contained — without
 * it, the margin would collapse out through the body border.
 */

"use client";
import { useEngineState } from "@/hooks/useFormEngine";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type { GroupField as GroupFieldEntity } from "@/lib/domain";
import { LabelContent } from "@/lib/references/LabelContent";
import type { QuestionPath } from "@/lib/services/questionPath";
import { FIELD_STYLES } from "../fieldStyles";
import { InteractiveFormRenderer } from "../InteractiveFormRenderer";

interface GroupFieldProps {
	/** The group field entity from the normalized doc. Its `hint` is
	 *  optional — only present when the author set one. */
	field: GroupFieldEntity;
	/** XForm data path for this level (e.g. `/data/household_group`).
	 *  Used as the prefix for descendants' paths. */
	path: string;
	/** Blueprint question path for descendants — threaded through so
	 *  engine-state keys stay stable across nesting levels. */
	fieldPath: QuestionPath;
}

/**
 * Interactive rendering of a group container.
 *
 * Rendered only by `InteractiveFormRenderer` (pointer / test mode). The
 * edit-mode group representation is handled by the flat row model
 * (`GroupOpenRow` + nested rows + `GroupCloseRow`), so this file no
 * longer needs to participate in dnd-kit, inline-text editing, or any
 * other edit-only affordances.
 */
export function GroupField({ field, path, fieldPath }: GroupFieldProps) {
	// Visibility is gated one level up by `InteractiveQuestion`, so we
	// reach this component only when the group is visible. We still need
	// the engine state for resolved label/hint rendering.
	const state = useEngineState(field.uuid);

	// Subscribe to children count — drives whether the body uses compact
	// horizontal-only padding (non-empty) or full padding + min height
	// (empty). Only re-renders on 0↔1 transitions.
	const hasChildren = useBlueprintDoc(
		(s) => (s.fieldOrder[field.uuid]?.length ?? 0) > 0,
	);

	return (
		<div className="rounded-lg border border-pv-input-border overflow-hidden bg-pv-surface">
			{field.label && (
				<div className="px-4 py-2 bg-pv-surface border-b border-pv-input-border">
					{/* Groups don't carry `hint` in the domain schema — structural
					 *  containers expose only `relevant`. Only the label renders. */}
					<LabelContent
						label={field.label}
						resolvedLabel={state.resolvedLabel}
						isEditMode={false}
						className={FIELD_STYLES.label}
					/>
				</div>
			)}
			<div
				className={`flow-root bg-pv-bg ${hasChildren ? "px-4" : "p-4 min-h-[72px]"}`}
			>
				<InteractiveFormRenderer
					parentEntityId={field.uuid}
					prefix={path}
					parentPath={fieldPath}
				/>
			</div>
		</div>
	);
}
