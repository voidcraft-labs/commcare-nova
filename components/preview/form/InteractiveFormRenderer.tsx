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
 *     field so the author can edit structure regardless of relevance.
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
 *
 * **Flipbook parity.** Every row renders at `paddingLeft: depthPadding(depth)`
 * with `paddingRight: depthPadding(depth)` — the same gutter formula the
 * virtualized edit view uses. `leadingGap` adds a 24px top pad at the
 * container, matching edit mode's `insertion(0)` row. Together these give
 * the two modes pixel-identical layout at every level of nesting so a
 * user flipping between edit and live never sees a layout jump.
 */

"use client";
import { memo } from "react";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useField } from "@/lib/doc/hooks/useEntity";
import { asUuid, type Uuid } from "@/lib/domain";
import {
	useEngineController,
	useEngineState,
} from "@/lib/preview/hooks/useFormEngine";
import { LabelContent } from "@/lib/references/LabelContent";
import { type FieldPath, fpath } from "@/lib/services/fieldPath";
import { FieldRenderer } from "./FieldRenderer";
import { FIELD_STYLES } from "./fieldStyles";
import { GroupField } from "./fields/GroupField";
import { LabelField } from "./fields/LabelField";
import { RepeatField } from "./fields/RepeatField";
import { depthPadding } from "./virtual/rowStyles";

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
	/** Blueprint field path of the parent, used by descendants to build
	 *  engine-state keys. Absent at the form root. */
	readonly parentPath?: FieldPath;
	/** Nesting depth of the children this renderer is about to emit.
	 *  Rows inside a group-at-depth-N render at depth N+1. */
	readonly depth?: number;
	/** Emit a 24px top pad equivalent to edit mode's `insertion(0)` row.
	 *  Default on; callers that own their own leading spacer (e.g. the
	 *  repeat instance divider) pass `false`. */
	readonly leadingGap?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────

/**
 * Subscribes to the ordered UUID list at this nesting level only. Per-
 * field data and engine state are read inside `InteractiveField`
 * so unrelated questions don't cause siblings to re-render.
 */
export const InteractiveFormRenderer = memo(function InteractiveFormRenderer({
	parentEntityId,
	prefix = "/data",
	parentPath,
	depth = 0,
	leadingGap = true,
}: InteractiveFormRendererProps) {
	const fieldUuids = useBlueprintDoc(
		(s) => s.fieldOrder[parentEntityId as Uuid] ?? EMPTY_UUIDS,
	);

	// `flow-root` creates a new block formatting context so the last child's
	// `mb-6` stays contained inside this renderer's box instead of collapsing
	// out through the bottom edge into the surrounding rail / close cap.
	const containerClass = `flow-root pointer-events-auto${leadingGap ? " pt-6" : ""}`;

	return (
		<div className={containerClass}>
			{fieldUuids.map((rawUuid) => {
				const uuid = asUuid(rawUuid);
				return (
					<InteractiveField
						key={uuid}
						uuid={uuid}
						prefix={prefix}
						parentPath={parentPath}
						depth={depth}
					/>
				);
			})}
		</div>
	);
});

// ── InteractiveField ───────────────────────────────────────────────

interface InteractiveQuestionProps {
	readonly uuid: Uuid;
	readonly prefix: string;
	readonly parentPath?: FieldPath;
	readonly depth: number;
}

/**
 * Per-field renderer for pointer/test mode. Owns the per-entity doc
 * subscription, engine state subscription, and visibility gating; does
 * NOT own edit-mode affordances (selection, dnd, insertion).
 *
 * Leaf questions are wrapped in a single depth-padded block; groups and
 * repeats emit multiple sibling blocks (header, rail-wrapped children,
 * close cap) so the nesting rails can span the full height of the group
 * while each block still aligns to the same `depthPadding(depth)` gutter.
 * The outer `mb-6` provides the 24px trailing gap that matches edit
 * mode's between-row `insertion` spacing.
 */
const InteractiveField = memo(function InteractiveField({
	uuid,
	prefix,
	parentPath,
	depth,
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
	const fieldPath = fpath(fieldId, parentPath);

	const showInvalid = state.touched && !state.valid;

	// Discriminated union narrowing on `field.kind` so each branch sees
	// the kind-specific entity shape. `label` is absent from the `hidden`
	// field kind but we've already guarded against that above.
	let content: React.ReactNode;
	if (field.kind === "group") {
		content = (
			<GroupField
				field={field}
				path={path}
				fieldPath={fieldPath}
				depth={depth}
			/>
		);
	} else if (field.kind === "repeat") {
		content = (
			<RepeatField
				field={field}
				path={path}
				fieldPath={fieldPath}
				depth={depth}
			/>
		);
	} else if (field.kind === "label") {
		// Label fields are standalone presentation; wrap them in the same
		// depth-padded block so they align with sibling questions.
		content = (
			<div
				style={{
					paddingLeft: depthPadding(depth),
					paddingRight: depthPadding(depth),
				}}
			>
				<LabelField field={field} state={state} />
			</div>
		);
	} else {
		content = (
			<div
				className="block space-y-1.5"
				style={{
					paddingLeft: depthPadding(depth),
					paddingRight: depthPadding(depth),
				}}
			>
				{field.label && (
					<div className="flex items-center gap-1">
						<div className="min-w-0 flex-1">
							{/* `px-[5px] py-[5px]` matches TextEditable's idle
							 *  wrapper in edit mode for flipbook parity. Without
							 *  this, every leaf field is 10px shorter in live
							 *  mode than in edit mode — see the matching note
							 *  in `GroupField`. */}
							<div className="px-[5px] py-[5px]">
								<LabelContent
									label={field.label}
									resolvedLabel={state.resolvedLabel}
									isEditMode={false}
									className={FIELD_STYLES.label}
								/>
							</div>
						</div>
						{state.required && (
							<span className="text-nova-rose text-xs shrink-0">*</span>
						)}
					</div>
				)}
				{field.hint && (
					<div className="px-[5px] py-[5px]">
						<LabelContent
							label={field.hint}
							resolvedLabel={state.resolvedHint}
							isEditMode={false}
							className={FIELD_STYLES.hint}
						/>
					</div>
				)}
				<FieldRenderer
					field={field}
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
			data-field-uuid={uuid}
		>
			{content}
		</div>
	);
});
