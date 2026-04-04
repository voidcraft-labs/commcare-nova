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
import type { Builder } from "@/lib/services/builder";
import type { Question } from "@/lib/schemas/blueprint";
import { ContextualEditorUI } from "./contextual/ContextualEditorUI";
import { ContextualEditorLogic } from "./contextual/ContextualEditorLogic";
import { ContextualEditorData } from "./contextual/ContextualEditorData";
import { ContextualEditorFooter } from "./contextual/ContextualEditorFooter";

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
	/* Ref callback attaches a native click listener to block propagation to the
	 * parent (which would re-select the question). Native listener avoids JSX
	 * onClick, which triggers a11y lint rules on non-interactive elements. */
	const panelRef = useCallback((el: HTMLDivElement | null) => {
		if (!el) return;
		const stop = (e: Event) => e.stopPropagation();
		el.addEventListener("click", stop);
		return () => el.removeEventListener("click", stop);
	}, []);

	return (
		<div
			ref={panelRef}
			className="mt-2 rounded-lg border border-nova-border bg-nova-surface/50 overflow-hidden"
			data-no-drag
		>
			<div className="p-2 space-y-2">
				{/* ── Data section ── */}
				<div className="rounded-md bg-nova-deep/60 px-3 py-2.5">
					<SectionLabel label="Data" />
					<ContextualEditorData question={question} builder={builder} />
				</div>

				{/* ── Logic section ── */}
				<div className="rounded-md bg-nova-deep/60 px-3 py-2.5">
					<SectionLabel label="Logic" />
					<ContextualEditorLogic question={question} builder={builder} />
				</div>

				{/* ── Appearance section — hidden questions have no visual properties ── */}
				{question.type !== "hidden" && (
					<div className="rounded-md bg-nova-deep/60 px-3 py-2.5">
						<SectionLabel label="Appearance" />
						<ContextualEditorUI question={question} builder={builder} />
					</div>
				)}
			</div>

			{/* ── Footer: move, duplicate, delete, type change ── */}
			<div className="border-t border-nova-border">
				<ContextualEditorFooter question={question} builder={builder} />
			</div>
		</div>
	);
}
