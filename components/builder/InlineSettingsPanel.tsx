/**
 * Inline settings panel for inspect cursor mode.
 *
 * Renders below the selected question inside the form DOM. Uses the same
 * sub-editors (UI, Logic, Data, Footer) laid out as visually distinct
 * section cards at full form width. Sections are always expanded — the
 * user dismisses the entire panel by clicking off the question.
 *
 * The panel is a sibling of EditableQuestionWrapper (not inside it), so
 * it pushes subsequent questions down naturally and scrolls with the
 * question. Drag-drop still works — the panel is inside SortableQuestion
 * and moves with the question during drag.
 */

"use client";
import { useCallback } from "react";
import { useBuilderStore } from "@/hooks/useBuilder";
import type { Question } from "@/lib/schemas/blueprint";
import { ContextualEditorData } from "./contextual/ContextualEditorData";
import { ContextualEditorFooter } from "./contextual/ContextualEditorFooter";
import { ContextualEditorLogic } from "./contextual/ContextualEditorLogic";
import { ContextualEditorUI } from "./contextual/ContextualEditorUI";

interface InlineSettingsPanelProps {
	question: Question;
}

/** Static section label with a left accent bar for visual grouping. */
export function SectionLabel({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2 mb-2">
			<div className="w-0.5 h-3 rounded-full bg-nova-violet/40" />
			<span className="text-[10px] font-semibold uppercase tracking-widest text-nova-text-muted/70">
				{label}
			</span>
		</div>
	);
}

/** Shared styling for each section card inside the panel. */
export const SECTION_CARD_CLASS =
	"rounded-md bg-nova-surface/40 border border-white/[0.04] px-3 py-2.5";

export function InlineSettingsPanel({ question }: InlineSettingsPanelProps) {
	const setActiveFieldId = useBuilderStore((s) => s.setActiveFieldId);

	/** Delegated focusin handler — tracks which [data-field-id] element has
	 *  focus so zundo snapshots capture the correct field even for
	 *  blur-triggered saves (where document.activeElement has already moved). */
	const handleFocus = useCallback(
		(e: React.FocusEvent) => {
			const fieldEl = (e.target as HTMLElement).closest("[data-field-id]");
			setActiveFieldId(fieldEl?.getAttribute("data-field-id") ?? undefined);
		},
		[setActiveFieldId],
	);

	/* Flat top corners attach flush to the question's flat-bottomed outline.
	 * cursor-auto resets the inherited cursor-pointer from the question's
	 * div[role=button] so inputs/labels get their natural cursors. */
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: delegated focusin for undo/redo field tracking
		<div
			className="rounded-t-none rounded-b-lg border border-nova-violet/60 bg-nova-deep/90 overflow-hidden cursor-auto"
			data-no-drag
			onFocus={handleFocus}
		>
			<ContextualEditorFooter question={question} />

			<div className="p-2 space-y-2">
				{/* Data and Appearance own their own visibility — return null
				    when the question type has no applicable fields. */}
				<ContextualEditorData question={question} />

				<div className={SECTION_CARD_CLASS}>
					<SectionLabel label="Logic" />
					<ContextualEditorLogic question={question} />
				</div>

				<ContextualEditorUI question={question} />
			</div>
		</div>
	);
}
