/**
 * The right rail renders the inspector directly from shared selection state —
 * there is no claim, no portal, and no owning surface that injects content.
 * These hooks resolve "what is selected for inspection right now" from the two
 * selection sources and hand the rail a ready-to-render descriptor:
 *
 *   - a selected form FIELD (URL state, `useSelectedField`),
 *   - the case-list workspace's current selection (`useCaseListInspector` — the
 *     narrow, memoized slice of the shared controller carrying just the resolved
 *     `inspector` + its close handler, so these hooks don't re-render on every
 *     unrelated workspace change), or
 *   - the Project data workspace's selected row or column
 *     (`useProjectDataInspector`, the same narrow shape).
 *
 * They are mutually exclusive, and the URL is what makes them so: a field is
 * only selected on a form screen, the case-list `inspector` is non-null only
 * while its workspace is on-screen, and a Project data URL names no module and
 * no field at all.
 * Because the rail is always mounted (it just parks off-screen during a preview
 * flip), whatever these return stays mounted across the flip — scroll survives
 * for free. The mode (edit vs preview) is deliberately NOT consulted: parking
 * hides the panel in preview, so gating mount on edit-mode would needlessly tear
 * it down.
 */
"use client";

import { type ReactNode, useCallback } from "react";
import { useCaseListInspector } from "@/components/builder/case-list-config/CaseListConfigWorkspace";
import { FieldInspectorBody } from "@/components/builder/editor/FieldInspectorBody";
import { PeerBadge } from "@/components/builder/PeerBadge";
import { useProjectDataInspector } from "@/components/builder/project-data/projectDataInspector";
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
	const caseList = useCaseListInspector();
	const projectData = useProjectDataInspector();

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
	if (caseList?.inspector) {
		return { ...caseList.inspector, onClose: caseList.onClose };
	}
	if (projectData?.inspector) {
		return { ...projectData.inspector, onClose: projectData.onClose };
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
	const caseList = useCaseListInspector();
	const projectData = useProjectDataInspector();
	const caseListClose = caseList?.onClose;
	const projectDataClose = projectData?.onClose;
	const docked =
		field !== null ||
		(caseList?.inspector ?? null) !== null ||
		(projectData?.inspector ?? null) !== null;
	/* Only one source can be docked at a time (the URL guarantees it), so
	 * closing both non-field sources is a no-op on whichever is already
	 * closed rather than a branch that has to know which one is open. */
	const requestClose = useCallback(() => {
		if (field !== null) select(undefined);
		else {
			caseListClose?.();
			projectDataClose?.();
		}
	}, [field, select, caseListClose, projectDataClose]);
	return { docked, requestClose };
}
