/**
 * The right rail renders the inspector directly from shared selection state —
 * there is no claim, no portal, and no owning surface that injects content.
 * These hooks resolve "what is selected for inspection right now" from the two
 * selection sources and hand the rail a ready-to-render descriptor:
 *
 *   - a selected form FIELD (URL state, `useSelectedField`), or
 *   - the case-list workspace's current selection (`useCaseListInspector` — the
 *     narrow, memoized slice of the shared controller carrying just the resolved
 *     `inspector` + its close handler, so these hooks don't re-render on every
 *     unrelated workspace change).
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
import { useCaseListInspector } from "@/components/builder/case-list-config/CaseListConfigWorkspace";
import { CaseOperationInspectorBody } from "@/components/builder/case-operations/CaseOperationInspectorBody";
import { operationSentence } from "@/components/builder/case-operations/operationSentence";
import { useOperationSentenceContext } from "@/components/builder/case-operations/useOperationSentenceContext";
import { FieldInspectorBody } from "@/components/builder/editor/FieldInspectorBody";
import { PeerBadge } from "@/components/builder/PeerBadge";
import { useCaseOperation } from "@/lib/doc/hooks/useCaseOperationFacts";
import type { Uuid } from "@/lib/doc/types";
import { fieldRegistry } from "@/lib/domain";
import {
	useLocation,
	useNavigate,
	useSelect,
	useSelectedField,
} from "@/lib/routing/hooks";

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
	const operation = useSelectedCaseOperation();
	const navigate = useNavigate();

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
	if (operation !== null) {
		return {
			kicker: "Case change",
			title: operation.title,
			body: (
				<CaseOperationInspectorBody
					moduleUuid={operation.moduleUuid}
					formUuid={operation.formUuid}
					operationUuid={operation.operationUuid}
				/>
			),
			onClose: () =>
				navigate.openFormOperations(operation.moduleUuid, operation.formUuid),
		};
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
	const operation = useSelectedCaseOperation();
	const navigate = useNavigate();
	const caseListClose = caseList?.onClose;
	const docked =
		field !== null ||
		(caseList?.inspector ?? null) !== null ||
		operation !== null;
	const requestClose = useCallback(() => {
		if (field !== null) select(undefined);
		else if (operation !== null) {
			navigate.openFormOperations(operation.moduleUuid, operation.formUuid);
		} else caseListClose?.();
	}, [field, select, caseListClose, operation, navigate]);
	return { docked, requestClose };
}

/**
 * The third selection source: one case change, selected in the URL.
 *
 * Unlike the case workspace's row selection this lives in the path, so a
 * change is linkable and survives a preview flip for free — and unlike a
 * field it names an entity inside a form record rather than a top-level
 * one, which is why closing means dropping back to the list URL rather
 * than clearing a selection param.
 */
function useSelectedCaseOperation(): {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly operationUuid: Uuid;
	readonly title: string;
} | null {
	const loc = useLocation();
	const formUuid = loc.kind === "form-operations" ? loc.formUuid : undefined;
	const operationUuid =
		loc.kind === "form-operations" ? loc.operationUuid : undefined;
	const context = useOperationSentenceContext(formUuid ?? EMPTY_FORM_UUID);
	const operation = useCaseOperation(formUuid, operationUuid);
	if (
		loc.kind !== "form-operations" ||
		operationUuid === undefined ||
		formUuid === undefined ||
		operation === undefined
	) {
		return null;
	}
	return {
		moduleUuid: loc.moduleUuid,
		formUuid,
		operationUuid,
		title: operationSentence(operation, context).lead,
	};
}

/** A form uuid that resolves to nothing, for the hook-order-preserving
 *  call the sentence context makes while no change is selected. */
const EMPTY_FORM_UUID = "" as Uuid;
