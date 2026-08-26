/**
 * RepeatField: interactive rendering of a repeat container.
 *
 * Rendered only by `InteractiveFormRenderer` (preview mode). The
 * edit-mode representation uses `GroupOpenRow` / `GroupCloseRow` on the
 * flat row list and never reaches this file.
 *
 * **Shell matches the group.** The outer chrome is identical to
 * `GroupField`: depth-padded header with chevron collapse, nesting rails
 * down the children column, and a flat-top close cap. A small `Repeat`
 * badge next to the chevron signals that the contents are instance-
 * expanded at runtime.
 *
 * **Instances within the shell.** `count` instances render inside the
 * rails as sibling blocks. Each instance starts with a tight divider
 * (index + optional remove) and then dispatches back into
 * `InteractiveFormRenderer` for the template's template fields at
 * `depth + 1`: same depth as a group's children, so leaf fields
 * inside a repeat line up with leaf fields inside a group at the
 * same nesting level. An "Add …" button trails the last instance.
 *
 * The inner renderer is called with `leadingGap={false}`: the instance
 * divider supplies the 24px gap between the divider and the first
 * field, so the default `pt-6` would double up.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerRepeat from "@iconify-icons/tabler/repeat";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useCallback, useId } from "react";
import { MediaDisplay } from "@/components/builder/media/MediaDisplay";
import type { FieldPath } from "@/lib/doc/fieldPath";
import { useHasFieldsInForm } from "@/lib/doc/hooks/useHasFieldsInForm";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { RepeatField as RepeatFieldEntity } from "@/lib/domain";
import { useEngineController } from "@/lib/preview/hooks/useEngineController";
import { useEngineStateAt } from "@/lib/preview/hooks/useEngineState";
import { LabelContent } from "@/lib/references/LabelContent";
import { useFormLayout } from "../FormLayoutContext";
import { FIELD_STYLES } from "../fieldStyles";
import { InteractiveFormRenderer } from "../InteractiveFormRenderer";
import { depthPadding } from "../virtual/rowStyles";
import { runWithAttachmentEntryWriteAuthority } from "./attachment/attachmentClient";
import { useAttachmentEntryWriteAuthority } from "./attachment/useAttachmentEntryWriteAuthority";

interface RepeatFieldProps {
	/** The repeat field entity from the normalized doc. */
	field: RepeatFieldEntity;
	/** XForm data path prefix: we append `[idx]` per instance. */
	path: string;
	/** Blueprint field path threaded through to descendants. */
	fieldPath: FieldPath;
	/** Nesting depth of this repeat: instance content renders at
	 *  `depth + 1` for flipbook parity with edit mode. */
	depth: number;
	/** Stable identities of enclosing repeats, before this repeat adds its
	 * own instance identity. */
	instanceScopeKey: string;
	accessibleContext: string;
	position: number;
}

// ── Instance divider ──────────────────────────────────────────────────

interface InstanceDividerProps {
	idx: number;
	depth: number;
	onRemove?: () => void;
	removeDisabled?: boolean;
	instanceLabelId: string;
	accessibleContext: string;
	repeatHeaderId: string;
}

/**
 * Thin header above each repeat instance's template fields. Aligns to
 * `depthPadding(depth)` so it sits in the same column as the instance's
 * first field. `mb-6` gives the 24px gap to the first field, the
 * caller passes `leadingGap={false}` to the instance's renderer to
 * prevent a double gap.
 */
function InstanceDivider({
	idx,
	depth,
	onRemove,
	removeDisabled = false,
	instanceLabelId,
	accessibleContext,
	repeatHeaderId,
}: InstanceDividerProps) {
	const removeActionId = useId();
	return (
		<div
			className="mb-6 flex min-h-11 items-center justify-between"
			style={{
				paddingLeft: depthPadding(depth),
				paddingRight: depthPadding(depth),
			}}
		>
			<span
				id={instanceLabelId}
				className="text-xs font-medium text-nova-text-muted"
			>
				Instance {idx + 1}
			</span>
			{onRemove && (
				<button
					type="button"
					onClick={onRemove}
					disabled={removeDisabled}
					className="inline-flex min-h-11 min-w-11 touch-manipulation items-center justify-center rounded-lg text-nova-text-muted transition-colors not-disabled:hover:text-nova-rose disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity)"
					aria-labelledby={[
						removeActionId,
						accessibleContext,
						repeatHeaderId,
						instanceLabelId,
					]
						.filter(Boolean)
						.join(" ")}
				>
					<span id={removeActionId} className="sr-only">
						Remove
					</span>
					<Icon icon={tablerTrash} width="14" height="14" aria-hidden="true" />
				</button>
			)}
		</div>
	);
}

// ── RepeatField ──────────────────────────────────────────────────────

export function RepeatField({
	field,
	path,
	fieldPath,
	depth,
	instanceScopeKey,
	accessibleContext,
	position,
}: RepeatFieldProps) {
	// Visibility is gated one level up by `InteractiveQuestion`, so we
	// only render when the repeat is visible. State is still needed for
	// resolved label text + the "Add …" button.
	const controller = useEngineController();
	// Path-keyed subscription so a repeat NESTED inside another repeat
	// reads its own instance's cardinality, not the template's.
	const state = useEngineStateAt(field.uuid, path);
	const entryKey = controller.entryKey;
	const projectProse = useProseProjection();
	const writeAuthority = useAttachmentEntryWriteAuthority(entryKey);
	const { toggleCollapse, isCollapsed } = useFormLayout();
	const collapsed = isCollapsed(field.uuid);
	const headerId = useId();
	const titleId = useId();
	const contentId = useId();
	const toggleActionId = useId();
	const addActionId = useId();
	const instanceLabelBaseId = useId();

	const hasChildren = useHasFieldsInForm(field.uuid);

	// Reactive count: read from `state.repeatCount` (via
	// `useEngineStateAt`), not `controller.getRepeatCount(uuid)`.
	// The latter is a non-reactive method call; `addRepeat` /
	// `removeRepeat` bump `repeatCount` on the repeat's own
	// `FieldState` to give subscribers the re-render signal.
	// `?? 1` covers the brief `DEFAULT_RUNTIME_STATE` window before
	// the engine's first sync to the runtime store.
	const count = state.repeatCount ?? 1;

	const onToggle = useCallback(() => {
		toggleCollapse(field.uuid);
	}, [toggleCollapse, field.uuid]);

	const addLabel =
		state.resolvedLabel ?? (field.label ? projectProse(field.label) : "entry");

	// Add/Remove affordances are only meaningful for `user_controlled`
	// repeats. `count_bound` and `query_bound` repeats freeze their
	// cardinality at form load (JavaRosa spec), so the runtime suppresses
	// these affordances: Nova's preview must mirror that. The instance
	// dividers themselves still render so the user can see each iteration's
	// content.
	const isUserControlled = field.repeat_mode === "user_controlled";

	const removeInstance = useCallback(
		(index: number, expectedInstanceKey: string) => {
			if (entryKey === undefined) return;
			runWithAttachmentEntryWriteAuthority({
				entryKey,
				token: writeAuthority,
				action: () => {
					// A handler can outlive both an access generation and the
					// positional index it rendered. Require the same live entry
					// and stable instance identity before compacting; otherwise a
					// double/stale click could remove the successor now occupying
					// this index.
					if (
						controller.entryKey !== entryKey ||
						controller.getRepeatInstanceKey(field.uuid, index, path) !==
							expectedInstanceKey
					) {
						return;
					}
					controller
						.removeRepeatAsync(field.uuid, index, path)
						.catch(() => undefined);
				},
			});
		},
		[controller, entryKey, field.uuid, path, writeAuthority],
	);

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
					{/* Repeat label media: banner above the header row, matching
					    the edit-mode `GroupBracket` position for flipbook parity. */}
					<MediaDisplay media={field.label_media} interactive />
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={onToggle}
							className="inline-flex min-h-11 min-w-11 touch-manipulation items-center justify-center rounded-lg text-nova-text-muted transition-colors hover:text-nova-text"
							aria-expanded={!collapsed}
							aria-controls={contentId}
							aria-labelledby={[
								toggleActionId,
								accessibleContext,
								headerId,
								titleId,
							]
								.filter(Boolean)
								.join(" ")}
						>
							<span id={toggleActionId} className="sr-only">
								{collapsed ? "Expand" : "Collapse"}
							</span>
							<Icon
								icon={collapsed ? tablerChevronRight : tablerChevronDown}
								width="14"
								height="14"
								aria-hidden="true"
							/>
						</button>

						<span
							id={headerId}
							className="flex shrink-0 items-center gap-1 text-xs font-medium text-nova-text-muted"
						>
							<span className="sr-only">Repeat {position}. </span>
							<Icon
								icon={tablerRepeat}
								width="11"
								height="11"
								aria-hidden="true"
							/>
							Repeat
							{count > 1 && (
								<span className="font-normal normal-case tracking-normal">
									· {count} instances
								</span>
							)}
						</span>

						<div id={titleId} className="min-w-0 flex-1">
							{/* Repeats extend `containerFieldBase` (label optional).
							 *  When set, render the title; when empty/absent, render
							 *  nothing in the title slot: the surrounding chrome
							 *  (chevron, "Repeat" badge, border) stays so the user
							 *  can still operate the repeat (Add/Remove + instance
							 *  dividers below). Edit-mode rendering surfaces an
							 *  "Untitled repeat" affordance via `GroupBracket` so
							 *  authors can give it a title; preview mode (this
							 *  component) reflects what the end user sees and
							 *  shows no placeholder. */}
							{field.label && (
								/* Matches TextEditable's idle wrapper padding in
								 *  edit mode for flipbook parity; see the note
								 *  in `GroupField`. */
								<div className="px-[5px] py-[5px]">
									<LabelContent
										label={field.label}
										resolvedLabel={state.resolvedLabel}
										isEditMode={false}
										className={FIELD_STYLES.label}
									/>
								</div>
							)}
						</div>
					</div>
					{/* Repeats don't carry `hint` in the domain schema: structural
					 *  containers expose only `relevant`. Only the label renders. */}
				</div>
			</div>

			{/* ── Rails + instances + add button ───────────────────────── */}
			{!collapsed && (
				<>
					{/* `flow-root` prevents the last instance's trailing `mb-6`
					 *  from collapsing out through the rails container's bottom
					 *  edge: it must stay inside so the close cap sits 24px
					 *  below the last field, matching edit mode's
					 *  insertion(N+1) row. */}
					<div id={contentId} className="relative flow-root pt-6">
						<div
							className="absolute top-0 bottom-0 border-l border-r border-pv-input-border pointer-events-none"
							style={{
								left: depthPadding(depth),
								right: depthPadding(depth),
							}}
						/>

						{hasChildren &&
							Array.from({ length: count }, (_, idx) => {
								const instanceKey = controller.getRepeatInstanceKey(
									field.uuid,
									idx,
									path,
								);
								return (
									<div key={instanceKey}>
										<InstanceDivider
											idx={idx}
											depth={depth + 1}
											onRemove={
												isUserControlled && count > 1
													? () => removeInstance(idx, instanceKey)
													: undefined
											}
											removeDisabled={writeAuthority === undefined}
											instanceLabelId={`${instanceLabelBaseId}-${idx}`}
											accessibleContext={accessibleContext}
											repeatHeaderId={`${headerId} ${titleId}`}
										/>
										<InteractiveFormRenderer
											parentEntityId={field.uuid}
											prefix={`${path}[${idx}]`}
											parentPath={fieldPath}
											depth={depth + 1}
											leadingGap={false}
											instanceScopeKey={`${instanceScopeKey}\u0000${field.uuid}:${instanceKey}`}
											accessibleContext={[
												accessibleContext,
												headerId,
												titleId,
												`${instanceLabelBaseId}-${idx}`,
											]
												.filter(Boolean)
												.join(" ")}
										/>
									</div>
								);
							})}

						{!hasChildren && <div className="h-[72px]" />}

						{/* Add button: depth+1 to align with instance content.
						 *  `mb-6` gives 24px before the close cap, matching the
						 *  edit-mode insertion(N+1) that precedes `GroupCloseRow`.
						 *  Suppressed entirely for non-`user_controlled` modes:
						 *  count_bound and query_bound repeats derive their
						 *  cardinality from XPath / case query and JavaRosa
						 *  freezes it at form load: there's no Add affordance
						 *  in the actual CommCare runtime, and exposing one
						 *  here would mislead the user about the form's
						 *  behavior. */}
						{isUserControlled && (
							<div
								className="mb-6"
								style={{
									paddingLeft: depthPadding(depth + 1),
									paddingRight: depthPadding(depth + 1),
								}}
							>
								<button
									type="button"
									onClick={() => controller.addRepeatAsync(field.uuid, path)}
									aria-labelledby={[
										addActionId,
										accessibleContext,
										headerId,
										titleId,
									]
										.filter(Boolean)
										.join(" ")}
									className="inline-flex min-h-11 touch-manipulation items-center gap-1.5 rounded-lg border border-pv-input-border px-3 py-2 text-xs font-medium text-pv-accent-bright transition-colors hover:border-pv-input-focus hover:text-pv-accent-bright"
								>
									<Icon
										icon={tablerPlus}
										width="14"
										height="14"
										aria-hidden="true"
									/>
									<span id={addActionId}>Add {addLabel}</span>
								</button>
							</div>
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
			{collapsed ? <div id={contentId} hidden /> : null}
		</>
	);
}
