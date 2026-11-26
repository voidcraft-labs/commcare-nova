/** Worker view of a group and its nested questions. A named collapsible
 * group starts in its authored state; each repeat instance has its own
 * toggle. Android's screen header is rendered by the pager. */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { useId, useState } from "react";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import type { FieldPath } from "@/lib/doc/fieldPath";
import { useFieldTextForm } from "@/lib/doc/hooks/useFieldTextForm";
import {
	type GroupField as GroupFieldEntity,
	labelShowsAsTyped,
} from "@/lib/domain";
import type { RepeatInstanceIdentity } from "@/lib/preview/engine/engineController";
import { useEngineStateAt } from "@/lib/preview/hooks/useEngineState";
import { usePresentationHasFields } from "@/lib/preview/hooks/usePresentationDocument";
import { presentedLabelText } from "@/lib/preview/labelPresentation";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";
import { LabelContent } from "@/lib/references/LabelContent";
import { usePreviewPlatformRules } from "@/lib/session/hooks";

import { CONTAINER_HEADER_STYLES, FIELD_STYLES } from "../fieldStyles";
import { InteractiveFormRenderer } from "../InteractiveFormRenderer";
import { depthPadding } from "../virtual/rowStyles";

interface GroupFieldProps {
	/** The group field entity from the normalized doc. Its `hint` is
	 *  optional: only present when the author set one. */
	field: GroupFieldEntity;
	/** XForm data path for this level (e.g. `/data/household_group`).
	 *  Used as the prefix for descendants' paths. */
	path: string;
	/** Blueprint field path for descendants: threaded through so
	 *  engine-state keys stay stable across nesting levels. */
	fieldPath: FieldPath;
	/** Nesting depth of this group: children render at `depth + 1` so
	 *  they share the edit-mode `depthPadding` column exactly (flipbook
	 *  parity). */
	depth: number;
	/** Stable identities of every enclosing repeat instance. */
	instanceScopeKey: string;
	repeatInstances: readonly RepeatInstanceIdentity[];
	accessibleContext: string;
	position: number;
}

/**
 * Interactive rendering of a group container.
 *
 * Rendered only by `InteractiveFormRenderer` (preview mode). The
 * edit-mode group representation is handled by the flat row model
 * (`GroupOpenRow` + nested rows + `GroupCloseRow`), so this file no
 * longer needs to participate in drag-and-drop, inline-text editing, or
 * any other edit-only affordances.
 */
export function GroupField({
	field,
	path,
	fieldPath,
	depth,
	instanceScopeKey,
	repeatInstances,
	accessibleContext,
	position,
}: GroupFieldProps) {
	const { language } = useBuilderLanguage();
	/* The running label renders as the platform Preview plays renders it
	 * (`lib/preview/platform.ts`, `labelMarkdown`). */
	const labelRendering = usePreviewPlatformRules().labelMarkdown;

	// Visibility is gated one level up by `InteractiveQuestion`, so we
	// reach this component only when the group is visible. We still need
	// the engine state for resolved label/hint rendering: path-keyed so
	// a group inside a repeat instance shows that instance's resolution.
	const state = useEngineStateAt(field.uuid, path);
	const textForm = useFieldTextForm(field.uuid);
	const title = presentedLabelText(
		field,
		labelShowsAsTyped(textForm, field),
		state,
	);
	const [toggled, setToggled] = useState(false);
	const { groupFrame } = usePreviewPlatformRules();
	const collapse = groupFrame === "as-authored" ? field.collapse : undefined;
	const border = groupFrame === "as-authored" && field.border;
	const collapsed = !!collapse && toggled !== (collapse === "closed");
	const headerId = useId();
	const contentId = useId();
	const toggleActionId = useId();
	const childContext = [accessibleContext, title && headerId]
		.filter(Boolean)
		.join(" ");

	// Subscribe to children presence: drives the empty-state placeholder
	// block when the group has no template children yet.
	const hasChildren = usePresentationHasFields(field.uuid);

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
					className={`${border ? "border border-pv-input-border" : ""} bg-pv-surface ${title || collapse ? "px-3 py-2" : ""} ${
						collapsed ? "rounded-lg" : "rounded-t-lg border-b-0"
					}`}
				>
					<div className={CONTAINER_HEADER_STYLES.row}>
						{collapse && (
							<button
								type="button"
								onClick={() => setToggled((value) => !value)}
								className={CONTAINER_HEADER_STYLES.toggle}
								aria-expanded={!collapsed}
								aria-controls={contentId}
								aria-labelledby={[toggleActionId, accessibleContext, headerId]
									.filter(Boolean)
									.join(" ")}
							>
								<span id={toggleActionId} className="sr-only">
									{runtimeMessage(language, collapsed ? "expand" : "collapse")}
								</span>
								<Icon
									icon={collapsed ? tablerChevronRight : tablerChevronDown}
									width="14"
									height="14"
									aria-hidden="true"
								/>
							</button>
						)}
						<div
							id={headerId}
							className={title ? CONTAINER_HEADER_STYLES.title : "sr-only"}
						>
							<span className="sr-only">
								{runtimeMessage(language, "sectionPosition", { position })}{" "}
							</span>
							{title ? (
								/* `px-[5px] py-[5px]` matches TextEditable's
								 *  idle/read-only wrapper in edit mode: without
								 *  this, a labelled group header is exactly 10px
								 *  shorter in live mode than in edit mode and
								 *  the flipbook shifts every child downward. */
								<div className="px-[5px] py-[5px]">
									<LabelContent
										label={title.template}
										resolvedLabel={title.resolved}
										isEditMode={false}
										rendering={labelRendering}
										plainLabel={labelShowsAsTyped(textForm, field)}
										className={FIELD_STYLES.label}
									/>
								</div>
							) : null}
						</div>
					</div>
					{/* Groups don't carry `hint` in the domain schema: structural
					 *  containers expose only `relevant`. Only the label renders. */}
				</div>
			</div>

			{/* ── Rails + children ─────────────────────────────────────── */}
			{!collapsed && (
				<>
					<div id={contentId} className="relative">
						{/* Nesting rail: absolute L/R borders spanning from just
						 *  below the header to just above the close cap. Positioned
						 *  via inline style so it tracks the depth-padded column
						 *  exactly; the header's `border border-b-0` and the close
						 *  cap's `border border-t-0` seal the top and bottom edges. */}
						<div
							className={`absolute top-0 bottom-0 pointer-events-none ${border ? "border-l border-r border-pv-input-border" : ""}`}
							style={{
								left: depthPadding(depth),
								right: depthPadding(depth),
							}}
						/>
						{hasChildren ? (
							<InteractiveFormRenderer
								parentEntityId={field.uuid}
								prefix={path}
								parentPath={fieldPath}
								depth={depth + 1}
								instanceScopeKey={instanceScopeKey}
								repeatInstances={repeatInstances}
								accessibleContext={childContext}
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
						<div
							className={
								border
									? "h-2 rounded-b-lg border border-t-0 border-pv-input-border bg-pv-surface/40"
									: undefined
							}
						/>
					</div>
				</>
			)}
			{collapsed ? <div id={contentId} hidden /> : null}
		</>
	);
}
