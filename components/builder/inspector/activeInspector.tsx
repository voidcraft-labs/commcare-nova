/**
 * The right rail renders the inspector directly from shared selection state —
 * there is no claim, no portal, and no owning surface that injects content.
 * These hooks resolve "what is selected for inspection right now" from the two
 * selection sources and hand the rail a ready-to-render descriptor:
 *
 *   - a selected form FIELD (URL state, `useSelectedField`), or
 *   - the case-list workspace's current selection (the shared controller's
 *     resolved `inspector`, `useCaseListWorkspace`).
 *
 * They are mutually exclusive: a field is only selected on a form screen, and
 * the case-list `inspector` is non-null only while its workspace is on-screen.
 * Because the rail is always mounted (it just parks off-screen during a preview
 * flip), whatever these return stays mounted across the flip — scroll survives
 * for free. The mode (edit vs preview) is deliberately NOT consulted: parking
 * hides the panel in preview, so gating mount on edit-mode would needlessly tear
 * it down.
 */
"use client";

import { type ReactNode, useCallback } from "react";
import { useCaseListWorkspace } from "@/components/builder/case-list-config/CaseListConfigWorkspace";
import { FieldInspectorBody } from "@/components/builder/editor/FieldInspectorBody";
import { PeerBadge } from "@/components/builder/PeerBadge";
import { fieldRegistry } from "@/lib/domain";
import { useSelect, useSelectedField } from "@/lib/routing/hooks";

export interface ActiveInspector {
	readonly kicker: string;
	readonly title: string;
	readonly body: ReactNode;
	readonly onClose: () => void;
}

/** The full inspector descriptor to render in the rail, or `null` for chat. */
export function useActiveInspector(): ActiveInspector | null {
	const field = useSelectedField();
	const select = useSelect();
	const ws = useCaseListWorkspace();

	if (field) {
		// Title = the field's prompt, falling back to its id (the `hidden` kind
		// carries no label). The header truncates, so a long markdown label shows
		// raw rather than rendered — short labels are the norm.
		const label = "label" in field ? field.label?.trim() : undefined;
		return {
			kicker: fieldRegistry[field.kind].label,
			title: label || field.id,
			body: (
				<>
					{/* A peer editing this same field surfaces its marker at the top of
					 *  the body (renders nothing while solo). */}
					<PeerBadge uuid={field.uuid} className="mb-1" />
					<FieldInspectorBody field={field} />
				</>
			),
			onClose: () => select(undefined),
		};
	}
	if (ws?.inspector) {
		return { ...ws.inspector, onClose: ws.onClose };
	}
	return null;
}

/**
 * Cheap presence + close for layout code (BuilderContentArea's rail width and
 * narrow-overlay logic) that must not pay to build the inspector body just to
 * ask "is anything docked?".
 */
export function useInspectorPresence(): {
	docked: boolean;
	requestClose: () => void;
} {
	const field = useSelectedField();
	const select = useSelect();
	const ws = useCaseListWorkspace();
	const caseListClose = ws?.onClose;
	const docked = field !== null || (ws?.inspector ?? null) !== null;
	const requestClose = useCallback(() => {
		if (field !== null) select(undefined);
		else caseListClose?.();
	}, [field, select, caseListClose]);
	return { docked, requestClose };
}
