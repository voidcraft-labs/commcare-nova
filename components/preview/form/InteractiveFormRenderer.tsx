/**
 * InteractiveFormRenderer — recursive renderer for pointer / test mode.
 *
 * Mode matrix (see `components/builder/CLAUDE.md` → "Edit vs preview mode"):
 *
 *   ctx.mode === "edit"  && cursorMode === "edit"    → VirtualFormList
 *   ctx.mode === "edit"  && cursorMode === "pointer" → this renderer
 *   ctx.mode === "test"                              → this renderer
 *
 * Interactive semantics that distinguish it from the edit view:
 *
 *   - **Answer-driven visibility.** Questions whose engine state is
 *     `visible: false` are removed from the render entirely (relevance
 *     expressions drive visibility). The edit view always shows every
 *     question so the author can edit structure regardless of relevance.
 *   - **Hidden-type questions disappear.** The edit view renders them as
 *     a compact card so authors can edit them; the live / preview view
 *     must not expose them to the data-entering user.
 *   - **Real repeat instances.** `RepeatField` renders `count` instances,
 *     each a full recursive sub-tree. The edit view shows a single
 *     template instance only.
 *   - **Values + validation show.** `displayState` equals the raw engine
 *     state (not the blanked-out edit display) so the user can actually
 *     complete the form; `data-invalid` surfaces validation errors.
 *
 * Non-semantic differences from the legacy recursive `FormRenderer`:
 *   - No `useSortable` / `DragDropProvider` — nothing is reorderable here.
 *   - No `EditableFieldWrapper` — selection is an edit-time affordance.
 *   - No `InsertionPoint` — insertion is an edit-time affordance.
 */

"use client";
import { memo } from "react";
import { useEngineController, useEngineState } from "@/hooks/useFormEngine";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useField } from "@/lib/doc/hooks/useEntity";
import { asUuid, type Uuid } from "@/lib/domain";
import { LabelContent } from "@/lib/references/LabelContent";
import { type QuestionPath, qpath } from "@/lib/services/questionPath";
import { FieldRenderer } from "./FieldRenderer";
import { FIELD_STYLES } from "./fieldStyles";
import { GroupField } from "./fields/GroupField";
import { LabelField } from "./fields/LabelField";
import { RepeatField } from "./fields/RepeatField";

/** Stable empty array for the fieldOrder selector. Prevents new array
 *  allocation on every render of an empty container. */
const EMPTY_UUIDS: readonly Uuid[] = [];

// ── Props ─────────────────────────────────────────────────────────────

interface InteractiveFormRendererProps {
	/** Entity uuid that owns this level's children — formUuid at the root,
	 *  group/repeat uuid inside a nested container. */
	readonly parentEntityId: string;
	/** XForm data path prefix for descendants. Defaults to `"/data"` at the
	 *  root, threaded through nested containers by `GroupField` /
	 *  `RepeatField`. */
	readonly prefix?: string;
	/** Blueprint question path of the parent, used by descendants to build
	 *  engine-state keys. Absent at the form root. */
	readonly parentPath?: QuestionPath;
}

// ── Component ─────────────────────────────────────────────────────────

/**
 * Subscribes to the ordered UUID list at this nesting level only. Per-
 * question data and engine state are read inside `InteractiveQuestion`
 * so unrelated questions don't cause siblings to re-render.
 */
export const InteractiveFormRenderer = memo(function InteractiveFormRenderer({
	parentEntityId,
	prefix = "/data",
	parentPath,
}: InteractiveFormRendererProps) {
	const questionUuids = useBlueprintDoc(
		(s) => s.fieldOrder[parentEntityId as Uuid] ?? EMPTY_UUIDS,
	);
	const isRoot = !parentPath;

	// Nested containers (group/repeat) use a small top inset so their
	// first child isn't flush against the container header. At the form
	// root, that inset comes from the scroll-container padding instead.
	const containerClass = `min-h-full pointer-events-auto${isRoot ? "" : " pt-6"}`;

	return (
		<div className={containerClass}>
			{questionUuids.map((rawUuid) => {
				const uuid = asUuid(rawUuid);
				return (
					<InteractiveQuestion
						key={uuid}
						uuid={uuid}
						prefix={prefix}
						parentPath={parentPath}
					/>
				);
			})}
		</div>
	);
});

// ── InteractiveQuestion ───────────────────────────────────────────────

interface InteractiveQuestionProps {
	readonly uuid: Uuid;
	readonly prefix: string;
	readonly parentPath?: QuestionPath;
}

/**
 * Per-question renderer for pointer/test mode. Owns the per-entity doc
 * subscription, engine state subscription, and visibility gating; does
 * NOT own edit-mode affordances (selection, dnd, insertion).
 */
const InteractiveQuestion = memo(function InteractiveQuestion({
	uuid,
	prefix,
	parentPath,
}: InteractiveQuestionProps) {
	const field = useField(uuid);
	const state = useEngineState(uuid);
	const controller = useEngineController();

	// Visibility gating lives here so the subscription cost of reading
	// the field + engine state is paid per-field. Siblings whose
	// visibility toggles independently don't affect this row.
	if (!field) return null;
	// `hidden` fields are authoring-time only — they never render in
	// interactive mode. The edit view keeps a compact card so authors
	// can still edit them.
	if (field.kind === "hidden") return null;
	if (!state.visible) return null;

	const fieldId = field.id;
	const path = `${prefix}/${fieldId}`;
	const fieldPath = qpath(fieldId, parentPath);

	const showInvalid = state.touched && !state.valid;

	// Discriminated union narrowing on `field.kind` so each branch sees
	// the kind-specific entity shape. `label` is absent from the `hidden`
	// field kind but we've already guarded against that above.
	let content: React.ReactNode;
	if (field.kind === "group") {
		content = <GroupField field={field} path={path} fieldPath={fieldPath} />;
	} else if (field.kind === "repeat") {
		content = <RepeatField field={field} path={path} fieldPath={fieldPath} />;
	} else if (field.kind === "label") {
		content = <LabelField question={field} state={state} />;
	} else {
		content = (
			<div className="block space-y-1.5">
				{field.label && (
					<div className="flex items-center gap-1">
						<div className="min-w-0 flex-1">
							<LabelContent
								label={field.label}
								resolvedLabel={state.resolvedLabel}
								isEditMode={false}
								className={FIELD_STYLES.label}
							/>
						</div>
						{state.required && (
							<span className="text-nova-rose text-xs shrink-0">*</span>
						)}
					</div>
				)}
				{field.hint && (
					<LabelContent
						label={field.hint}
						resolvedLabel={state.resolvedHint}
						isEditMode={false}
						className={FIELD_STYLES.hint}
					/>
				)}
				<FieldRenderer
					question={field}
					state={state}
					onChange={(value) => controller.onValueChange(uuid, value)}
					onBlur={() => controller.onTouch(uuid)}
				/>
			</div>
		);
	}

	return (
		<div
			className="relative mb-6"
			data-invalid={showInvalid ? "true" : undefined}
			data-question-uuid={uuid}
		>
			{content}
		</div>
	);
});
