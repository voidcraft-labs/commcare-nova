/**
 * Inline settings panel — the inspector drawer that hangs beneath the
 * selected row.
 *
 * Shares violet chrome with the selection ring so the row and its
 * drawer read as one two-pane card. For groups, the caller inset-mounts
 * the drawer inside the group's nesting rails (see `GroupOpenRow`); the
 * rail gutters on either side keep the drawer narrower than the column
 * so the children below — which own the full rail width — still read
 * as the group's body, while the drawer reads as a sub-element of the
 * header above.
 *
 * The panel is a sibling of EditableFieldWrapper (not inside it), so
 * it pushes subsequent fields down naturally and scrolls with the
 * field. Drag-drop still works — the panel is inside the row wrapper
 * and moves with the field during drag.
 *
 * Two visual variants:
 *
 *   - **`attached`** — flat top, rounded bottom, violet border on every
 *     edge. The drawer's top border sits directly below the selected
 *     row's flat-bottomed ring so the violet strokes stack and read as
 *     one continuous outline across the row/drawer boundary.
 *   - **`floating`** — rounded on every side. For parent rows that are
 *     themselves fully rounded (collapsed group headers), where a
 *     flat-top drawer would leave a geometric mismatch. The caller
 *     pairs this with a small `pt-2` gap above the drawer.
 */

"use client";
import { useCallback } from "react";
import type { Field } from "@/lib/domain";
import { useSetActiveFieldId } from "@/lib/session/hooks";
import { ContextualEditorData } from "./contextual/ContextualEditorData";
import { ContextualEditorHeader } from "./contextual/ContextualEditorHeader";
import { ContextualEditorLogic } from "./contextual/ContextualEditorLogic";
import { ContextualEditorUI } from "./contextual/ContextualEditorUI";

interface InlineSettingsPanelProps {
	/** Domain field entity — all sub-editors consume the same shape. */
	field: Field;
	/** Drawer geometry — chosen by the caller to match the parent row's
	 *  bottom edge. Defaults to the common case: flush-attached under a
	 *  flat-bottomed selected row. */
	variant?: "attached" | "floating";
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

export function InlineSettingsPanel({
	field,
	variant = "attached",
}: InlineSettingsPanelProps) {
	const setActiveFieldId = useSetActiveFieldId();

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

	/* Shape classes per variant. `attached` keeps a 1px violet border on
	 * every edge but flattens the top corners so the drawer's top edge
	 * butts against the selected row above; the violet stroke of the
	 * ring and the drawer's top border sit one on top of the other and
	 * read as one continuous outline. `floating` rounds every corner
	 * for parent rows that are themselves fully rounded. The drop
	 * shadow pushes the drawer slightly forward of the following
	 * children, reinforcing "this belongs to the row above, not the
	 * group interior below."
	 *
	 * `cursor-auto` on the drawer resets the inherited `cursor-pointer`
	 * from the field's `div[role=button]` so inputs/labels get their
	 * natural cursors. */
	const shape =
		variant === "attached"
			? "rounded-t-none rounded-b-lg border"
			: "rounded-lg border";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: delegated focusin for undo/redo field tracking
		<div
			className={`${shape} border-nova-violet/60 bg-nova-deep/90 overflow-hidden cursor-auto shadow-[0_10px_22px_-10px_rgba(8,4,20,0.75)]`}
			data-no-drag
			onFocus={handleFocus}
		>
			<ContextualEditorHeader field={field} />

			<div className="p-2 space-y-2">
				{/* Data and Appearance own their own visibility — return null
				    when the field kind has no applicable fields. */}
				<ContextualEditorData field={field} />

				<div className={SECTION_CARD_CLASS}>
					<SectionLabel label="Logic" />
					<ContextualEditorLogic field={field} />
				</div>

				<ContextualEditorUI field={field} />
			</div>
		</div>
	);
}
