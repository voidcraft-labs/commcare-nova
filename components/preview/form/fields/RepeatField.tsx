/**
 * RepeatField — interactive rendering of a repeat container.
 *
 * Rendered only by `InteractiveFormRenderer` (pointer / test mode). The
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
 * `InteractiveFormRenderer` for the template's template questions at
 * `depth + 1` — same depth as a group's children, so leaf questions
 * inside a repeat line up with leaf questions inside a group at the
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
import { useCallback } from "react";
import type { FieldPath } from "@/lib/doc/fieldPath";
import { useHasFieldsInForm } from "@/lib/doc/hooks/useHasFieldsInForm";
import type { RepeatField as RepeatFieldEntity } from "@/lib/domain";
import { useEngineController } from "@/lib/preview/hooks/useEngineController";
import { useEngineState } from "@/lib/preview/hooks/useEngineState";
import { LabelContent } from "@/lib/references/LabelContent";
import { useFormLayout } from "../FormLayoutContext";
import { FIELD_STYLES } from "../fieldStyles";
import { InteractiveFormRenderer } from "../InteractiveFormRenderer";
import { depthPadding } from "../virtual/rowStyles";

interface RepeatFieldProps {
	/** The repeat field entity from the normalized doc. */
	field: RepeatFieldEntity;
	/** XForm data path prefix — we append `[idx]` per instance. */
	path: string;
	/** Blueprint field path threaded through to descendants. */
	fieldPath: FieldPath;
	/** Nesting depth of this repeat — instance content renders at
	 *  `depth + 1` for flipbook parity with edit mode. */
	depth: number;
}

// ── Instance divider ──────────────────────────────────────────────────

interface InstanceDividerProps {
	idx: number;
	depth: number;
	onRemove?: () => void;
}

/**
 * Thin header above each repeat instance's template questions. Aligns to
 * `depthPadding(depth)` so it sits in the same column as the instance's
 * first field. `mb-6` gives the 24px gap to the first field — the
 * caller passes `leadingGap={false}` to the instance's renderer to
 * prevent a double gap.
 */
function InstanceDivider({ idx, depth, onRemove }: InstanceDividerProps) {
	return (
		<div
			className="flex items-center justify-between mb-6"
			style={{
				paddingLeft: depthPadding(depth),
				paddingRight: depthPadding(depth),
			}}
		>
			<span className="text-[10px] font-semibold uppercase tracking-widest text-nova-text-muted">
				Instance {idx + 1}
			</span>
			{onRemove && (
				<button
					type="button"
					onClick={onRemove}
					className="p-1 text-nova-text-muted hover:text-nova-rose transition-colors cursor-pointer"
					aria-label={`Remove instance ${idx + 1}`}
				>
					<Icon icon={tablerTrash} width="14" height="14" />
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
}: RepeatFieldProps) {
	// Visibility is gated one level up by `InteractiveQuestion`, so we
	// only render when the repeat is visible. State is still needed for
	// resolved label text + the "Add …" button.
	const controller = useEngineController();
	const state = useEngineState(field.uuid);
	const { toggleCollapse, isCollapsed } = useFormLayout();
	const collapsed = isCollapsed(field.uuid);

	const hasChildren = useHasFieldsInForm(field.uuid);

	const count = controller.getRepeatCount(field.uuid);

	const onToggle = useCallback(() => {
		toggleCollapse(field.uuid);
	}, [toggleCollapse, field.uuid]);

	const addLabel = state.resolvedLabel ?? field.label ?? "entry";

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
							aria-label={collapsed ? "Expand repeat" : "Collapse repeat"}
						>
							<Icon
								icon={collapsed ? tablerChevronRight : tablerChevronDown}
								width="14"
								height="14"
							/>
						</button>

						<span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-nova-text-muted shrink-0">
							<Icon icon={tablerRepeat} width="11" height="11" />
							Repeat
							{count > 1 && (
								<span className="font-normal normal-case tracking-normal">
									· {count} instances
								</span>
							)}
						</span>

						<div className="min-w-0 flex-1">
							{field.label ? (
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
							) : (
								<span className="text-xs italic text-nova-text-muted">
									Untitled repeat
								</span>
							)}
						</div>
					</div>
					{/* Repeats don't carry `hint` in the domain schema — structural
					 *  containers expose only `relevant`. Only the label renders. */}
				</div>
			</div>

			{/* ── Rails + instances + add button ───────────────────────── */}
			{!collapsed && (
				<>
					{/* `flow-root` prevents the last instance's trailing `mb-6`
					 *  from collapsing out through the rails container's bottom
					 *  edge — it must stay inside so the close cap sits 24px
					 *  below the last field, matching edit mode's
					 *  insertion(N+1) row. */}
					<div className="relative flow-root pt-6">
						<div
							className="absolute top-0 bottom-0 border-l border-r border-pv-input-border pointer-events-none"
							style={{
								left: depthPadding(depth),
								right: depthPadding(depth),
							}}
						/>

						{hasChildren &&
							Array.from({ length: count }, (_, idx) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: repeat instances have no stable identity beyond position
									key={idx}
								>
									<InstanceDivider
										idx={idx}
										depth={depth + 1}
										onRemove={
											count > 1
												? () => controller.removeRepeat(field.uuid, idx)
												: undefined
										}
									/>
									<InteractiveFormRenderer
										parentEntityId={field.uuid}
										prefix={`${path}[${idx}]`}
										parentPath={fieldPath}
										depth={depth + 1}
										leadingGap={false}
									/>
								</div>
							))}

						{!hasChildren && <div className="h-[72px]" />}

						{/* Add button — depth+1 to align with instance content.
						 *  `mb-6` gives 24px before the close cap, matching the
						 *  edit-mode insertion(N+1) that precedes `GroupCloseRow`. */}
						<div
							className="mb-6"
							style={{
								paddingLeft: depthPadding(depth + 1),
								paddingRight: depthPadding(depth + 1),
							}}
						>
							<button
								type="button"
								onClick={() => controller.addRepeat(field.uuid)}
								className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-pv-accent hover:text-pv-accent-bright border border-pv-input-border hover:border-pv-input-focus rounded-lg transition-colors cursor-pointer"
							>
								<Icon icon={tablerPlus} width="14" height="14" />
								Add {addLabel}
							</button>
						</div>
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
