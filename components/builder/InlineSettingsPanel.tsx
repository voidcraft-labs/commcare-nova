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
import type { Question } from "@/lib/schemas/blueprint";
import type { Builder } from "@/lib/services/builder";
import { ContextualEditorData } from "./contextual/ContextualEditorData";
import { ContextualEditorFooter } from "./contextual/ContextualEditorFooter";
import { ContextualEditorLogic } from "./contextual/ContextualEditorLogic";
import { ContextualEditorUI } from "./contextual/ContextualEditorUI";

interface InlineSettingsPanelProps {
	builder: Builder;
	question: Question;
}

/** Static section label with a left accent bar for visual grouping. */
function SectionLabel({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2 mb-2">
			<div className="w-0.5 h-3 rounded-full bg-nova-violet/40" />
			<span className="text-[10px] font-semibold uppercase tracking-widest text-nova-text-muted/70">
				{label}
			</span>
		</div>
	);
}

export function InlineSettingsPanel({
	builder,
	question,
}: InlineSettingsPanelProps) {
	/** Delegated focusin handler — tracks which [data-field-id] element has
	 *  focus so undo/redo snapshots capture the correct field even for
	 *  blur-triggered saves (where document.activeElement has already moved). */
	const handleFocus = useCallback(
		(e: React.FocusEvent) => {
			const fieldEl = (e.target as HTMLElement).closest("[data-field-id]");
			builder.setActiveField(
				fieldEl?.getAttribute("data-field-id") ?? undefined,
			);
		},
		[builder],
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: delegated focusin for undo/redo field tracking
		<div
			className="mt-2 rounded-lg border border-nova-violet/15 bg-nova-deep/90 shadow-[0_2px_12px_rgba(0,0,0,0.3)] overflow-hidden"
			data-no-drag
			onFocus={handleFocus}
		>
			<div className="p-2 space-y-2">
				{/* ── Data section ── */}
				<div className="rounded-md bg-nova-surface/40 border border-white/[0.04] px-3 py-2.5">
					<SectionLabel label="Data" />
					<ContextualEditorData question={question} builder={builder} />
				</div>

				{/* ── Logic section ── */}
				<div className="rounded-md bg-nova-surface/40 border border-white/[0.04] px-3 py-2.5">
					<SectionLabel label="Logic" />
					<ContextualEditorLogic question={question} builder={builder} />
				</div>

				{/* ── Appearance section — hidden questions have no visual properties ── */}
				{question.type !== "hidden" && (
					<div className="rounded-md bg-nova-surface/40 border border-white/[0.04] px-3 py-2.5">
						<SectionLabel label="Appearance" />
						<ContextualEditorUI question={question} builder={builder} />
					</div>
				)}
			</div>

			{/* ── Footer: move, duplicate, delete, type change ── */}
			<div className="border-t border-white/[0.06]">
				<ContextualEditorFooter question={question} builder={builder} />
			</div>
		</div>
	);
}
