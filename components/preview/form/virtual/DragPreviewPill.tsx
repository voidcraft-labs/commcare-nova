/**
 * DragPreviewPill — the small "chip" rendered as the custom drag preview
 * while a question or group is being dragged.
 *
 * Exists as a named component (rather than an inline JSX literal) so
 * every draggable row type uses the SAME visual, and so future tweaks
 * (icon, dimensions, color) happen in one place.
 *
 * The preview is portaled into a library-owned container that lives at
 * document.body, far outside the virtualizer's scroll container. It does
 * not participate in the row layout and never affects the source row's
 * size — that's the whole point of using `setCustomNativeDragPreview`.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerDrag from "@iconify-icons/tabler/grip-vertical";

interface DragPreviewPillProps {
	/** Short textual label to show next to the grip icon. Usually the
	 *  question/group label, or the semantic id as fallback. */
	readonly label: string;
}

export function DragPreviewPill({ label }: DragPreviewPillProps) {
	return (
		<div className="inline-flex items-center gap-1.5 rounded-lg border border-nova-violet/40 bg-nova-surface/95 px-3 py-1.5 text-sm text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerDrag}
				width="14"
				height="14"
				className="text-nova-text-muted"
			/>
			<span className="max-w-[240px] truncate">{label}</span>
		</div>
	);
}
