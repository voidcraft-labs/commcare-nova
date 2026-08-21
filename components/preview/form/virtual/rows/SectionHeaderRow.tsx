/**
 * SectionHeaderRow: the page heading of a section in the virtualized edit
 * view.
 *
 * A section is a page of the form, so its heading is the whole page's
 * handle: drag the heading and the page moves with it. The row is BOTH
 * draggable and a drop target, with two positional intents keyed by
 * pragmatic-dnd's closest edge (the same split `GroupOpenRow` makes):
 *
 *   - cursor in the top half  → land BEFORE this page at the form root.
 *     Only a section can land there (the root of a sectioned form holds
 *     pages only), so for a question this half opens no placeholder.
 *   - cursor in the bottom half → land as the FIRST question of this page.
 *     Only a question can land there (a page cannot hold a page).
 *
 * `useRowDnd` asks the shared placement verdict for each landing, and
 * `useDragIntent` re-asks with the resolved edge, so the violet ring and
 * the placeholder only ever show a drop the gate would accept.
 *
 * The title is inline-editable (`TextEditable`, the localization-aware path
 * every canvas label uses); the heading box itself is the shared
 * `SectionHeading`, so the preview pager's page heading is pixel-identical.
 */

"use client";
import { attachClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { memo, useCallback, useMemo } from "react";
import { useFulfillPendingScroll } from "@/components/builder/contexts/ScrollRegistryContext";
import {
	useBuilderLanguage,
	useLocalizedField,
	useTranslationUnitEditor,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import { EditableFieldWrapper } from "@/components/preview/form/EditableFieldWrapper";
import { SectionHeading } from "@/components/preview/form/sections/SectionHeading";
import { TextEditable } from "@/components/preview/form/TextEditable";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import {
	type CommitOutcome,
	EMPTY_PROSE_TEMPLATE,
	makeTranslationUnitId,
	type ProseTemplate,
	proseTemplateIsEmpty,
	type Uuid,
} from "@/lib/domain";
import { useEngineState } from "@/lib/preview/hooks/useEngineState";
import { LabelContent } from "@/lib/references/LabelContent";
import { useIsFieldSelected } from "@/lib/routing/hooks";
import { useEditMode } from "@/lib/session/hooks";
import { DragPreviewPill } from "../DragPreviewPill";
import { makeDropSectionHeaderData } from "../dragData";
import { depthPadding } from "../rowStyles";
import { useRowDnd } from "../useRowDnd";

interface SectionHeaderRowProps {
	readonly uuid: Uuid;
	/** The form uuid. */
	readonly parentUuid: Uuid;
	readonly siblingIndex: number;
	readonly index: number;
	readonly count: number;
}

export const SectionHeaderRow = memo(function SectionHeaderRow({
	uuid,
	parentUuid,
	siblingIndex,
	index,
	count,
}: SectionHeaderRowProps) {
	const q = useLocalizedField(uuid);
	const language = useBuilderLanguage();
	const labelEditor = useTranslationUnitEditor(
		makeTranslationUnitId("field", uuid, "label"),
	);
	const state = useEngineState(uuid);
	const projectProse = useProseProjection();
	const mode = useEditMode();
	const { updateField } = useBlueprintMutations();

	/* Inline save for the title: null outside edit mode so the title stays
	 * read-only. Mirrors `GroupOpenRow`: a source-language edit writes the
	 * field's `label`, a target-language edit writes the translation overlay. */
	const saveTitle = useMemo<
		((value: ProseTemplate) => CommitOutcome) | null
	>(() => {
		if (mode !== "edit" || q?.kind !== "section") return null;
		return (value) => {
			if (!language.isSource) return labelEditor.saveTarget(value);
			return updateField(uuid, "section", { label: value });
		};
	}, [mode, q?.kind, uuid, updateField, language.isSource, labelEditor]);

	const isFieldSelected = useIsFieldSelected(uuid);
	useFulfillPendingScroll(uuid, isFieldSelected);

	const buildDropData = useCallback<
		Parameters<typeof useRowDnd>[0]["buildDropData"]
	>(
		({ input, element }) =>
			attachClosestEdge(
				makeDropSectionHeaderData(uuid, parentUuid, siblingIndex),
				{ element, input, allowedEdges: ["top", "bottom"] },
			),
		[uuid, parentUuid, siblingIndex],
	);

	const titleText =
		q?.kind === "section" && q.label ? projectProse(q.label).trim() : "";
	const previewLabel = `Section: ${titleText || q?.id || "untitled"}`;
	const renderPreview = useCallback(
		() => <DragPreviewPill label={previewLabel} />,
		[previewLabel],
	);

	// Two landings: the form root (top edge, a page before this one) and
	// this page (bottom edge, its first question). The verdict decides
	// which of them the dragged thing may take. Stable identity: the
	// registration effect lists this array, and a fresh one per render
	// would tear the drop target down mid-drag on every hover change.
	const landings = useMemo(() => [parentUuid, uuid], [parentUuid, uuid]);
	const { ref, isDraggingSelf, isDragOver, dropEdge, dragOverKind, preview } =
		useRowDnd({
			draggableUuid: uuid,
			cycleTargetContainerUuid: uuid,
			landingContainerUuids: landings,
			buildDropData,
			trackEdge: true,
			renderPreview,
		});

	/* The ring says "into this page" and fires only for the bottom half:
	 * the top half lands at the root, which the placeholder above the
	 * heading already shows — and never for a dragged page, whose bottom
	 * half means "after this page" (the line below the page shows it). */
	const showIntoRing =
		isDragOver && dropEdge !== "top" && dragOverKind !== "section";

	if (q?.kind !== "section") return null;

	const hasTitle = q.label !== undefined && !proseTemplateIsEmpty(q.label);

	return (
		<>
			<div
				ref={ref}
				className="relative"
				style={{
					paddingLeft: depthPadding(0),
					paddingRight: depthPadding(0),
					opacity: isDraggingSelf ? 0.4 : 1,
				}}
				data-field-uuid={uuid}
				data-section-header={uuid}
			>
				<EditableFieldWrapper fieldUuid={uuid} isDragging={isDraggingSelf}>
					<div
						className={`rounded-lg px-3 transition-shadow ${
							showIntoRing ? "ring-2 ring-nova-violet" : ""
						}`}
					>
						<SectionHeading
							index={index}
							count={count}
							pageBreak={index > 0}
							title={
								<TextEditable
									value={q.label ?? EMPTY_PROSE_TEMPLATE}
									onSave={saveTitle ?? undefined}
									fieldType="label"
								>
									{hasTitle && q.label ? (
										<LabelContent
											label={q.label}
											resolvedLabel={state.resolvedLabel}
											isEditMode
											className="text-lg font-semibold leading-7 text-nova-text"
										/>
									) : (
										<span className="text-lg font-semibold italic leading-7 text-nova-text-muted">
											Untitled section
										</span>
									)}
								</TextEditable>
							}
						/>
					</div>
				</EditableFieldWrapper>
			</div>
			{preview}
		</>
	);
});
