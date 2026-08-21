/**
 * SectionInspectorBody: the right-rail inspector body for a selected
 * section (a page of the form).
 *
 * A page has no logic to edit, so the body is the page's PLACE and its
 * fate: the id (`FieldIdentitySection`, whose Move up / Move down reorder
 * the page among its siblings), "Section k of n", merge with the previous
 * page, remove the page but keep its questions (the body says where they
 * go), and last, the destructive removal of the page WITH its questions,
 * confirmed inline. The title is edited on the canvas heading, inline, the
 * way every group and question label is.
 *
 * Every gesture is a planner (`lib/doc/formSectionMutations.ts`) applied
 * through `applyFormSectionPlan`, so the rail, the picker, and the SA tool
 * cannot disagree about what a gesture does or refuses. View-only members
 * get the same read-only treatment `FieldInspectorBody` applies.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowMergeBoth from "@iconify-icons/tabler/arrow-merge-both";
import tablerLock from "@iconify-icons/tabler/lock";
import tablerStackPop from "@iconify-icons/tabler/stack-pop";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useCallback, useId, useState } from "react";
import { useScrollIntoView } from "@/components/builder/contexts/ScrollRegistryContext";
import { InspectorSection } from "@/components/builder/inspector/inspectorChrome";
import { sectionKicker } from "@/components/preview/form/sections/SectionHeading";
import { Button } from "@/components/shadcn/button";
import {
	mergeWithPrevious,
	removeSectionKeepingQuestions,
} from "@/lib/doc/formSectionMutations";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useFieldsAndOrder } from "@/lib/doc/hooks/useFieldsAndOrder";
import type { SectionField, Uuid } from "@/lib/domain";
import { useDeleteSelectedField } from "@/lib/routing/builderActions";
import { useSelect } from "@/lib/routing/hooks";
import { useCanEdit, useSetActiveFieldId } from "@/lib/session/hooks";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import { FieldIdentitySection } from "./FieldIdentitySection";

interface SectionInspectorBodyProps {
	readonly field: SectionField;
}

export function SectionInspectorBody({ field }: SectionInspectorBodyProps) {
	const setActiveFieldId = useSetActiveFieldId();
	const canEdit = useCanEdit();

	const handleFocus = useCallback(
		(e: React.FocusEvent) => {
			const fieldEl = (e.target as HTMLElement).closest("[data-field-id]");
			setActiveFieldId(fieldEl?.getAttribute("data-field-id") ?? undefined);
		},
		[setActiveFieldId],
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: delegated focusin for undo/redo field tracking
		<div
			onFocus={handleFocus}
			className="space-y-4"
			data-field-inspector={field.uuid}
		>
			{canEdit ? (
				<>
					<FieldIdentitySection field={field} />
					<PageSection sectionUuid={field.uuid} />
					<DeleteSectionRow sectionUuid={field.uuid} />
				</>
			) : (
				<>
					<div aria-disabled className="space-y-4 pointer-events-none">
						<FieldIdentitySection field={field} />
						<PageSection sectionUuid={field.uuid} />
					</div>
					<p className="flex items-center gap-1.5 border-t border-nova-border pt-3 text-[11px] text-nova-text-muted">
						<Icon
							icon={tablerLock}
							width="13"
							height="13"
							className="shrink-0"
						/>
						View only. Ask a Project admin for edit access.
					</p>
				</>
			)}
		</div>
	);
}

/** Where this page sits, and the two gestures that change the page set
 *  without losing a question. */
function PageSection({ sectionUuid }: { readonly sectionUuid: Uuid }) {
	/* Subscribe to the field maps: moving a page changes `fieldOrder`, not
	 * the section entity the rail selected, so the k-of-n line and the
	 * button states need their own reactive read. */
	const { fields, fieldOrder } = useFieldsAndOrder();
	const docApi = useBlueprintDocApi();
	const { applyFormSectionPlan } = useBlueprintMutations();
	const select = useSelect();
	const { setPending } = useScrollIntoView();
	const mergeReasonId = useId();

	const formUuid = docApi.getState().fieldParent[sectionUuid];
	const sections =
		formUuid === undefined
			? []
			: (fieldOrder[formUuid] ?? []).filter(
					(uuid) => fields[uuid]?.kind === "section",
				);
	const index = sections.indexOf(sectionUuid);
	const count = sections.length;
	const isFirst = index <= 0;

	const keepQuestionsDestination =
		count <= 1
			? "Its questions return to the form as one page."
			: isFirst
				? "Its questions join the next section."
				: "Its questions join the previous section.";

	const landOn = useCallback(
		(uuid: Uuid | undefined) => {
			if (uuid === undefined) return;
			setPending(uuid, "smooth", false);
			select(uuid);
		},
		[select, setPending],
	);

	const onMerge = useCallback(() => {
		const previous = sections[index - 1];
		const outcome = applyFormSectionPlan(
			mergeWithPrevious(docApi.getState(), sectionUuid),
		);
		if (outcome.ok) landOn(previous);
	}, [applyFormSectionPlan, docApi, sectionUuid, sections, index, landOn]);

	const onRemoveKeepingQuestions = useCallback(() => {
		const neighbour = isFirst ? sections[1] : sections[index - 1];
		const outcome = applyFormSectionPlan(
			removeSectionKeepingQuestions(docApi.getState(), sectionUuid),
		);
		if (outcome.ok) landOn(neighbour);
	}, [
		applyFormSectionPlan,
		docApi,
		sectionUuid,
		sections,
		index,
		isFirst,
		landOn,
	]);

	if (index < 0) return null;

	return (
		<InspectorSection label="Page">
			<p className="text-[13px] leading-5 text-nova-text-secondary">
				{sectionKicker(index, count)}. Move it with Move up and Move down in the
				menu above; edit its title on the canvas.
			</p>
			<div className="space-y-2">
				<Button
					type="button"
					variant="outline"
					className="w-full justify-start"
					disabled={isFirst}
					onClick={onMerge}
					aria-describedby={isFirst ? mergeReasonId : undefined}
				>
					<Icon icon={tablerArrowMergeBoth} width="16" height="16" />
					Merge with previous section
				</Button>
				{isFirst && (
					<p
						id={mergeReasonId}
						className="text-[13px] leading-5 text-nova-text-muted"
					>
						This is the first section, so there's nothing before it to merge
						with.
					</p>
				)}
				<Button
					type="button"
					variant="outline"
					className="w-full justify-start"
					onClick={onRemoveKeepingQuestions}
				>
					<Icon icon={tablerStackPop} width="16" height="16" />
					Remove section, keep its questions
				</Button>
				<p className="text-[13px] leading-5 text-nova-text-muted">
					{keepQuestionsDestination}
				</p>
			</div>
		</InspectorSection>
	);
}

/** The destructive last row: remove the page AND its questions, confirmed
 *  inline the way every rail removal is. */
function DeleteSectionRow({ sectionUuid }: { readonly sectionUuid: Uuid }) {
	const [confirming, setConfirming] = useState(false);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirming);
	const deleteSelected = useDeleteSelectedField();
	const docApi = useBlueprintDocApi();
	const questionCount = (docApi.getState().fieldOrder[sectionUuid] ?? [])
		.length;

	if (confirming) {
		return (
			<section
				ref={panelRef}
				aria-label="Confirm section removal"
				tabIndex={-1}
				className="space-y-3 rounded-xl border border-nova-rose/30 bg-nova-rose/[0.05] p-3 outline-none"
			>
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					Delete this section and{" "}
					{questionCount === 1
						? "the question"
						: `the ${questionCount} questions`}{" "}
					on it? To keep the questions, use Remove section, keep its questions
					instead. You can undo this.
				</p>
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="ghost"
						onClick={() => setConfirming(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						onClick={() => {
							setConfirming(false);
							deleteSelected();
						}}
					>
						Delete section
					</Button>
				</div>
			</section>
		);
	}

	return (
		<div className="border-t border-nova-border pt-4">
			<Button
				ref={triggerRef}
				type="button"
				variant="destructive"
				className="w-full"
				onClick={() => setConfirming(true)}
			>
				<Icon icon={tablerTrash} width="14" height="14" />
				<span>Delete section and its questions</span>
			</Button>
		</div>
	);
}
