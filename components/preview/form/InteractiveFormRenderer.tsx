/**
 * InteractiveFormRenderer: recursive renderer for preview mode.
 *
 * Mode matrix:
 *
 *   mode === "edit"    (form root)  → VirtualFormList
 *   mode === "preview"              → this renderer
 *
 * Interactive semantics that distinguish it from the edit view:
 *
 *   - **Answer-driven visibility.** Fields whose engine state is
 *     `visible: false` are removed from the render entirely (relevance
 *     expressions drive visibility). The edit view always shows every
 *     field so the author can edit structure regardless of relevance.
 *   - **Hidden-kind fields disappear.** The edit view renders them as
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
 *   - No `useSortable` / `DragDropProvider`: nothing is reorderable here.
 *   - No `EditableFieldWrapper`: selection is an edit-time affordance.
 *   - No `InsertionPoint`: insertion is an edit-time affordance.
 *
 * **Flipbook parity.** Every row renders at `paddingLeft: depthPadding(depth)`
 * with `paddingRight: depthPadding(depth)`, the same gutter formula the
 * virtualized edit view uses. `leadingGap` adds a 24px top pad at the
 * container, matching edit mode's `insertion(0)` row. Together these give
 * the two modes pixel-identical layout at every level of nesting so a
 * user flipping between edit and live never sees a layout jump.
 */

"use client";
import { memo, useId } from "react";
import { useLocalizedField } from "@/components/builder/localization/BuilderLocalizationProvider";
import { MediaDisplay } from "@/components/builder/media/MediaDisplay";
import { type FieldPath, fpath } from "@/lib/doc/fieldPath";
import { useOrderedFields } from "@/lib/doc/hooks/useOrderedFields";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import { asUuid, type Uuid } from "@/lib/domain";
import { useEngineController } from "@/lib/preview/hooks/useEngineController";
import { useEngineStateAt } from "@/lib/preview/hooks/useEngineState";
import { LabelContent } from "@/lib/references/LabelContent";
import { useAppId } from "@/lib/session/hooks";
import { FieldHelp } from "./FieldHelp";
import { FieldRenderer } from "./FieldRenderer";
import { FIELD_STYLES } from "./fieldStyles";
import { GroupField } from "./fields/GroupField";
import { LabelField } from "./fields/LabelField";
import { RepeatField } from "./fields/RepeatField";
import { depthPadding } from "./virtual/rowStyles";

// ── Props ─────────────────────────────────────────────────────────────

interface InteractiveFormRendererProps {
	/** Entity uuid that owns this level's children: formUuid at the root,
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
	/** Stable identities of enclosing repeat instances. Concrete indices
	 * compact; this key does not. */
	readonly instanceScopeKey?: string;
	/** IDs that name enclosing sections/repeat instances for controls whose
	 * visible prompts may otherwise be duplicates. */
	readonly accessibleContext?: string;
}

// ── Component ─────────────────────────────────────────────────────────

/**
 * Subscribes to the ordered UUID list at this nesting level only. Per-
 * field data and engine state are read inside `InteractiveField`
 * so unrelated fields don't cause siblings to re-render.
 */
export const InteractiveFormRenderer = memo(function InteractiveFormRenderer({
	parentEntityId,
	prefix = "/data",
	parentPath,
	depth = 0,
	leadingGap = true,
	instanceScopeKey = "",
	accessibleContext = "",
}: InteractiveFormRendererProps) {
	const fieldUuids = useOrderedFields(asUuid(parentEntityId));

	// `flow-root` creates a new block formatting context so the last child's
	// `mb-6` stays contained inside this renderer's box instead of collapsing
	// out through the bottom edge into the surrounding rail / close cap.
	const containerClass = `flow-root pointer-events-auto${leadingGap ? " pt-6" : ""}`;

	return (
		<div className={containerClass}>
			{fieldUuids.map((rawUuid, index) => {
				const uuid = asUuid(rawUuid);
				return (
					<InteractiveField
						key={uuid}
						uuid={uuid}
						prefix={prefix}
						parentPath={parentPath}
						depth={depth}
						instanceScopeKey={instanceScopeKey}
						accessibleContext={accessibleContext}
						position={index + 1}
					/>
				);
			})}
		</div>
	);
});

// ── InteractiveField ───────────────────────────────────────────────

interface InteractiveFieldProps {
	readonly uuid: Uuid;
	readonly prefix: string;
	readonly parentPath?: FieldPath;
	readonly depth: number;
	readonly instanceScopeKey: string;
	readonly accessibleContext: string;
	readonly position: number;
}

/**
 * Per-field renderer for preview mode. Owns the per-entity doc
 * subscription, engine state subscription, and visibility gating; does
 * NOT own edit-mode affordances (selection, dnd, insertion).
 *
 * Leaf fields are wrapped in a single depth-padded block; groups and
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
	instanceScopeKey,
	accessibleContext,
	position,
}: InteractiveFieldProps) {
	const field = useLocalizedField(uuid);
	// Engine state is keyed by the CONCRETE path so each repeat instance
	// carries its own value / visibility / validity; the uuid covers the
	// render before the doc row resolves.
	const enginePath = field ? `${prefix}/${field.id}` : undefined;
	const state = useEngineStateAt(uuid, enginePath);
	const controller = useEngineController();
	const projectProse = useProseProjection();
	// Capture questions stage bytes against the app; every other kind
	// ignores it.
	const appId = useAppId();
	// Repeat instances reuse the authored field UUID, so every DOM identity
	// below must be per mounted field instance rather than UUID-derived.
	const questionLabelId = useId();
	const hintId = useId();
	const helpId = useId();
	const transparentSectionId = useId();

	// Visibility gating lives here so the subscription cost of reading
	// the field + engine state is paid per-field. Siblings whose
	// visibility toggles independently don't affect this row.
	if (!field) return null;
	// `hidden` fields are authoring-time only: they never render in
	// interactive mode. The edit view keeps a compact card so authors
	// can still edit them.
	if (field.kind === "hidden") return null;
	if (!state.visible) return null;

	const fieldId = field.id;
	const path = `${prefix}/${fieldId}`;
	const fieldPath = fpath(fieldId, parentPath);

	// Transparent group: an empty/absent label means the group has no UI
	// chrome at runtime: matches CommCare's behavior for unlabeled
	// `<group>` elements. Render the children inline at the same depth as
	// the group's siblings (so visible children appear flush with the
	// surrounding form structure, not inside an empty section); hidden-
	// only contents disappear entirely. We skip the outer `mb-6` wrapper
	// too: siblings of the parent contribute their own row spacing, so
	// the transparent group adds zero visual footprint.
	//
	// Edit-mode rendering still surfaces empty-labeled groups via
	// `VirtualFormList` → `GroupBracket` so authors can select and edit
	// them; this transparency only applies to interactive/preview mode.
	if (field.kind === "group" && !field.label) {
		const childContext = [accessibleContext, transparentSectionId]
			.filter(Boolean)
			.join(" ");
		return (
			<>
				<span id={transparentSectionId} className="sr-only">
					Section {position}.
				</span>
				{/* A label-less group is transparent in preview, but its
				    `label_media` is authored content: without this it vanishes on
				    the edit→preview flip (edit renders it in the GroupBracket
				    "Untitled group" header). Render it depth-padded to the group's
				    column, above the inline children, keeping the group otherwise
				    transparent. */}
				{field.label_media && (
					<div
						style={{
							paddingLeft: depthPadding(depth),
							paddingRight: depthPadding(depth),
						}}
					>
						<MediaDisplay media={field.label_media} interactive />
					</div>
				)}
				<InteractiveFormRenderer
					parentEntityId={field.uuid}
					prefix={path}
					parentPath={fieldPath}
					depth={depth}
					leadingGap={false}
					instanceScopeKey={instanceScopeKey}
					accessibleContext={childContext}
				/>
			</>
		);
	}

	const showInvalid = state.touched && !state.valid;
	// Point interactive controls at the label workers already see. This keeps
	// the accessible name on the same resolved/fallback path as LabelContent
	// without maintaining a second copy. A blank authored label stays blank,
	// and the sr-only fallback below carries the position instead.
	// Always the question node's id, never gated on the label being
	// authored: that node exists either way, it holds the visible label
	// when there is one and the sr-only "Question N." fallback when
	// there is not. Gating it left a blank-labelled question's control
	// with no accessible name at all, which is strictly worse than the
	// position the fallback already provides.
	const labelId = questionLabelId;
	// The capture control names itself with the FULL context, its recovery
	// messages are read out of the question's flow, so they need the ancestor
	// trail. An ordinary control points at the visible question alone, so a
	// repeated instance's accessible name is exactly the question a worker
	// reads. Deliberately two values: joining them would rename every ordinary
	// control in the running preview.
	const questionLabelledBy = [accessibleContext, questionLabelId]
		.filter(Boolean)
		.join(" ");

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
				instanceScopeKey={instanceScopeKey}
				accessibleContext={accessibleContext}
				position={position}
			/>
		);
	} else if (field.kind === "repeat") {
		content = (
			<RepeatField
				field={field}
				path={path}
				fieldPath={fieldPath}
				depth={depth}
				instanceScopeKey={instanceScopeKey}
				accessibleContext={accessibleContext}
				position={position}
			/>
		);
	} else if (field.kind === "label") {
		// Label fields are standalone presentation; wrap them in the same
		// depth-padded block so they align with sibling fields.
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
				{/* Label media: image above the prompt / audio / video, the way
				    CommCare renders a question's `<value form="image">`. Live
				    controls in preview mode; mounted at the same position as the
				    edit-mode `FieldRow` so the flipbook doesn't drift. */}
				<MediaDisplay media={field.label_media} interactive />
				{field.label ? (
					<div className="min-w-0">
						{/* `px-[5px] py-[5px]` matches TextEditable's idle
						 *  wrapper in edit mode for flipbook parity. Without
						 *  this, every leaf field is 10px shorter in live
						 *  mode than in edit mode: see the matching note
						 *  in `GroupField`. */}
						<div
							id={questionLabelId}
							className="flex items-center gap-1 px-[5px] py-[5px]"
						>
							<span className="sr-only">Question {position}. </span>
							<LabelContent
								label={field.label}
								resolvedLabel={state.resolvedLabel}
								isEditMode={false}
								className={FIELD_STYLES.label}
							/>
							{state.required ? (
								<>
									<span
										aria-hidden="true"
										className="shrink-0 text-xs text-nova-rose"
									>
										*
									</span>
									<span className="sr-only"> Required.</span>
								</>
							) : null}
						</div>
					</div>
				) : (
					<span id={questionLabelId} className="sr-only">
						Question {position}.{state.required ? " Required." : ""}
					</span>
				)}
				{field.hint && (
					<div id={hintId} className="px-[5px] py-[5px]">
						<LabelContent
							label={field.hint}
							resolvedLabel={state.resolvedHint}
							isEditMode={false}
							className={FIELD_STYLES.hint}
						/>
					</div>
				)}
				{/* Hint media: sits with the hint, above the input. `hint_media`
				    is only on input-capable kinds, so guard the access. */}
				<MediaDisplay
					media={"hint_media" in field ? field.hint_media : undefined}
					interactive
				/>
				{/* Help text + help media: shown inline in the builder preview
				    (CommCare hides help behind a "?"); both slots are input-kind
				    only, so guard the access. */}
				<FieldHelp
					id={helpId}
					help={"help" in field ? field.help : undefined}
					resolvedHelp={state.resolvedHelp}
					helpMedia={"help_media" in field ? field.help_media : undefined}
					interactive
				/>
				<FieldRenderer
					field={field}
					state={state}
					labelledBy={labelId}
					path={path}
					appId={appId}
					entryKey={controller.entryKey}
					attachmentSlotKey={`${field.uuid}\u0000${instanceScopeKey}`}
					questionLabelId={labelId}
					questionLabelledBy={questionLabelledBy}
					questionDescriptionIds={[
						field.hint ? hintId : undefined,
						"help" in field && (field.help || field.help_media)
							? helpId
							: undefined,
					]
						.filter((id): id is string => id !== undefined)
						.join(" ")}
					questionLabel={
						state.resolvedLabel ??
						(field.label ? projectProse(field.label) : undefined)
					}
					onChange={(value) => controller.setValueAt(path, value)}
					onBlur={() => controller.touchAt(path)}
					onChangeAt={(targetPath, value) =>
						controller.setValueAt(targetPath, value)
					}
					onBlurAt={(targetPath) => controller.touchAt(targetPath)}
				/>
			</div>
		);
	}

	return (
		<div
			className="relative mb-6"
			data-invalid={showInvalid ? "true" : undefined}
			data-field-uuid={uuid}
			data-instance-path={path}
			tabIndex={showInvalid ? -1 : undefined}
		>
			{content}
		</div>
	);
});
